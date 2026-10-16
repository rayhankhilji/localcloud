// End-to-end test: wrangler dev (workerd, no Cloudflare account needed) + the
// real localcloud Node client + a local HTTP/WebSocket server.
//
//   node test/e2e.mjs                  # starts `wrangler dev --local` itself
//   RELAY_PORT=8799 node test/e2e.mjs  # pick the port
//   RELAY_URL=http://127.0.0.1:8799 node test/e2e.mjs   # use a running relay
//                                      # (started with --env dev, DOMAIN=localhost:<port>, STREAM_STALL_MS=3000)

import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import http from 'node:http';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import WebSocket, { WebSocketServer } from 'ws';
import { Client } from '../../src/client/client.js';

const here = fileURLToPath(new URL('..', import.meta.url));
const PORT = Number(process.env.RELAY_PORT || 8799);
const RELAY = process.env.RELAY_URL || `http://127.0.0.1:${PORT}`;
const relayPort = Number(new URL(RELAY).port || 80);
const DOMAIN = `localhost:${relayPort}`;

let wrangler;
function stopRelay() {
  if (!wrangler) return;
  try {
    process.kill(-wrangler.pid, 'SIGTERM'); // wrangler + its workerd children
  } catch {}
}

async function startRelay() {
  if (process.env.RELAY_URL) return;
  wrangler = spawn(
    process.execPath,
    ['node_modules/wrangler/bin/wrangler.js', 'dev', '--env', 'dev', '--local', '--ip', '127.0.0.1', '--port', String(PORT), '--var', `DOMAIN:${DOMAIN}`, '--var', 'STREAM_STALL_MS:3000', '--show-interactive-dev-session=false'],
    { cwd: here, env: { ...process.env, NO_PROXY: '*', no_proxy: '*' }, stdio: ['ignore', 'pipe', 'pipe'], detached: true },
  );
  const log = (d) => process.env.VERBOSE && process.stderr.write(`[wrangler] ${d}`);
  wrangler.stdout.on('data', log);
  wrangler.stderr.on('data', log);
  for (let i = 0; i < 120; i++) {
    try {
      const r = await req({ path: '/__localcloud/health' });
      if (r.status === 200) return;
    } catch {}
    await sleep(500);
  }
  throw new Error('wrangler dev did not come up');
}

/** Plain http.request against the relay with an explicit Host header (no proxies involved). */
function req({ method = 'GET', path = '/', host = DOMAIN, headers = {}, body, onChunk } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(RELAY);
    const r = http.request({ host: u.hostname, port: relayPort, method, path, headers: { host, ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => {
        chunks.push(c);
        onChunk?.(c);
      });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    r.on('error', reject);
    if (body && typeof body.pipe === 'function') body.pipe(r);
    else r.end(body);
  });
}

