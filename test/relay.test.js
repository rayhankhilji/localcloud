// Relay behaviour: error pages, routing modes, access control, reconnects,
// limits and the long-poll protocol edge cases.

import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import WebSocket from 'ws';
import { FatalError } from '../src/client/client.js';
import { HttpClientTransport, WsClientTransport } from '../src/client/transports.js';
import { T, decodeBatch, decodeFrame, encodeBatch, encodeFrame, parseJson } from '../src/protocol.js';
import { freePort, hostOf, localServer, newClient, req, sleep, startRelay, waitFor } from './helpers.js';

const HTML = { accept: 'text/html,application/xhtml+xml' };

/** Relay + echo-ish local server + connected client, torn down by the returned `stop`. */
async function fixture({ relayOpts, clientOpts, transport = 'ws' } = {}) {
  const r = await startRelay(relayOpts);
  const seen = [];
  const app = await localServer((rq, res) => {
    seen.push({ url: rq.url, headers: rq.headers });
    if (rq.url.startsWith('/go')) {
      res.writeHead(302, { location: `http://localhost:${app.port}/landed` });
      return res.end();
    }
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify({ url: rq.url, headers: rq.headers }));
  });
  const clients = [];
  const mk = (opts = {}) => {
    const c = newClient(r.url, { transport, ...clientOpts, ...opts });
    clients.push(c);
    return c;
  };
  return {
    ...r,
    app,
    seen,
    client: mk,
    stop: async () => {
      await Promise.all(clients.map((c) => c.close()));
      await app.stop();
      await r.relay.close();
    },
  };
}

