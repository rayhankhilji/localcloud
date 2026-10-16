// End-to-end: browser → relay → client → local server, over both transports.

import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { after, before, describe, test } from 'node:test';
import WebSocket, { WebSocketServer } from 'ws';
import { DOMAIN, collect, hostOf, localServer, newClient, req, sha256, sleep, startRelay } from './helpers.js';

const BIG = crypto.randomBytes(5 * 1024 * 1024 + 123);
const BIG_SHA = sha256(BIG);

async function appServer() {
  const server = await localServer(async (rq, res) => {
    const url = new URL(rq.url, 'http://x');
    switch (url.pathname) {
      case '/hello':
        res.setHeader('content-type', 'text/plain');
        return res.end('hello from local');
      case '/headers':
        await collect(rq);
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ headers: rq.headers, method: rq.method, url: rq.url }));
      case '/big':
        res.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': BIG.length });
        return res.end(BIG);
      case '/big-chunked': {
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        for (let off = 0; off < BIG.length; off += 100_000) {
          if (!res.write(BIG.subarray(off, off + 100_000))) await new Promise((r) => res.once('drain', r));
        }
        return res.end();
      }
      case '/hash': {
        const body = await collect(rq);
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ sha: sha256(body), len: body.length, te: rq.headers['transfer-encoding'] || null, cl: rq.headers['content-length'] || null }));
      }
      case '/echo':
        res.writeHead(200, { 'content-type': 'application/octet-stream' });
        return rq.pipe(res);
      case '/sse': {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        for (let i = 0; i < 4; i++) {
          res.write(`data: tick ${i}\n\n`);
          await sleep(250);
        }
        return res.end();
      }
      case '/redirect':
        res.writeHead(302, {
          location: `http://localhost:${server.port}/target?a=1`,
          'set-cookie': ['sid=abc; Domain=localhost; Path=/; HttpOnly', 'theme=dark; Path=/'],
          'access-control-allow-origin': `http://localhost:${server.port}`,
        });
        return res.end();
      case '/status/204':
        res.writeHead(204);
        return res.end();
      case '/early': // answers before reading the (large) body
        res.writeHead(413, { 'content-type': 'text/plain', connection: 'close' });
        return res.end('too big');
      default:
        res.writeHead(404);
        return res.end('nope');
    }
  });
  const wss = new WebSocketServer({ server });
  wss.on('connection', (ws, rq) => {
    ws.send(JSON.stringify({ hello: true, host: rq.headers.host, origin: rq.headers.origin || null }));
    ws.on('message', (data, isBinary) => ws.send(data, { binary: isBinary }));
  });
  server.wss = wss;
  return server;
}

function openBrowserWs(relayPort, host, path = '/socket') {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}${path}`, { headers: { host }, origin: `http://${host}` });
    const first = new Promise((r) => ws.once('message', (d) => r(JSON.parse(d.toString()))));
    ws.once('open', () => resolve({ ws, first }));
    ws.once('error', reject);
    ws.once('unexpected-response', (_rq, res) => reject(new Error(`unexpected ${res.statusCode}`)));
  });
}

const nextMessage = (ws) => new Promise((r) => ws.once('message', (d, isBinary) => r({ data: Buffer.from(d), isBinary })));