function startLocalServer() {
  const server = http.createServer(async (rq, rs) => {
    const url = new URL(rq.url, 'http://x');
    if (url.pathname === '/') {
      rs.writeHead(200, { 'content-type': 'text/plain', 'set-cookie': ['a=1; Path=/', 'b=2; Path=/'] });
      return rs.end(`hello from local, host=${rq.headers.host}, fwd=${rq.headers['x-forwarded-proto']}, cookie=${rq.headers.cookie || ''}`);
    }
    if (url.pathname === '/echo') {
      const hash = crypto.createHash('sha256');
      let n = 0;
      for await (const c of rq) {
        hash.update(c);
        n += c.length;
      }
      rs.writeHead(200, { 'content-type': 'application/json' });
      return rs.end(JSON.stringify({ bytes: n, sha256: hash.digest('hex'), method: rq.method }));
    }
    if (url.pathname === '/mirror') {
      // Stream the request body straight back (exercises both directions at once).
      rs.writeHead(200, { 'content-type': 'application/octet-stream' });
      return rq.pipe(rs);
    }
    if (url.pathname === '/stream') {
      rs.writeHead(200, { 'content-type': 'text/plain' });
      for (let i = 0; i < 5; i++) {
        rs.write(`tick ${i} ${Date.now()}\n`);
        await sleep(300);
      }
      return rs.end('done\n');
    }
    if (url.pathname === '/big') {
      const size = Number(url.searchParams.get('mb') || 5) * 1024 * 1024;
      const block = crypto.randomBytes(64 * 1024);
      rs.writeHead(200, { 'content-type': 'application/octet-stream', 'content-length': size });
      let sent = 0;
      const pump = () => {
        while (sent < size) {
          const n = Math.min(block.length, size - sent);
          sent += n;
          if (!rs.write(block.subarray(0, n))) return rs.once('drain', pump);
        }
        rs.end();
      };
      return pump();
    }
    if (url.pathname === '/forever') {
      // Writes until the browser side goes away; records how far it got.
      rs.writeHead(200, { 'content-type': 'application/octet-stream' });
      const block = Buffer.alloc(16 * 1024, 120);
      let sent = 0;
      const timer = setInterval(() => {
        sent += block.length;
        rs.write(block);
      }, 5);
      rs.on('close', () => {
        clearInterval(timer);
        server.emit('forever-closed', sent);
      });
      return;
    }
    if (url.pathname === '/gzip') {
      const zlib = await import('node:zlib');
      rs.writeHead(200, { 'content-type': 'text/plain', 'content-encoding': 'gzip' });
      return rs.end(zlib.gzipSync('compressed hello '.repeat(100)));
    }
    if (url.pathname === '/redirect') {
      rs.writeHead(302, { location: `http://localhost:${server.address().port}/` });
      return rs.end();
    }
    if (url.pathname === '/nocontent') {
      rs.writeHead(204);
      return rs.end();
    }
    rs.writeHead(404);
    rs.end('nope');
  });
  const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    handleProtocols: (protocols) => (protocols.has('echo-proto') ? 'echo-proto' : false),
  });
  server.on('upgrade', (rq, sock, head) => {
    if (rq.url.startsWith('/refuse')) {
      sock.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 7\r\n\r\nno way\n');
      return;
    }
    wss.handleUpgrade(rq, sock, head, (ws) => {
      ws.send(JSON.stringify({ hello: true, origin: rq.headers.origin || null, host: rq.headers.host }));
      ws.on('message', (data, isBinary) => {
        if (!isBinary && String(data) === 'close-me') return ws.close(4001, 'asked to');
        if (!isBinary && String(data) === 'ping-me') return ws.ping('xyz');
        ws.send(data, { binary: isBinary });
      });
    });
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

function wsConnect(path, host, protocols) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${relayPort}${path}`, protocols, { headers: { host, origin: `http://${host}` }, perMessageDeflate: false });
    const queue = [];
    const waiters = [];
    ws.on('message', (data, isBinary) => {
      const m = { data: isBinary ? Buffer.from(data) : String(data), isBinary };
      const w = waiters.shift();
      if (w) w(m);
      else queue.push(m);
    });
    ws.next = () => (queue.length ? Promise.resolve(queue.shift()) : new Promise((r) => waiters.push(r)));
    ws.once('open', () => resolve(ws));
    ws.once('unexpected-response', (_rq, res) => reject(Object.assign(new Error(`HTTP ${res.statusCode}`), { status: res.statusCode })));
    ws.once('error', reject);
  });
}

const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`ok   ${name} (${Date.now() - t0} ms)`);
  } catch (err) {
    results.push({ name, ok: false, err });
    console.log(`FAIL ${name}: ${err.stack || err}`);
  }
}

