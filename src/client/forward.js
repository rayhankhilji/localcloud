// Delivers tunneled requests to the local server and streams responses back.
// Rewrites Host/Origin so dev servers with host checks (Vite, Next.js, Angular,
// webpack-dev-server…) accept the request without any config changes.

import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';
import { Inbound, Outbound } from '../flow.js';
import { T, filterRawHeaders, pairsToObject } from '../protocol.js';

const localHttpAgent = new http.Agent({ keepAlive: true, maxSockets: 64 });
const localHttpsAgent = new https.Agent({ keepAlive: true, maxSockets: 64, rejectUnauthorized: false });

/**
 * Parse "3000", ":3000", "localhost:3000", "http://127.0.0.1:3000", "https://localhost:8443".
 * @returns {{protocol: 'http:'|'https:', host: string|null, port: number, key: string}}
 */
export function parseTarget(spec) {
  const s = String(spec).trim();
  let protocol = 'http:';
  let host = null;
  let port;
  if (/^:?[+-]?\d+(\.\d+)?$/.test(s)) {
    port = Number(s.replace(':', ''));
  } else {
    const u = new URL(/^[a-z]+:\/\//i.test(s) ? s : `http://${s}`);
    protocol = u.protocol === 'https:' ? 'https:' : 'http:';
    host = u.hostname.replace(/^\[|\]$/g, '');
    port = Number(u.port) || (protocol === 'https:' ? 443 : 80);
    if (['localhost', '127.0.0.1', '::1', '0.0.0.0'].includes(host)) host = null;
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error(`"${spec}" is not a valid port or URL`);
  const key = host ? `${protocol === 'https:' ? 'https://' : ''}${host}:${port}` : `${protocol === 'https:' ? 'https://localhost:' : ''}${port}`;
  return { protocol, host, port, key };
}

// Which loopback address answers on a port (dev servers bind to 127.0.0.1 or ::1).
const loopbackCache = new Map();

function probe(host, port, timeout = 1500) {
  return new Promise((resolve) => {
    const s = net.connect({ host, port });
    const done = (ok) => {
      s.destroy();
      resolve(ok);
    };
    s.setTimeout(timeout, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

async function resolveHost(target) {
  if (target.host) return target.host;
  const cached = loopbackCache.get(target.port);
  if (cached) return cached;
  for (const h of ['127.0.0.1', '::1']) {
    if (await probe(h, target.port)) {
      loopbackCache.set(target.port, h);
      return h;
    }
  }
  return '127.0.0.1';
}

export function isListening(port) {
  return probe('127.0.0.1', port, 500).then((ok) => ok || probe('::1', port, 500));
}

function localOrigin(target) {
  const defaultPort = target.protocol === 'https:' ? 443 : 80;
  return `${target.protocol}//${target.host || 'localhost'}${target.port === defaultPort ? '' : `:${target.port}`}`;
}

/**
 * Build the headers sent to the local server.
 * @param {object} req REQ frame payload
 * @param {{target: ReturnType<typeof parseTarget>, hostHeader?: string}} t
 */
export function localRequestHeaders(req, t) {
  const target = t.target;
  const mode = t.hostHeader || 'rewrite';
  const local = localOrigin(target);
  const publicHost = new URL(req.origin).host;
  const out = [];
  for (const [name, value] of req.headers) {
    const lower = name.toLowerCase();
    if (lower === 'host') continue;
    if (mode === 'rewrite' && lower === 'origin' && value === req.origin) {
      out.push([name, local]);
      continue;
    }
    if (mode === 'rewrite' && lower === 'referer' && value.startsWith(req.origin)) {
      out.push([name, local + value.slice(req.origin.length)]);
      continue;
    }
    out.push([name, value]);
  }
  const host = mode === 'rewrite' ? new URL(local).host : mode === 'preserve' ? publicHost : mode;
  out.unshift(['Host', host]);
  // Transfer-Encoding is hop-by-hop, so the relay only tells us the body was chunked.
  // Say so explicitly: Node would otherwise send a GET/DELETE/OPTIONS body unframed.
  if (req.chunked && !out.some(([k]) => k.toLowerCase() === 'content-length')) out.push(['Transfer-Encoding', 'chunked']);
  if (req.remote) out.push(['X-Forwarded-For', req.remote]);
  out.push(['X-Forwarded-Proto', req.proto || 'https']);
  // In rewrite mode the app believes it is on localhost; announcing a different
  // forwarded host would trip same-origin checks (e.g. Next.js server actions).
  if (mode !== 'rewrite') out.push(['X-Forwarded-Host', publicHost]);
  out.push(['X-Localcloud-Url', req.origin]);
  return out;
}

const LOCAL_ORIGIN_RE = /^(https?:)\/\/(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::(\d+))?(?=[/?#]|$)/i;
const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Rewrite response headers that leak the local origin. */
export function publicResponseHeaders(rawHeaders, req, t) {
  const target = t.target;
  const originRe = target.host
    ? new RegExp(`^(https?:)\\/\\/(${escapeRe(target.host.includes(':') ? `[${target.host}]` : target.host)})(?::(\\d+))?(?=[/?#]|$)`, 'i')
    : LOCAL_ORIGIN_RE;
  const pairs = filterRawHeaders(rawHeaders);
  const out = [];
  for (const [name, value] of pairs) {
    const lower = name.toLowerCase();
    if (lower === 'location' || lower === 'content-location' || lower === 'access-control-allow-origin') {
      const m = value.match(originRe);
      if (m && Number(m[3] || (m[1] === 'https:' ? 443 : 80)) === target.port) {
        out.push([name, req.origin + value.slice(m[0].length)]);
        continue;
      }
    }
    if (lower === 'set-cookie') {
      out.push([name, value.replace(/;\s*domain=(localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?=;|$)/gi, '')]);
      continue;
    }
    out.push([name, value]);
  }
  return out;
}

function headHttp(req, headers) {
  let head = `${req.method} ${req.url} HTTP/1.1\r\n`;
  for (const [k, v] of headers) head += `${k}: ${String(v).replace(/[\r\n]/g, '')}\r\n`;
  return head + '\r\n';
}

/**
 * Handle one REQ frame.
 * @param {{send: (type: number, sid: number, payload?: any) => void}} conn
 * @param {number} sid
 * @param {object} req
 * @param {{target: ReturnType<typeof parseTarget>, hostHeader?: string}} tunnel
 * @param {(info: object) => void} [onLog]
 * @param {() => void} [onDone] called once the stream needs no more bookkeeping
 * @returns {{onData(b: Buffer): void, onEnd(): void, onAbort(): void, out: Outbound}}
 */
export function forward(conn, sid, req, tunnel, onLog, onDone) {
  const send = (type, payload) => conn.send(type, sid, payload);
  const target = tunnel.target;
  const headers = localRequestHeaders(req, tunnel);
  const started = Date.now();
  const out = new Outbound(send);
  let finished = false;
  const pre = []; // bytes that arrive before the local connection exists
  let preEnded = false;
  let inbound = null;
  let sink = null;
  let aborted = false;

  const complete = () => {
    if (finished) return;
    finished = true;
    onDone?.();
  };

  const abort = (err) => {
    if (finished) return;
    complete();
    send(T.ABORT, { code: err?.code || 'ERROR', message: err?.message || String(err) });
    onLog?.({ method: req.method, url: req.url, status: 502, ms: Date.now() - started, error: err?.code || err?.message, upgrade: req.upgrade });
  };

  const attach = (writable) => {
    sink = writable;
    inbound = new Inbound(writable, send);
    for (const b of pre.splice(0)) inbound.write(b);
    if (preEnded) writable.end();
  };

  const stream = {
    out,
    onData(chunk) {
      if (inbound) inbound.write(chunk);
      else pre.push(chunk);
    },
    onEnd() {
      if (sink) sink.end();
      else preEnded = true;
    },
    onAbort() {
      aborted = true;
      complete();
      out.stop();
      sink?.destroy();
    },
  };

  resolveHost(target).then((host) => {
    if (aborted) return;
    if (req.upgrade) {
      const opts = { host, port: target.port };
      const sock = target.protocol === 'https:' ? tls.connect({ ...opts, rejectUnauthorized: false, servername: net.isIP(host) ? undefined : host }) : net.connect(opts);
      sock.setNoDelay(true);
      let connected = false;
      sock.once(target.protocol === 'https:' ? 'secureConnect' : 'connect', () => {
        connected = true;
        onLog?.({ method: req.method, url: req.url, status: 101, ms: Date.now() - started, upgrade: true });
      });
      sock.on('error', (err) => {
        if (!connected) {
          loopbackCache.delete(target.port);
          abort(err);
        } else if (!finished) {
          complete();
          send(T.ABORT, { code: err.code, message: err.message });
        }
      });
      sock.on('close', () => {
        if (finished) return;
        const clean = out.ended;
        complete();
        if (!clean) send(T.ABORT, { code: 'ECONNRESET', message: 'local socket closed' });
      });
      sock.write(headHttp(req, headers));
      attach(sock);
      out.pump(sock);
      return;
    }

    const isHttps = target.protocol === 'https:';
    const lreq = (isHttps ? https : http).request({
      host,
      port: target.port,
      method: req.method,
      path: req.url,
      headers: pairsToObjectPreservingCase(headers),
      agent: isHttps ? localHttpsAgent : localHttpAgent,
      setHost: false,
      servername: isHttps && !net.isIP(host) ? host : undefined,
    });
    lreq.on('response', (lres) => {
      if (aborted) return lres.destroy();
      const resHeaders = publicResponseHeaders(lres.rawHeaders, req, tunnel);
      send(T.RES, { status: lres.statusCode, statusText: lres.statusMessage, headers: resHeaders });
      out.pump(lres, () => {
        complete();
        onLog?.({ method: req.method, url: req.url, status: lres.statusCode, ms: Date.now() - started });
      });
      lres.on('error', (err) => abort(err));
    });
    lreq.on('error', (err) => {
      if (err.code === 'ECONNREFUSED') loopbackCache.delete(target.port);
      abort(err);
    });
    attach(lreq);
  });

  return stream;
}

function pairsToObjectPreservingCase(pairs) {
  // Node lower-cases header names anyway; keep duplicates (cookies) intact.
  const obj = pairsToObject(pairs);
  if (Array.isArray(obj.cookie)) obj.cookie = obj.cookie.join('; ');
  if (Array.isArray(obj.host)) obj.host = obj.host[0];
  return obj;
}