for (const transport of ['ws', 'http']) {
  describe(`tunnel over ${transport}`, () => {
    let relay, app, client, tunnel, host;

    before(async () => {
      relay = await startRelay();
      app = await appServer();
      client = newClient(relay.url, { transport });
      tunnel = await client.share(String(app.port));
      host = hostOf(tunnel.url);
      assert.equal(client.transport.kind, transport);
    });

    after(async () => {
      await client.close();
      app.wss.close();
      await app.stop();
      await relay.relay.close();
    });

    test('share() returns a stable public URL', async () => {
      assert.match(tunnel.url, new RegExp(`^http://[a-z0-9-]+\\.${DOMAIN.replace('.', '\\.')}$`));
      assert.equal(tunnel.online, true);
      assert.equal(tunnel.port, app.port);
      const again = await client.share(String(app.port));
      assert.equal(again.url, tunnel.url);
      assert.equal(client.status.tunnels.length, 1);
    });

    test('GET', async () => {
      const r = await req(relay.port, { host, path: '/hello' });
      assert.equal(r.status, 200);
      assert.equal(r.text(), 'hello from local');
      assert.equal(r.headers['content-type'], 'text/plain');
    });

    test('404 and 204 from the local server pass through', async () => {
      assert.equal((await req(relay.port, { host, path: '/missing' })).status, 404);
      const r = await req(relay.port, { host, path: '/status/204' });
      assert.equal(r.status, 204);
      assert.equal(r.body.length, 0);
    });

    test('HEAD', async () => {
      const r = await req(relay.port, { host, path: '/big', method: 'HEAD' });
      assert.equal(r.status, 200);
      assert.equal(Number(r.headers['content-length']), BIG.length);
      assert.equal(r.body.length, 0);
    });

    test('large download (content-length)', async () => {
      const r = await req(relay.port, { host, path: '/big' });
      assert.equal(r.status, 200);
      assert.equal(r.body.length, BIG.length);
      assert.equal(sha256(r.body), BIG_SHA);
    });

    test('large download (chunked)', async () => {
      const r = await req(relay.port, { host, path: '/big-chunked' });
      assert.equal(r.body.length, BIG.length);
      assert.equal(sha256(r.body), BIG_SHA);
    });

    test('large upload (content-length)', async () => {
      const r = await req(relay.port, { host, path: '/hash', method: 'POST', headers: { 'content-length': BIG.length }, body: BIG });
      const j = JSON.parse(r.text());
      assert.equal(j.len, BIG.length);
      assert.equal(j.sha, BIG_SHA);
      assert.equal(j.cl, String(BIG.length));
    });

    test('chunked request body', async () => {
      const parts = [];
      const r = await req(relay.port, {
        host,
        path: '/hash',
        method: 'POST',
        headers: { 'transfer-encoding': 'chunked' },
        body: async (rq) => {
          for (let i = 0; i < 5; i++) {
            const p = crypto.randomBytes(30_000 + i);
            parts.push(p);
            rq.write(p);
            await sleep(20);
          }
          rq.end();
        },
      });
      const j = JSON.parse(r.text());
      const all = Buffer.concat(parts);
      assert.equal(j.len, all.length);
      assert.equal(j.sha, sha256(all));
      assert.equal(j.te, 'chunked');
    });

    test('chunked body on a DELETE keeps its framing', async () => {
      const body = Buffer.from('delete me please');
      const r = await req(relay.port, {
        host,
        path: '/hash',
        method: 'DELETE',
        headers: { 'transfer-encoding': 'chunked' },
        body: (rq) => {
          rq.write(body);
          rq.end();
        },
      });
      const j = JSON.parse(r.text());
      assert.equal(j.len, body.length);
      assert.equal(j.sha, sha256(body));
    });

    test('POST without a body', async () => {
      const r = await req(relay.port, { host, path: '/hash', method: 'POST' });
      assert.equal(JSON.parse(r.text()).len, 0);
    });

    test('full-duplex echo of a large body', async () => {
      const r = await req(relay.port, { host, path: '/echo', method: 'POST', headers: { 'content-length': BIG.length }, body: BIG });
      assert.equal(r.body.length, BIG.length);
      assert.equal(sha256(r.body), BIG_SHA);
    });

    test('server answering before reading the body does not wedge the tunnel', async () => {
      const r = await req(relay.port, { host, path: '/early', method: 'POST', headers: { 'content-length': BIG.length }, body: BIG }).catch((e) => ({ error: e }));
      // Depending on timing the early 413 wins or the local socket resets first (502) —
      // either way the tunnel must stay healthy.
      if (!r.error) assert.ok([413, 502].includes(r.status), `status ${r.status}`);
      const ok = await req(relay.port, { host, path: '/hello' });
      assert.equal(ok.text(), 'hello from local');
    });

    test('concurrent requests', async () => {
      const results = await Promise.all(Array.from({ length: 30 }, (_, i) => req(relay.port, { host, path: `/headers?i=${i}` })));
      results.forEach((r, i) => assert.equal(JSON.parse(r.text()).url, `/headers?i=${i}`));
    });

    test('streaming (SSE) arrives incrementally', async () => {
      const arrivals = [];
      const started = Date.now();
      await new Promise((resolve, reject) => {
        http
          .get({ host: '127.0.0.1', port: relay.port, path: '/sse', headers: { host, accept: 'text/event-stream' }, agent: false }, (res) => {
            assert.equal(res.headers['content-type'], 'text/event-stream');
            res.on('data', (c) => arrivals.push({ t: Date.now() - started, text: c.toString() }));
            res.on('end', resolve);
          })
          .on('error', reject);
      });
      const text = arrivals.map((a) => a.text).join('');
      assert.equal(text, [0, 1, 2, 3].map((i) => `data: tick ${i}\n\n`).join(''));
      const firstTick = arrivals.find((a) => a.text.includes('tick 0'));
      const lastTick = arrivals.find((a) => a.text.includes('tick 3'));
      assert.ok(lastTick.t - firstTick.t >= 500, `events were buffered: ${JSON.stringify(arrivals)}`);
    });

    test('Host/Origin/Referer are rewritten to localhost', async () => {
      const r = await req(relay.port, {
        host,
        path: '/headers',
        headers: { origin: `http://${host}`, referer: `http://${host}/some/page`, 'x-forwarded-for': '6.6.6.6', cookie: 'app=1; __lc_t=zzz' },
      });
      const { headers } = JSON.parse(r.text());
      assert.equal(headers.host, `localhost:${app.port}`);
      assert.equal(headers.origin, `http://localhost:${app.port}`);
      assert.equal(headers.referer, `http://localhost:${app.port}/some/page`);
      assert.equal(headers['x-forwarded-proto'], 'http');
      assert.equal(headers['x-localcloud-url'], `http://${host}`);
      assert.equal(headers.cookie, 'app=1', 'relay cookies are stripped');
      assert.equal(headers['x-forwarded-host'], undefined);
    });

    test('Location, CORS and Set-Cookie domain are rewritten', async () => {
      const r = await req(relay.port, { host, path: '/redirect' });
      assert.equal(r.status, 302);
      assert.equal(r.headers.location, `http://${host}/target?a=1`);
      assert.equal(r.headers['access-control-allow-origin'], `http://${host}`);
      assert.deepEqual(r.headers['set-cookie'], ['sid=abc; Path=/; HttpOnly', 'theme=dark; Path=/']);
    });

    test('WebSocket upgrade echo (text, binary, large)', async () => {
      const { ws, first } = await openBrowserWs(relay.port, host);
      const hello = await first;
      assert.equal(hello.hello, true);
      assert.equal(hello.host, `localhost:${app.port}`);
      assert.equal(hello.origin, `http://localhost:${app.port}`);

      ws.send('ping text');
      let m = await nextMessage(ws);
      assert.equal(m.data.toString(), 'ping text');
      assert.equal(m.isBinary, false);

      const bin = crypto.randomBytes(3 * 1024 * 1024);
      ws.send(bin);
      m = await nextMessage(ws);
      assert.equal(m.isBinary, true);
      assert.equal(sha256(m.data), sha256(bin));

      const closed = new Promise((r) => ws.once('close', (code) => r(code)));
      ws.close(4001, 'bye');
      assert.equal(await closed, 4001);
    });

    test('many WebSocket messages in a burst keep their order', async () => {
      const { ws, first } = await openBrowserWs(relay.port, host);
      await first;
      const got = [];
      const done = new Promise((r) =>
        ws.on('message', (d) => {
          got.push(Number(d.toString()));
          if (got.length === 500) r();
        }),
      );
      for (let i = 0; i < 500; i++) ws.send(String(i));
      await done;
      assert.deepEqual(got, Array.from({ length: 500 }, (_, i) => i));
      ws.terminate();
    });

    test('streams are cleaned up after requests finish', async () => {
      await req(relay.port, { host, path: '/hello' });
      const { ws, first } = await openBrowserWs(relay.port, host);
      await first;
      ws.close();
      await new Promise((r) => ws.once('close', r));
      const session = [...relay.relay.sessions][0];
      await waitClean(() => session.streams.size === 0 && client.streams.size === 0);
    });
  });
}

async function waitClean(fn) {
  const end = Date.now() + 3000;
  while (!fn()) {
    if (Date.now() > end) throw new Error('streams were not cleaned up');
    await sleep(20);
  }
}

describe('host header preserve', () => {
  test('--host-header preserve and custom host', async () => {
    const relay = await startRelay();
    const app = await appServer();
    const client = newClient(relay.url, { transport: 'ws' });
    try {
      const t = await client.share(String(app.port), { hostHeader: 'preserve' });
      const host = hostOf(t.url);
      let r = await req(relay.port, { host, path: '/headers', headers: { origin: `http://${host}` } });
      let { headers } = JSON.parse(r.text());
      assert.equal(headers.host, host);
      assert.equal(headers.origin, `http://${host}`);
      assert.equal(headers['x-forwarded-host'], host);

      // Changing the mode on an existing share takes effect.
      await client.share(String(app.port), { hostHeader: 'myapp.internal', name: t.id });
      r = await req(relay.port, { host, path: '/headers' });
      ({ headers } = JSON.parse(r.text()));
      assert.equal(headers.host, 'myapp.internal');
    } finally {
      await client.close();
      app.wss.close();
      await app.stop();
      await relay.relay.close();
    }
  });
});