async function suite(transport, local) {
  const client = new Client({ relay: RELAY, transport, proxy: null });
  const t = await client.share(local.address().port);
  console.log(`# transport=${transport} tunnel ${t.id} -> ${t.url}`);
  const host = new URL(t.url).host;
  assert.equal(host, `${t.id}.${DOMAIN}`);
  assert.equal(client.relayInfo.ok, true);

  await test(`[${transport}] GET /`, async () => {
    const r = await req({ host, path: '/', headers: { cookie: '__lc_t=x; keep=me' } });
    assert.equal(r.status, 200);
    const body = r.body.toString();
    assert.match(body, /^hello from local, host=localhost:\d+, fwd=http, cookie=keep=me$/);
    assert.deepEqual(r.headers['set-cookie'], ['a=1; Path=/', 'b=2; Path=/']);
  });

  await test(`[${transport}] POST 5 MB body`, async () => {
    const data = crypto.randomBytes(5 * 1024 * 1024);
    const r = await req({ host, method: 'POST', path: '/echo', body: data, headers: { 'content-type': 'application/octet-stream', 'content-length': data.length } });
    assert.equal(r.status, 200);
    const j = JSON.parse(r.body);
    assert.equal(j.bytes, data.length);
    assert.equal(j.sha256, crypto.createHash('sha256').update(data).digest('hex'));
  });

  await test(`[${transport}] POST 5 MB mirrored (both directions, flow control)`, async () => {
    const data = crypto.randomBytes(5 * 1024 * 1024);
    const r = await req({ host, method: 'POST', path: '/mirror', body: data, headers: { 'content-length': data.length } });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, data.length);
    assert.ok(r.body.equals(data));
  });

  await test(`[${transport}] GET 8 MB download`, async () => {
    const r = await req({ host, path: '/big?mb=8' });
    assert.equal(r.status, 200);
    assert.equal(r.body.length, 8 * 1024 * 1024);
  });

  await test(`[${transport}] streaming response arrives incrementally`, async () => {
    const t0 = Date.now();
    const times = [];
    const r = await req({ host, path: '/stream', onChunk: () => times.push(Date.now() - t0) });
    assert.equal(r.status, 200);
    assert.match(r.body.toString(), /tick 4[\s\S]*done/);
    assert.ok(times[0] < 1000, `first chunk after ${times[0]} ms`);
    assert.ok(times.at(-1) - times[0] > 800, `chunks spread over ${times.at(-1) - times[0]} ms (not buffered)`);
  });

  await test(`[${transport}] browser abort reaches the local server`, async () => {
    const closed = new Promise((r) => local.once('forever-closed', r));
    await new Promise((resolve, reject) => {
      const r = http.request({ host: '127.0.0.1', port: relayPort, path: '/forever', headers: { host }, agent: false }, (res) => {
        assert.equal(res.statusCode, 200);
        res.once('data', () => setTimeout(() => (r.destroy(), resolve()), 200));
      });
      r.on('error', () => {});
      r.on('close', resolve);
      r.end();
    });
    const sent = await Promise.race([closed, sleep(10_000).then(() => 'timeout')]);
    assert.notEqual(sent, 'timeout', 'local response was never aborted');
  });

  await test(`[${transport}] slow reader gets backpressure, not a buffer blow-up`, async () => {
    // Read 6 MB at ~3 MB/s: must complete intact while the relay only ACKs consumed bytes.
    const r = await new Promise((resolve, reject) => {
      const rq = http.request({ host: '127.0.0.1', port: relayPort, path: '/big?mb=6', headers: { host }, agent: false }, (res) => {
        let n = 0;
        res.on('data', (c) => {
          n += c.length;
          res.pause();
          setTimeout(() => res.resume(), Math.ceil(c.length / 3000));
        });
        res.on('end', () => resolve(n));
        res.on('error', reject);
      });
      rq.on('error', reject);
      rq.end();
    });
    assert.equal(r, 6 * 1024 * 1024);
  });

  await test(`[${transport}] gzip passthrough, 204, redirect rewrite`, async () => {
    const zlib = await import('node:zlib');
    const g = await req({ host, path: '/gzip', headers: { 'accept-encoding': 'gzip' } });
    assert.equal(g.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(g.body).toString(), 'compressed hello '.repeat(100));
    const n = await req({ host, path: '/nocontent' });
    assert.equal(n.status, 204);
    const red = await req({ host, path: '/redirect' });
    assert.equal(red.status, 302);
    assert.equal(red.headers.location, `http://${host}/`);
  });

  await test(`[${transport}] browser WebSocket echo (text, binary, subprotocol, close)`, async () => {
    const ws = await wsConnect('/ws', host, ['echo-proto']);
    assert.equal(ws.protocol, 'echo-proto');
    const hello = JSON.parse((await ws.next()).data);
    assert.equal(hello.hello, true);
    assert.equal(hello.origin, `http://localhost:${local.address().port}`); // Origin rewritten by the client
    ws.send('hi there');
    assert.deepEqual(await ws.next(), { data: 'hi there', isBinary: false });
    const unicode = 'héllo ☁️ '.repeat(20000); // > 64 KiB, multi-byte
    ws.send(unicode);
    assert.equal((await ws.next()).data, unicode);
    const bin = crypto.randomBytes(300 * 1024);
    ws.send(bin);
    const back = await ws.next();
    assert.equal(back.isBinary, true);
    assert.ok(back.data.equals(bin));
    for (let i = 0; i < 50; i++) ws.send(`m${i}`);
    for (let i = 0; i < 50; i++) assert.equal((await ws.next()).data, `m${i}`);
    ws.send('ping-me'); // local server pings us; relay must answer with a pong
    ws.send('after ping');
    assert.equal((await ws.next()).data, 'after ping');
    const closed = new Promise((r) => ws.once('close', (code, reason) => r({ code, reason: String(reason) })));
    ws.send('close-me');
    assert.deepEqual(await closed, { code: 4001, reason: 'asked to' });
  });

  await test(`[${transport}] browser closes WebSocket`, async () => {
    const ws = await wsConnect('/ws', host, ['echo-proto']);
    await ws.next();
    const closed = new Promise((r) => ws.once('close', (code) => r(code)));
    ws.close(1000, 'bye');
    assert.equal(await closed, 1000);
  });

  await test(`[${transport}] refused upgrade is relayed as HTTP`, async () => {
    await assert.rejects(wsConnect('/refuse', host), (err) => err.status === 403);
  });

  await test(`[${transport}] unknown tunnel -> 404, landing + health`, async () => {
    const r = await req({ host: `nope-nope-zzzz.${DOMAIN}`, path: '/', headers: { accept: 'text/html' } });
    assert.equal(r.status, 404);
    assert.match(r.body.toString(), /No tunnel at this address/);
    const h = await req({ path: '/__localcloud/health' });
    const j = JSON.parse(h.body);
    assert.equal(j.service, 'localcloud');
    assert.equal(j.protocol, 1);
  });

  return { client, tunnel: t, host };
}

