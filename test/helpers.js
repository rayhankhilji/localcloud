// Shared test fixtures: a relay on a random port, local servers, a raw HTTP
// client that talks to the relay with an arbitrary Host header, and a tiny
// HTTP CONNECT proxy.

import crypto from 'node:crypto';
import http from 'node:http';
import net from 'node:net';
import { Client } from '../src/client/client.js';
import { Relay } from '../src/relay/server.js';

export const DOMAIN = 'lc.test';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

/** Poll `fn` until it returns something truthy. */
export async function waitFor(fn, { timeout = 10_000, interval = 25, message = 'condition' } = {}) {
  const end = Date.now() + timeout;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${message}`);
    await sleep(interval);
  }
}

/** A relay listening on 127.0.0.1:<random>. */
export async function startRelay(opts = {}) {
  const logs = [];
  const relay = new Relay({ domain: DOMAIN, insecure: true, log: (m) => logs.push(m), ...opts });
  const addr = await relay.listen({ port: 0, host: '127.0.0.1' });
  return { relay, port: addr.port, url: `http://127.0.0.1:${addr.port}`, logs };
}

export function newClient(relayUrl, opts = {}) {
  return new Client({ relay: relayUrl, proxy: null, ...opts });
}

/** A local HTTP server on 127.0.0.1:<random>. */
export async function localServer(handler) {
  const server = http.createServer(handler);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  server.port = server.address().port;
  server.stop = () => {
    server.closeAllConnections?.();
    return new Promise((r) => server.close(() => r()));
  };
  return server;
}

/** A port nothing listens on. */
export async function freePort() {
  const s = net.createServer();
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  const { port } = s.address();
  await new Promise((r) => s.close(r));
  return port;
}

/**
 * Send a request to the relay. `host` is the Host header (e.g. "<id>.lc.test").
 * @returns {Promise<{status: number, headers: http.IncomingHttpHeaders, body: Buffer}>}
 */
export function req(port, { host, method = 'GET', path = '/', headers = {}, body, timeout = 20_000 } = {}) {
  return new Promise((resolve, reject) => {
    const r = http.request({ host: '127.0.0.1', port, method, path, headers: { ...(host ? { host } : {}), ...headers }, agent: false }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks), text: () => Buffer.concat(chunks).toString() }));
      res.on('error', reject);
    });
    r.setTimeout(timeout, () => r.destroy(new Error(`request ${method} ${path} timed out`)));
    r.on('error', reject);
    if (typeof body === 'function') body(r);
    else r.end(body);
  });
}

/** Host header for a tunnel URL like http://<id>.lc.test */
export const hostOf = (url) => new URL(url).host;

/**
 * Minimal HTTP CONNECT proxy.
 * @param {{blockWebSocket?: boolean, refuse?: number}} [opts]
 *   blockWebSocket: sniff the tunneled bytes and answer 403 to WebSocket upgrades
 *   (what TLS-intercepting egress proxies with a "no websockets" policy do).
 *   refuse: answer every CONNECT with this status.
 */
export async function connectProxy(opts = {}) {
  const stats = { connects: 0, blockedUpgrades: 0, targets: [] };
  const server = http.createServer((_req, res) => res.writeHead(405).end());
  const sockets = new Set();
  server.on('connection', (s) => {
    sockets.add(s);
    s.on('close', () => sockets.delete(s));
  });
  server.on('connect', (req, client, head) => {
    stats.connects++;
    stats.targets.push(req.url);
    client.on('error', () => {});
    if (opts.refuse) {
      client.end(`HTTP/1.1 ${opts.refuse} Forbidden\r\nContent-Length: 0\r\n\r\n`);
      return;
    }
    const [host, port] = req.url.split(':');
    const upstream = net.connect(Number(port), host);
    sockets.add(upstream);
    upstream.on('close', () => sockets.delete(upstream));
    upstream.on('error', () => client.destroy());
    client.on('close', () => upstream.destroy());
    upstream.once('connect', () => {
      client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      if (!opts.blockWebSocket) {
        if (head?.length) upstream.write(head);
        client.pipe(upstream);
        upstream.pipe(client);
        return;
      }
      // Inspect the first request in the tunnel.
      let buf = head?.length ? Buffer.from(head) : Buffer.alloc(0);
      const onData = (chunk) => {
        buf = Buffer.concat([buf, chunk]);
        const end = buf.indexOf('\r\n\r\n');
        if (end < 0) return;
        client.off('data', onData);
        const headText = buf.subarray(0, end).toString('latin1');
        if (/^upgrade:\s*websocket/im.test(headText)) {
          stats.blockedUpgrades++;
          client.end('HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nContent-Length: 18\r\nConnection: close\r\n\r\nwebsocket blocked\n');
          upstream.destroy();
          return;
        }
        upstream.write(buf);
        client.pipe(upstream);
        upstream.pipe(client);
      };
      client.on('data', onData);
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return {
    url: `http://127.0.0.1:${port}`,
    stats,
    close: () => {
      for (const s of sockets) s.destroy();
      return new Promise((r) => server.close(() => r()));
    },
  };
}

/** Collect a readable into a Buffer. */
export async function collect(readable) {
  const chunks = [];
  for await (const c of readable) chunks.push(c);
  return Buffer.concat(chunks);
}