describe('error pages', () => {
  test('502 waiting page when nothing listens (HTML vs plain text)', async () => {
    const f = await fixture();
    try {
      const port = await freePort();
      const t = await f.client().share(String(port));
      const host = hostOf(t.url);
      let r = await req(f.port, { host, headers: HTML });
      assert.equal(r.status, 502);
      assert.match(r.headers['content-type'], /text\/html/);
      assert.match(r.text(), new RegExp(`Nothing is answering on port ${port}`));
      assert.match(r.text(), /x-localcloud-probe/, 'the page polls until the server is up');

      r = await req(f.port, { host });
      assert.equal(r.status, 502);
      assert.match(r.headers['content-type'], /text\/plain/);
      assert.match(r.text(), new RegExp(`port ${port} did not respond \\(ECONNREFUSED\\)`));

      r = await req(f.port, { host, method: 'POST', headers: HTML, body: 'x' });
      assert.equal(r.status, 502);
      assert.match(r.headers['content-type'], /text\/plain/, 'only GETs get the HTML page');

      // Once the server starts, the same URL works.
      const late = await localServer((_rq, res) => res.end('finally'));
      try {
        const t2 = await f.client().share(String(late.port));
        assert.equal((await req(f.port, { host: hostOf(t2.url) })).text(), 'finally');
      } finally {
        await late.stop();
      }
    } finally {
      await f.stop();
    }
  });

  test('404 for unknown tunnels, landing page, health, robots', async () => {
    const f = await fixture();
    try {
      let r = await req(f.port, { host: 'nope-nope-1234.lc.test', headers: HTML });
      assert.equal(r.status, 404);
      assert.match(r.text(), /No tunnel at this address/);
      r = await req(f.port, { host: 'nope-nope-1234.lc.test' });
      assert.equal(r.status, 404);
      assert.match(r.headers['content-type'], /text\/plain/);

      r = await req(f.port, { host: '127.0.0.1' });
      assert.equal(r.status, 200);
      assert.match(r.text(), /localcloud/);
      r = await req(f.port, { host: 'lc.test', path: '/__localcloud/health' });
      const health = JSON.parse(r.text());
      assert.equal(health.ok, true);
      assert.equal(health.service, 'localcloud');
      assert.equal(health.routing, 'subdomain');
      assert.equal((await req(f.port, { path: '/robots.txt' })).text(), 'User-agent: *\nDisallow: /\n');
      assert.equal((await req(f.port, { path: '/__localcloud/nope' })).status, 404);
      // Upgrades to unknown tunnels are refused too.
      await assert.rejects(
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${f.port}/`, { headers: { host: 'nope-nope-1234.lc.test' } });
          ws.on('open', resolve);
          ws.on('error', reject);
        }),
        /404/,
      );
    } finally {
      await f.stop();
    }
  });

  test('malformed cookies and URLs never crash the relay', async () => {
    const f = await fixture({ relayOpts: { domain: undefined } });
    try {
      let r = await req(f.port, { path: '/', headers: { cookie: '__lc_t=%E0%A4%A; other=%%%' } });
      assert.ok([200, 302].includes(r.status));
      r = await req(f.port, { path: '/__localcloud/t/%E0%A4%A' });
      assert.ok(r.status >= 400 && r.status < 500, `status ${r.status}`);
      assert.equal((await req(f.port, { path: '/__localcloud/health' })).status, 200);
    } finally {
      await f.stop();
    }
  });
});

for (const transport of ['ws', 'http']) {
  describe(`reconnects over ${transport}`, () => {
    test('offline tunnel comes back with the same URL; requests wait for it', async () => {
      const f = await fixture({ transport });
      try {
        const client = f.client();
        const t = await client.share(String(f.app.port));
        const host = hostOf(t.url);
        assert.equal((await req(f.port, { host, path: '/before' })).status, 200);

        const statuses = [];
        client.on('status', (s) => statuses.push(s.state));
        // Kill the session from the relay side, as a network drop would.
        for (const s of f.relay.sessions) s.close();
        // This request is held by the relay until the client is back.
        const during = req(f.port, { host, path: '/during' });
        await waitFor(() => statuses.includes('connected'), { message: 'reconnect' });
        const r = await during;
        assert.equal(r.status, 200);
        assert.equal(JSON.parse(r.text()).url, '/during');

        await waitFor(() => client.status.tunnels[0].online, { message: 'tunnel online' });
        assert.equal(client.status.tunnels[0].url, t.url);
        assert.equal(client.status.tunnels[0].id, t.id);
        assert.equal((await req(f.port, { host, path: '/after' })).status, 200);
        assert.equal(f.relay.sessions.size, 1, 'the old session is gone');
      } finally {
        await f.stop();
      }
    });

    test('a GET in flight when the connection dies is retried on the new connection', async () => {
      const f = await fixture({ transport });
      let hits = 0;
      const slow = await localServer((_rq, res) => {
        hits++;
        setTimeout(() => res.end(`answer ${hits}`), 300);
      });
      try {
        const client = f.client();
        const t = await client.share(String(slow.port));
        const pending = req(f.port, { host: hostOf(t.url), path: '/slow' });
        await waitFor(() => hits === 1, { message: 'first attempt reaches the server' });
        for (const s of f.relay.sessions) s.close();
        const r = await pending;
        assert.equal(r.status, 200);
        assert.equal(r.text(), 'answer 2');
        // A POST with a body is never replayed.
        const post = req(f.port, { host: hostOf(t.url), method: 'POST', path: '/slow', body: 'data' });
        await waitFor(() => hits === 3, { message: 'post reaches the server' });
        for (const s of f.relay.sessions) s.close();
        assert.equal((await post).status, 502);
      } finally {
        await slow.stop();
        await f.stop();
      }
    });

    test('share() during a reconnect resolves once the connection is back', async () => {
      const f = await fixture({ transport });
      const other = await localServer((_rq, res) => res.end('other'));
      try {
        const client = f.client();
        await client.share(String(f.app.port));
        for (const s of f.relay.sessions) s.close();
        await waitFor(() => !client.connected, { message: 'disconnect' });
        const t2 = await client.share(String(other.port));
        assert.equal((await req(f.port, { host: hostOf(t2.url) })).text(), 'other');
        assert.equal(client.status.tunnels.length, 2);
      } finally {
        await other.stop();
        await f.stop();
      }
    });

    test('client-side transport loss reconnects too', async () => {
      const f = await fixture({ transport });
      try {
        const client = f.client();
        const t = await client.share(String(f.app.port));
        if (transport === 'ws') client.transport.ws.terminate();
        else client.transport.close();
        await waitFor(() => !client.connected, { message: 'disconnect' });
        await waitFor(() => client.connected && client.status.tunnels[0].online, { message: 'reconnect' });
        assert.equal(client.status.tunnels[0].url, t.url);
        assert.equal((await req(f.port, { host: hostOf(t.url) })).status, 200);
      } finally {
        await f.stop();
      }
    });
  });
}

describe('offline tunnels', () => {
  test('503 reconnecting page when the client stays away', async () => {
    const f = await fixture({ relayOpts: { reconnectGraceMs: 200 } });
    try {
      const client = f.client();
      const t = await client.share(String(f.app.port));
      const host = hostOf(t.url);
      // Vanish without saying goodbye (no CLOSE_TUNNEL) and don't come back.
      client.closed = true;
      client.transport.ws.terminate();
      await waitFor(() => f.relay.sessions.size === 0, { message: 'relay notices' });

      let r = await req(f.port, { host, headers: HTML });
      assert.equal(r.status, 503);
      assert.match(r.text(), /reconnecting/);
      r = await req(f.port, { host });
      assert.equal(r.status, 503);
      assert.match(r.headers['content-type'], /text\/plain/);
      const started = Date.now();
      r = await req(f.port, { host, headers: { 'x-localcloud-probe': '1' } });
      assert.equal(r.status, 503);
      assert.ok(Date.now() - started < 150, 'probes do not wait');
      assert.ok(f.relay.tunnels.has(t.id), 'the name stays reserved');
    } finally {
      await f.stop();
    }
  });

  test('unshare and close remove tunnels from the relay', async () => {
    const f = await fixture();
    try {
      const client = f.client();
      const a = await client.share(String(f.app.port));
      assert.equal(client.unshare(String(f.app.port)), true);
      assert.equal(client.unshare(String(f.app.port)), false);
      await waitFor(() => !f.relay.tunnels.has(a.id), { message: 'tunnel removed' });
      assert.equal((await req(f.port, { host: hostOf(a.url) })).status, 404);

      const b = await client.share(String(f.app.port));
      assert.notEqual(b.id, a.id);
      await client.close();
      await waitFor(() => !f.relay.tunnels.has(b.id) && f.relay.sessions.size === 0, { message: 'cleanup on close' });
      await assert.rejects(client.share(String(f.app.port)), /closed/);
    } finally {
      await f.stop();
    }
  });
});

describe('names', () => {
  test('reservation, name_taken, reclaim with the same secret', async () => {
    const f = await fixture();
    try {
      const a = f.client();
      const t = await a.share(String(f.app.port), { name: 'My App' });
      assert.equal(t.id, 'my-app');
      assert.equal(t.url, 'http://my-app.lc.test');
      assert.equal((await req(f.port, { host: 'my-app.lc.test', path: '/x' })).status, 200);

      const b = f.client();
      await assert.rejects(b.share(String(f.app.port), { name: 'my-app' }), (err) => err.code === 'name_taken');
      assert.equal(b.status.tunnels.length, 0, 'failed shares are forgotten');

      // While A is offline the name stays reserved for A.
      a.closed = true;
      a.transport.ws.terminate();
      await waitFor(() => f.relay.sessions.size === 1, { message: 'relay notices' });
      await assert.rejects(b.share(String(f.app.port), { name: 'my-app' }), (err) => err.code === 'name_taken');

      // The same secret (e.g. a restarted client) gets it back.
      const a2 = f.client({ secret: a.secret });
      const again = await a2.share(String(f.app.port), { name: 'my-app' });
      assert.equal(again.url, t.url);

      await assert.rejects(b.share(String(f.app.port), { name: 'www' }), /can't be used/);
    } finally {
      await f.stop();
    }
  });

  test('renaming a share releases the old name', async () => {
    const f = await fixture();
    try {
      const c = f.client();
      await c.share(String(f.app.port), { name: 'first-name' });
      const t = await c.share(String(f.app.port), { name: 'second-name' });
      assert.equal(t.id, 'second-name');
      await waitFor(() => !f.relay.tunnels.has('first-name'), { message: 'old name released' });
      assert.equal(c.status.tunnels.length, 1);
    } finally {
      await f.stop();
    }
  });
});

describe('access control', () => {
  test('protect: access link sets a cookie, everything else is 401', async () => {
    const f = await fixture();
    try {
      const t = await f.client().share(String(f.app.port), { protect: true });
      assert.ok(t.protect);
      const access = new URL(t.accessUrl);
      const token = access.searchParams.get('__lc_access');
      assert.ok(token && token.length >= 20);
      const host = hostOf(t.url);

      let r = await req(f.port, { host, path: '/', headers: HTML });
      assert.equal(r.status, 401);
      assert.match(r.text(), /private/);
      assert.equal((await req(f.port, { host, path: '/?__lc_access=wrong' })).status, 401);

      r = await req(f.port, { host, path: `/deep/link?x=1&__lc_access=${token}` });
      assert.equal(r.status, 302);
      assert.equal(r.headers.location, '/deep/link?x=1');
      const cookie = r.headers['set-cookie'][0].split(';')[0];
      assert.match(cookie, new RegExp(`^__lc_a_${t.id.replace(/-/g, '_')}=`));
      assert.match(r.headers['set-cookie'][0], /HttpOnly/);

      r = await req(f.port, { host, path: '/deep/link?x=1', headers: { cookie: `${cookie}; app=1` } });
      assert.equal(r.status, 200);
      const seen = JSON.parse(r.text());
      assert.equal(seen.headers.cookie, 'app=1', 'the access cookie is not forwarded');

      // WebSockets need the cookie as well.
      const tryWs = (headers) =>
        new Promise((resolve, reject) => {
          const ws = new WebSocket(`ws://127.0.0.1:${f.port}/`, { headers: { host, ...headers } });
          ws.on('open', () => resolve(ws));
          ws.on('error', reject);
        });
      await assert.rejects(tryWs({}), /401/);
    } finally {
      await f.stop();
    }
  });

  test('basic auth', async () => {
    const f = await fixture();
    try {
      const t = await f.client().share(String(f.app.port), { basicAuth: 'alice:s3cret' });
      const host = hostOf(t.url);
      let r = await req(f.port, { host });
      assert.equal(r.status, 401);
      assert.match(r.headers['www-authenticate'], /^Basic /);
      const bad = 'Basic ' + Buffer.from('alice:nope').toString('base64');
      assert.equal((await req(f.port, { host, headers: { authorization: bad } })).status, 401);
      const good = 'Basic ' + Buffer.from('alice:s3cret').toString('base64');
      r = await req(f.port, { host, headers: { authorization: good } });
      assert.equal(r.status, 200);
      assert.equal(JSON.parse(r.text()).headers.authorization, undefined, 'credentials are not forwarded');
    } finally {
      await f.stop();
    }
  });
});