async function main() {
  const local = await startLocalServer();
  await startRelay();
  try {
    const ws = await suite('ws', local);
    const poll = await suite('http', local);

    await test('protected tunnel + basic auth', async () => {
      const c = new Client({ relay: RELAY, transport: 'ws', proxy: null });
      const t = await c.share(local.address().port, { name: 'secret-thing', protect: true });
      assert.ok(t.accessUrl);
      const host = new URL(t.url).host;
      const denied = await req({ host, path: '/', headers: { accept: 'text/html' } });
      assert.equal(denied.status, 401);
      const token = new URL(t.accessUrl).searchParams.get('__lc_access');
      const r = await req({ host, path: `/?__lc_access=${token}` });
      assert.equal(r.status, 302);
      const cookie = r.headers['set-cookie'][0].split(';')[0];
      const ok = await req({ host, path: '/', headers: { cookie } });
      assert.equal(ok.status, 200);
      assert.doesNotMatch(ok.body.toString(), /__lc_a/); // relay cookies are stripped
      await c.close();

      const b = new Client({ relay: RELAY, transport: 'ws', proxy: null });
      const tb = await b.share(local.address().port, { basicAuth: 'u:p' });
      const bh = new URL(tb.url).host;
      assert.equal((await req({ host: bh, path: '/' })).status, 401);
      assert.equal((await req({ host: bh, path: '/', headers: { authorization: `Basic ${Buffer.from('u:p').toString('base64')}` } })).status, 200);
      await b.close();
    });

    await test('name reservation: another client cannot take a name', async () => {
      const a = new Client({ relay: RELAY, transport: 'ws', proxy: null });
      await a.share(local.address().port, { name: 'mine-only' });
      const b = new Client({ relay: RELAY, transport: 'ws', proxy: null });
      await assert.rejects(b.share(local.address().port, { name: 'mine-only' }), /already taken/);
      await a.close();
      await b.close();
    });

    await test('reconnect keeps the URL (client transport dropped)', async () => {
      const id = ws.tunnel.id;
      const reconnected = new Promise((r) => ws.client.once('tunnel', (d) => r(d)));
      ws.client.transport.close(); // simulate a network drop
      const d = await reconnected;
      assert.equal(d.id, id);
      // Stale Worker cache points at the old session DO; it must re-route.
      const r = await req({ host: ws.host, path: '/' });
      assert.equal(r.status, 200);
    });

    await test('same client instance on a new connection replaces the stale session', async () => {
      const a = new Client({ relay: RELAY, transport: 'ws', proxy: null });
      const t = await a.share(local.address().port);
      // A second connection from the "same process" (same instance + secret) while the first still looks alive.
      const b = new Client({ relay: RELAY, transport: 'ws', proxy: null, secret: a.secret });
      b.instance = a.instance;
      a.closed = true; // don't let `a` reconnect and steal it back
      const aDropped = new Promise((r) => a.transport.once('close', r));
      const tb = await b.share(local.address().port, { name: t.id });
      assert.equal(tb.id, t.id);
      await Promise.race([aDropped, sleep(5000).then(() => assert.fail('stale session was not closed'))]);
      assert.equal((await req({ host: new URL(tb.url).host, path: '/' })).status, 200);
      await b.close();
    });

    await test('POST /http/close ends a long-poll session', async () => {
      const s = await req({ method: 'POST', path: '/__localcloud/http/session', headers: { 'content-length': 0 } });
      const { sid } = JSON.parse(s.body);
      const c = await req({ method: 'POST', path: `/__localcloud/http/close?sid=${encodeURIComponent(sid)}`, headers: { 'content-length': 0 } });
      assert.equal(c.status, 204);
      const d = await req({ method: 'POST', path: `/__localcloud/http/down?sid=${encodeURIComponent(sid)}&ack=0`, headers: { 'content-length': 0 } });
      assert.equal(d.status, 410);
      const bogus = await req({ method: 'POST', path: '/__localcloud/http/up?sid=nope&seq=1', headers: { 'content-length': 0 } });
      assert.equal(bogus.status, 410);
    });

    await test('offline tunnel shows the reconnecting page', async () => {
      const c = new Client({ relay: RELAY, transport: 'ws', proxy: null });
      const t = await c.share(local.address().port);
      const host = new URL(t.url).host;
      assert.equal((await req({ host, path: '/' })).status, 200);
      c.closed = true; // stop reconnecting, keep the reservation
      c.transport.close();
      await sleep(500);
      const probe = await req({ host, path: '/', headers: { 'x-localcloud-probe': '1' } });
      assert.equal(probe.status, 503);
      const t0 = Date.now();
      const r = await req({ host, path: '/', headers: { accept: 'text/html' } });
      assert.equal(r.status, 503);
      assert.ok(Date.now() - t0 >= 7000, 'waited for a reconnect first');
      assert.match(r.body.toString(), /reconnecting/);
    });

    await ws.client.close();
    await poll.client.close();
  } finally {
    local.close();
    stopRelay();
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  stopRelay();
  process.exit(1);
});