describe('cookie routing (relay without a domain)', () => {
  test('/__localcloud/t/<id> sets the routing cookie, then requests route to the tunnel', async () => {
    const f = await fixture({ relayOpts: { domain: undefined } });
    try {
      assert.equal(f.relay.routing, 'cookie');
      const t = await f.client().share(String(f.app.port));
      const entry = new URL(t.url);
      assert.equal(entry.pathname, `/__localcloud/t/${t.id}`);
      assert.equal(entry.host, `127.0.0.1:${f.port}`);

      let r = await req(f.port, { path: entry.pathname });
      assert.equal(r.status, 302);
      assert.equal(r.headers.location, '/');
      const cookie = r.headers['set-cookie'][0].split(';')[0];
      assert.equal(cookie, `__lc_t=${t.id}`);

      r = await req(f.port, { path: '/hello', headers: { cookie } });
      assert.equal(JSON.parse(r.text()).url, '/hello');
      assert.equal(JSON.parse(r.text()).headers.cookie, undefined);

      // Redirects come back on the relay's origin.
      r = await req(f.port, { path: '/go', headers: { cookie } });
      assert.equal(r.headers.location, `http://127.0.0.1:${f.port}/landed`);

      // No cookie: the relay itself. API paths are never routed.
      assert.match((await req(f.port, { path: '/' })).text(), /localcloud/);
      assert.equal((await req(f.port, { path: '/__localcloud/health', headers: { cookie } })).status, 200);

      // Stale cookie → cleared.
      r = await req(f.port, { path: '/', headers: { cookie: '__lc_t=gone-gone-1234' } });
      assert.equal(r.status, 302);
      assert.match(r.headers['set-cookie'][0], /Max-Age=0/);
      r = await req(f.port, { path: '/__localcloud/exit', headers: { cookie } });
      assert.match(String(r.headers['set-cookie']), /Max-Age=0/);
      assert.equal((await req(f.port, { path: '/__localcloud/t/gone-gone-1234' })).status, 404);
    } finally {
      await f.stop();
    }
  });

  test('protected tunnel in cookie mode', async () => {
    const f = await fixture({ relayOpts: { domain: undefined } });
    try {
      const t = await f.client().share(String(f.app.port), { protect: true });
      const u = new URL(t.accessUrl);
      let r = await req(f.port, { path: u.pathname + u.search });
      assert.equal(r.status, 302);
      const cookies = r.headers['set-cookie'].map((c) => c.split(';')[0]).join('; ');
      assert.match(cookies, /__lc_t=/);
      assert.match(cookies, /__lc_a_/);
      r = await req(f.port, { path: '/', headers: { cookie: cookies } });
      assert.equal(r.status, 200);
      r = await req(f.port, { path: '/', headers: { cookie: `__lc_t=${t.id}` } });
      assert.equal(r.status, 401);
    } finally {
      await f.stop();
    }
  });
});

describe('relay token', () => {
  for (const transport of ['ws', 'http']) {
    test(`bad token is a FatalError over ${transport}`, async () => {
      const f = await fixture({ relayOpts: { token: 'sekrit-token' }, transport });
      try {
        const bad = f.client({ token: 'wrong' });
        const started = Date.now();
        await assert.rejects(bad.share(String(f.app.port)), (err) => {
          assert.ok(err instanceof FatalError, `got ${err?.constructor?.name}: ${err?.message}`);
          assert.match(err.message, /LOCALCLOUD_TOKEN/);
          return true;
        });
        assert.ok(Date.now() - started < 5000, 'fails fast instead of retrying');
        await assert.rejects(bad.share(String(f.app.port)), FatalError);
        await assert.rejects(f.client().start(), FatalError);
        assert.ok(f.logs.some((l) => /rejected client/.test(l)));

        const good = f.client({ token: 'sekrit-token' });
        const t = await good.share(String(f.app.port));
        assert.equal((await req(f.port, { host: hostOf(t.url) })).status, 200);
      } finally {
        await f.stop();
      }
    });
  }
});

describe('limits', () => {
  test('request headers are capped', async () => {
    const f = await fixture({ relayOpts: { maxHeaderSize: 4096 } });
    try {
      const t = await f.client().share(String(f.app.port));
      const host = hostOf(t.url);
      assert.equal((await req(f.port, { host, headers: { 'x-small': 'a'.repeat(1000) } })).status, 200);
      const r = await req(f.port, { host, headers: { 'x-big': 'a'.repeat(8000) } });
      assert.equal(r.status, 431);
    } finally {
      await f.stop();
    }
  });

  test('concurrent client connections per IP', async () => {
    const f = await fixture({ relayOpts: { maxSessionsPerIp: 2 } });
    const open = [];
    try {
      open.push(await WsClientTransport.connect(f.url, { proxy: null }));
      open.push(await HttpClientTransport.connect(f.url, { proxy: null }));
      await waitFor(() => f.relay.sessions.size === 2, { message: 'sessions' });
      await assert.rejects(WsClientTransport.connect(f.url, { proxy: null }), /429/);
      await assert.rejects(HttpClientTransport.connect(f.url, { proxy: null }), /429/);
      open.shift().close();
      await waitFor(() => f.relay.sessions.size === 1, { message: 'slot freed' });
      open.push(await HttpClientTransport.connect(f.url, { proxy: null }));
      open.at(-1).close();
      await waitFor(() => f.relay.sessions.size === 1 && f.relay.polls.size === 1, { message: 'http close frees the slot' });
    } finally {
      for (const t of open) t.close();
      await f.stop();
    }
  });

  test('total tunnels', async () => {
    const f = await fixture({ relayOpts: { maxTunnels: 1 } });
    const other = await localServer((_rq, res) => res.end());
    try {
      const c = f.client();
      await c.share(String(f.app.port));
      await assert.rejects(c.share(String(other.port)), /capacity/);
      // Re-opening an existing tunnel still works when the relay is full.
      await c.share(String(f.app.port), { protect: true });
    } finally {
      await other.stop();
      await f.stop();
    }
  });
});

describe('long-poll protocol', () => {
  const api = (port, path, body) => req(port, { method: 'POST', path: `/__localcloud/http/${path}`, headers: { 'content-length': body ? body.length : 0 }, body });
  const frames = (r) => decodeBatch(r.body).map(decodeFrame);

  test('resends lost batches, supersedes stale polls, dedupes ups', async () => {
    const { relay, port } = await startRelay();
    try {
      const sid = JSON.parse((await api(port, 'session')).text()).sid;
      const hello = encodeBatch([encodeFrame(T.HELLO, 0, { v: 1 })]);
      assert.equal((await api(port, `up?sid=${sid}&seq=1`, hello)).status, 204);

      let r = await api(port, `down?sid=${sid}&ack=0`);
      assert.equal(r.headers['x-lc-seq'], '1');
      let fs = frames(r);
      assert.equal(fs[0].type, T.WELCOME);
      assert.equal(parseJson(fs[0].payload).ok, true);

      // We "lost" that response: polling with the old ack gets the same batch again.
      r = await api(port, `down?sid=${sid}&ack=0`);
      assert.equal(r.headers['x-lc-seq'], '1');
      assert.equal(frames(r)[0].type, T.WELCOME);

      // A retried (duplicate) up is acknowledged but not re-processed.
      const ping = encodeBatch([encodeFrame(T.PING)]);
      assert.equal((await api(port, `up?sid=${sid}&seq=2`, ping)).status, 204);
      assert.equal((await api(port, `up?sid=${sid}&seq=2`, ping)).status, 204);
      assert.equal((await api(port, `up?sid=${sid}&seq=9`, ping)).status, 409, 'gaps are refused');

      r = await api(port, `down?sid=${sid}&ack=1`);
      assert.equal(r.headers['x-lc-seq'], '2');
      fs = frames(r);
      assert.deepEqual(
        fs.map((f) => f.type),
        [T.PONG],
      );

      // Nothing queued: the poll is held; a newer poll supersedes it with an empty answer.
      const held = api(port, `down?sid=${sid}&ack=2`);
      await sleep(100);
      const newer = api(port, `down?sid=${sid}&ack=2`);
      r = await held;
      assert.equal(r.status, 200);
      assert.equal(r.headers['x-lc-seq'], '0');
      assert.equal(r.body.length, 0);
      await api(port, `up?sid=${sid}&seq=3`, ping);
      r = await newer;
      assert.equal(r.headers['x-lc-seq'], '3');
      assert.deepEqual(
        frames(r).map((f) => f.type),
        [T.PONG],
      );

      assert.equal((await api(port, `down?sid=nope&ack=0`)).status, 410);
      assert.equal((await api(port, `up?sid=${sid}&seq=4`, Buffer.from([0, 0, 0, 9, 1]))).status, 400);
      assert.equal((await api(port, `close?sid=${sid}`)).status, 204);
      assert.equal((await api(port, `down?sid=${sid}&ack=3`)).status, 410);
      assert.equal(relay.polls.size, 0);
      assert.equal(relay.sessions.size, 0);
    } finally {
      await relay.close();
    }
  });

  test('a session that never says HELLO is refused frames', async () => {
    const { relay, port } = await startRelay();
    try {
      const sid = JSON.parse((await api(port, 'session')).text()).sid;
      await api(port, `up?sid=${sid}&seq=1`, encodeBatch([encodeFrame(T.OPEN, 0, { reqId: 1, secret: 'x'.repeat(20) })]));
      await waitFor(() => relay.sessions.size === 0, { message: 'session closed' });
    } finally {
      await relay.close();
    }
  });
});

describe('relay restarts and proxies', () => {
  test('a restarted relay gives the client its auto name back and reports a new access URL', async () => {
    const first = await startRelay();
    const port = first.port;
    const app = await localServer((_rq, res) => res.end('back'));
    const client = newClient(first.url);
    let second;
    try {
      const t = await client.share(String(app.port), { protect: true });
      assert.match(t.id, /^[a-z]+-[a-z]+-[a-z0-9]{5}$/);
      const changes = [];
      client.on('tunnel', (d, { changed }) => changes.push({ d, changed }));
      await first.relay.close();
      const { Relay } = await import('../src/relay/server.js');
      second = new Relay({ domain: 'lc.test', insecure: true });
      await second.listen({ port, host: '127.0.0.1' });
      await waitFor(() => changes.length > 0, { message: 'tunnel re-opened', timeout: 15_000 });
      assert.equal(changes[0].d.url, t.url, 'same auto-generated name');
      assert.notEqual(changes[0].d.accessUrl, t.accessUrl);
      assert.equal(changes[0].changed, true, 'the new access URL is reported as a change');
    } finally {
      await client.close();
      await app.stop();
      await second?.close();
    }
  });

  test('trustProxy decides whether X-Forwarded-For is believed', async () => {
    for (const trustProxy of [true, false]) {
      const f = await fixture({ relayOpts: { trustProxy } });
      try {
        const t = await f.client().share(String(f.app.port));
        const r = await req(f.port, { host: hostOf(t.url), headers: { 'x-forwarded-for': '198.51.100.7' } });
        assert.equal(JSON.parse(r.text()).headers['x-forwarded-for'], trustProxy ? '198.51.100.7' : '127.0.0.1');
      } finally {
        await f.stop();
      }
    }
  });
});

describe('relay shutdown', () => {
  test('close() finishes promptly with live clients and browser websockets', async () => {
    const f = await fixture();
    const { WebSocketServer } = await import('ws');
    const wss = new WebSocketServer({ server: f.app });
    wss.on('connection', (ws) => ws.on('message', (d) => ws.send(d)));
    const t = await f.client().share(String(f.app.port));
    const ws = new WebSocket(`ws://127.0.0.1:${f.port}/`, { headers: { host: hostOf(t.url) } });
    await new Promise((r) => ws.once('open', r));
    const httpClient = newClient(f.url, { transport: 'http' });
    await httpClient.share(String(f.app.port));
    const started = Date.now();
    await f.relay.close();
    assert.ok(Date.now() - started < 3000, `took ${Date.now() - started}ms`);
    await httpClient.close();
    ws.terminate();
    wss.close();
    await f.stop().catch(() => {});
  });
});
