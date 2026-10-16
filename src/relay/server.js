// The relay: a public server that accepts outbound connections from
// localcloud clients and routes browser traffic for <id>.<domain> to them.
//
// Clients connect with a WebSocket (fast path) or plain HTTPS long-polling
// (works through any proxy that allows HTTPS at all). Both transports speak
// the same framed protocol, so everything above the transport is shared.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { WebSocketServer } from 'ws';
import { Inbound, Outbound } from '../flow.js';
import { generateName, normalizeName, randomToken } from '../names.js';
import {
  PROTOCOL_VERSION,
  T,
  decodeAck,
  decodeBatch,
  decodeFrame,
  encodeBatch,
  encodeFrame,
  filterRawHeaders,
  pairsToObject,
  parseJson,
} from '../protocol.js';
import { VERSION } from '../version.js';
import { landingPage, notFoundPage, offlinePage, privatePage, upstreamDownPage } from './pages.js';

const API = '/__localcloud/';
const ROUTE_COOKIE = '__lc_t';
const ACCESS_COOKIE = '__lc_a';
const ACCESS_PARAM = '__lc_access';

const POLL_HOLD_MS = 15_000;
const SESSION_IDLE_MS = 45_000;
const WAIT_FOR_RECONNECT_MS = 8_000;
const RESERVATION_MS = 60 * 60_000;
const MAX_TUNNELS_PER_SESSION = 25;
const MAX_UP_BODY = 64 * 1024 * 1024;
const HELLO_TIMEOUT_MS = 30_000;

const envInt = (name, fallback) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
};

const noop = () => {};

function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    const v = part.slice(i + 1).trim();
    try {
      out[k] = decodeURIComponent(v);
    } catch {
      out[k] = v; // malformed escapes must never take the relay down
    }
  }
  return out;
}

function stripRelayCookies(value) {
  return String(value)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('__lc_'))
    .join('; ');
}

function safeEqual(a, b) {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}

function wantsHtml(req) {
  return req.method === 'GET' && /text\/html/.test(req.headers.accept || '');
}

function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
      size += c.length;
      if (size > limit) {
        reject(Object.assign(new Error('body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** WebSocket wrapper exposing the transport interface used by Session. */
class WsTransport extends EventEmitter {
  constructor(ws) {
    super();
    this.kind = 'ws';
    this.ws = ws;
    ws.on('message', (data, isBinary) => {
      if (!isBinary) return;
      this.emit('frame', Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));
    });
    ws.on('close', () => this.emit('close'));
    ws.on('error', noop);
    this.alive = true;
    ws.on('pong', () => (this.alive = true));
    this.pinger = setInterval(() => {
      if (!this.alive) return ws.terminate();
      this.alive = false;
      try {
        ws.ping();
      } catch {}
    }, 20_000);
    this.once('close', () => clearInterval(this.pinger));
  }
  send(buf) {
    if (this.ws.readyState === 1) this.ws.send(buf);
  }
  close() {
    try {
      this.ws.close();
    } catch {}
    setTimeout(() => this.ws.terminate(), 1000).unref();
  }
  end() {
    this.close(); // ws.close() flushes queued messages before the close frame
  }
}

/** HTTP long-poll transport (server side). */
class PollTransport extends EventEmitter {
  constructor(sid) {
    super();
    this.kind = 'http';
    this.sid = sid;
    this.queue = [];
    this.pending = null; // {res, timer}: the held "down" request
    this.lastBatch = null; // {seq, body}: kept until the client acknowledges it
    this.downSeq = 0;
    this.upSeq = 0;
    this.closed = false;
    this.ending = false;
    this.flushScheduled = false;
    this.lastSeen = Date.now();
    this.watchdog = setInterval(() => {
      if (!this.pending && Date.now() - this.lastSeen > SESSION_IDLE_MS) this.close();
    }, 5_000);
    this.watchdog.unref();
  }

  send(buf) {
    if (this.closed || this.ending) return;
    this.queue.push(buf);
    // Coalesce everything sent in this tick into one response.
    if (this.pending && !this.flushScheduled) {
      this.flushScheduled = true;
      setImmediate(() => {
        this.flushScheduled = false;
        this.flush();
      });
    }
  }

  flush() {
    const p = this.pending;
    if (!p || !this.queue.length) return;
    this.pending = null;
    clearTimeout(p.timer);
    // Cap each batch so one slow poll can't balloon.
    let take = 0;
    let bytes = 0;
    while (take < this.queue.length && (take === 0 || bytes + this.queue[take].length < 4 * 1024 * 1024)) {
      bytes += this.queue[take].length;
      take++;
    }
    const seq = ++this.downSeq;
    const body = encodeBatch(this.queue.splice(0, take));
    this.lastBatch = { seq, body };
    this.respond(p.res, seq, body);
    if (this.ending && !this.queue.length) this.close();
  }

  respond(res, seq, body) {
    if (res.headersSent || res.destroyed) return;
    res.writeHead(200, {
      'content-type': 'application/octet-stream',
      'cache-control': 'no-store',
      'x-lc-seq': String(seq),
      'content-length': body.length,
    });
    res.end(body);
  }

  handleDown(req, res, ack) {
    this.lastSeen = Date.now();
    if (this.closed) return res.writeHead(410, { 'cache-control': 'no-store' }).end();
    if (this.pending) {
      // A newer poll supersedes the old one (the client gave up on it).
      clearTimeout(this.pending.timer);
      this.respond(this.pending.res, 0, Buffer.alloc(0));
      this.pending = null;
    }
    if (this.lastBatch) {
      if (ack < this.lastBatch.seq) {
        // The previous response never made it; send it again.
        return this.respond(res, this.lastBatch.seq, this.lastBatch.body);
      }
      this.lastBatch = null;
    }
    const timer = setTimeout(() => {
      if (this.pending?.res === res) {
        this.pending = null;
        this.lastSeen = Date.now();
        this.respond(res, 0, Buffer.alloc(0));
      }
    }, POLL_HOLD_MS);
    this.pending = { res, timer };
    res.on('close', () => {
      if (this.pending?.res === res) {
        clearTimeout(timer);
        this.pending = null;
        this.lastSeen = Date.now();
      }
    });
    if (this.queue.length) this.flush();
  }

  handleUp(res, seq, body) {
    this.lastSeen = Date.now();
    if (this.closed) return res.writeHead(410).end();
    if (seq <= this.upSeq) return res.writeHead(204).end(); // duplicate retry
    if (seq !== this.upSeq + 1) return res.writeHead(409).end();
    let frames;
    try {
      frames = decodeBatch(body);
    } catch {
      return res.writeHead(400).end();
    }
    this.upSeq = seq;
    res.writeHead(204).end();
    for (const f of frames) {
      if (this.closed) break;
      this.emit('frame', f);
    }
  }

  /** Close once everything already queued has been handed to the client. */
  end() {
    if (this.closed || this.ending) return;
    this.ending = true;
    if (!this.queue.length) return this.close();
    this.endTimer = setTimeout(() => this.close(), 5_000);
    this.endTimer.unref();
    this.flush();
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    clearTimeout(this.endTimer);
    this.queue = [];
    this.lastBatch = null;
    if (this.pending) {
      clearTimeout(this.pending.timer);
      const { res } = this.pending;
      this.pending = null;
      if (!res.headersSent && !res.destroyed) res.writeHead(410, { 'cache-control': 'no-store' }).end();
    }
    this.emit('close');
  }
}

class Session {
  /** @param {Relay} relay @param {WsTransport|PollTransport} transport */
  constructor(relay, transport, remote) {
    this.relay = relay;
    this.transport = transport;
    this.remote = remote;
    this.ready = false;
    this.tunnels = new Map(); // id -> tunnel
    this.streams = new Map(); // sid -> stream
    this.nextSid = 1;
    this.created = this.lastRx = Date.now();
    transport.on('frame', (buf) => this.onFrame(buf));
    transport.once('close', () => this.onClose());
    this.idle = setInterval(() => {
      const now = Date.now();
      if (now - this.lastRx > SESSION_IDLE_MS * 1.5 || (!this.ready && now - this.created > HELLO_TIMEOUT_MS)) this.close();
    }, 10_000);
    this.idle.unref();
  }

  /** Hang up. Tunnels go offline right away so new requests wait for the reconnect instead of entering a dying connection. */
  close() {
    this.markOffline();
    this.transport.close();
  }

  markOffline() {
    for (const t of this.tunnels.values()) {
      if (t.session === this) {
        t.session = null;
        t.offlineSince = Date.now();
      }
    }
  }

  send(type, sid, payload) {
    this.transport.send(encodeFrame(type, sid, payload));
  }

  onFrame(buf) {
    this.lastRx = Date.now();
    let f;
    try {
      f = decodeFrame(buf);
    } catch {
      return this.close();
    }
    if (!this.ready && f.type !== T.HELLO) return this.close();
    try {
      switch (f.type) {
        case T.HELLO:
          return this.onHello(parseJson(f.payload));
        case T.OPEN:
          return this.onOpen(parseJson(f.payload));
        case T.CLOSE_TUNNEL:
          return this.onCloseTunnel(parseJson(f.payload));
        case T.PING:
          return this.send(T.PONG, 0);
        case T.PONG:
          return;
        case T.RES:
          return this.onRes(f.sid, parseJson(f.payload));
        case T.DATA:
          return this.streams.get(f.sid)?.onData(f.payload);
        case T.END:
          return this.streams.get(f.sid)?.onEnd();
        case T.ABORT:
          return this.streams.get(f.sid)?.onAbort(parseJson(f.payload));
        case T.ACK:
          return this.streams.get(f.sid)?.out.ack(decodeAck(f.payload));
      }
    } catch (err) {
      this.relay.log(`session error: ${err.message}`);
    }
  }

  onHello(msg) {
    const relay = this.relay;
    let error = null;
    if (Number(msg.v) !== PROTOCOL_VERSION) error = `protocol mismatch (client v${msg.v}, relay v${PROTOCOL_VERSION}) — update localcloud`;
    else if (relay.token && !safeEqual(msg.token || '', relay.token)) error = 'this relay requires a valid LOCALCLOUD_TOKEN';
    if (error) {
      relay.log(`rejected client from ${this.remote}: ${error}`);
      this.send(T.WELCOME, 0, { ok: false, error });
      this.transport.end(); // deliver the WELCOME, then hang up
      return;
    }
    if (this.ready) return;
    this.ready = true;
    this.client = msg.client && typeof msg.client === 'object' ? msg.client : {};
    this.instance = typeof msg.instance === 'string' ? msg.instance : null;
    this.send(T.WELCOME, 0, { ok: true, version: VERSION, routing: relay.routing, transport: this.transport.kind });
    const c = this.client;
    relay.log(`client connected via ${this.transport.kind} from ${this.remote} (localcloud ${c.version || '?'}, ${c.agent || 'unknown'} on ${c.platform || '?'})`);
  }

  onOpen(msg) {
    const relay = this.relay;
    const reply = (body) => this.send(T.OPENED, 0, { reqId: msg.reqId, ...body });
    if (typeof msg.secret !== 'string' || msg.secret.length < 16) return reply({ ok: false, error: 'invalid secret' });
    if (this.tunnels.size >= MAX_TUNNELS_PER_SESSION) return reply({ ok: false, error: 'too many tunnels on one connection' });

    let id;
    if (msg.name) {
      id = normalizeName(msg.name);
      if (!id) return reply({ ok: false, error: `"${msg.name}" can't be used as a name` });
      const existing = relay.tunnels.get(id);
      if (existing && !safeEqual(existing.secret, msg.secret)) {
        return reply({ ok: false, error: `the name "${id}" is already taken`, code: 'name_taken' });
      }
    } else {
      do id = generateName();
      while (relay.tunnels.has(id));
    }

    let tunnel = relay.tunnels.get(id);
    if (!tunnel && relay.tunnels.size >= relay.maxTunnels) {
      relay.log(`refused a tunnel for ${this.remote}: relay is full (${relay.maxTunnels} tunnels)`);
      return reply({ ok: false, error: 'this relay is at capacity, try again later', code: 'relay_full' });
    }
    if (tunnel?.session && tunnel.session !== this) {
      const old = tunnel.session;
      old.tunnels.delete(id);
      // The same client process on a new connection: the old one is dead even if TCP hasn't noticed yet.
      if (old.instance && old.instance === this.instance) old.close();
    }
    if (!tunnel) {
      tunnel = { id, secret: msg.secret, session: null, waiters: [], offlineSince: 0 };
      relay.tunnels.set(id, tunnel);
    }
    tunnel.port = Number.isInteger(msg.port) ? msg.port : null;
    tunnel.access = msg.protect ? tunnel.access || randomToken(18) : null;
    tunnel.basicAuth = typeof msg.basicAuth === 'string' && msg.basicAuth.includes(':') ? msg.basicAuth : null;
    tunnel.session = this;
    tunnel.offlineSince = 0;
    this.tunnels.set(id, tunnel);
    for (const w of tunnel.waiters.splice(0)) w(this);

    const url = relay.tunnelUrl(id, this.baseUrl);
    const accessUrl = tunnel.access ? relay.accessUrl(id, tunnel.access, this.baseUrl) : undefined;
    relay.log(`tunnel ${id} online (port ${tunnel.port ?? '?'}, ${this.transport.kind}, ${this.remote})${tunnel.access ? ' protected' : ''}${tunnel.basicAuth ? ' basic-auth' : ''}`);
    reply({ ok: true, id, url, accessUrl });
  }

  onCloseTunnel({ id }) {
    const tunnel = this.tunnels.get(id);
    if (!tunnel) return;
    this.tunnels.delete(id);
    if (tunnel.session === this) this.relay.tunnels.delete(id);
    this.relay.log(`tunnel ${id} closed`);
  }

  onRes(sid, msg) {
    const s = this.streams.get(sid);
    if (s?.onRes) s.onRes(msg);
  }

  onClose() {
    clearInterval(this.idle);
    this.relay.detach(this);
    for (const s of [...this.streams.values()]) s.onAbort({ code: 'ECONNRESET', message: 'tunnel disconnected', sessionLost: true });
    this.markOffline();
    if (this.ready) this.relay.log(`client disconnected (${this.tunnels.size} tunnel(s) waiting for reconnect)`);
  }

  requestInfo(tunnel, req, upgrade) {
    const relay = this.relay;
    const drop = (name) =>
      name.startsWith('x-forwarded-') ||
      name === 'forwarded' ||
      name === 'x-real-ip' ||
      name === 'x-localcloud-probe' ||
      (tunnel.basicAuth && name === 'authorization') ||
      name.startsWith('fly-') ||
      name.startsWith('cf-');
    const pairs = filterRawHeaders(req.rawHeaders, { upgrade, drop })
      .map(([k, v]) => (k.toLowerCase() === 'cookie' ? [k, stripRelayCookies(v)] : [k, v]))
      .filter(([k, v]) => !(k.toLowerCase() === 'cookie' && !v));
    return {
      tunnel: tunnel.id,
      method: req.method,
      url: req.url,
      headers: pairs,
      remote: relay.clientIp(req),
      proto: relay.publicProto(req),
      origin: relay.publicOrigin(tunnel.id, req),
      upgrade: !!upgrade,
      chunked: !upgrade && /chunked/i.test(String(req.headers['transfer-encoding'] || '')),
    };
  }

  /** Forward a normal HTTP request through the tunnel. */
  /**
   * Forward a normal HTTP request through the tunnel.
   * @param {{retry?: boolean}} [opts] retry: this request already went to a connection that died
   */
  forwardHttp(tunnel, req, res, opts = {}) {
    const sid = this.nextSid++;
    const send = (type, payload) => this.send(type, sid, payload);
    const started = Date.now();
    let done = false;
    let retried = false;
    const stream = {
      out: new Outbound(send),
      in: null,
      onRes: (msg) => {
        if (res.headersSent || done) return;
        const headers = pairsToObject(msg.headers || []);
        headers['x-accel-buffering'] = 'no';
        try {
          res.writeHead(msg.status || 502, headers);
        } catch {
          res.writeHead(502);
        }
        res.flushHeaders();
        stream.in = new Inbound(res, send);
      },
      onData: (chunk) => stream.in?.write(chunk),
      onEnd: () => {
        finish();
        res.end();
      },
      onAbort: ({ code, message, sessionLost } = {}) => {
        if (done) return;
        finish();
        if (res.headersSent) return res.destroy();
        // The client's connection died before it answered. A bodiless request can safely
        // go to the reconnected client instead of failing (sandboxes reconnect often).
        if (sessionLost && !opts.retry && req.complete && !stream.out.inflight && !stream.out.sentBytes) {
          retried = true;
          return this.relay.forwardWhenOnline(tunnel, req, res, { retry: true });
        }
        this.relay.sendUpstreamError(req, res, tunnel, code, message);
      },
    };
    const finish = () => {
      done = true;
      this.streams.delete(sid);
      stream.out.stop(); // if the response finished first, drain the rest of the request body
    };
    this.streams.set(sid, stream);
    send(T.REQ, this.requestInfo(tunnel, req, false));
    if (opts.retry) send(T.END); // the body (empty) was consumed by the first attempt
    else stream.out.pump(req);
    res.on('close', () => {
      if (!done) {
        finish();
        send(T.ABORT, { code: 'ECONNRESET', message: 'browser went away' });
      }
      if (!retried) this.relay.emit('request', { tunnel: tunnel.id, method: req.method, url: req.url, status: res.statusCode, ms: Date.now() - started });
    });
  }

  /** Forward an upgrade (WebSocket, HMR…) as a raw byte stream. */
  forwardUpgrade(tunnel, req, socket, head) {
    const sid = this.nextSid++;
    const send = (type, payload) => this.send(type, sid, payload);
    let done = false;
    let gotData = false;
    const finish = () => {
      done = true;
      this.streams.delete(sid);
      stream.out.stop();
    };
    const stream = {
      out: new Outbound(send),
      in: new Inbound(socket, send),
      onData: (chunk) => {
        gotData = true;
        stream.in.write(chunk);
      },
      onEnd: () => socket.end(),
      onAbort: ({ message } = {}) => {
        if (done) return;
        finish();
        if (!gotData && socket.writable) {
          const body = `localcloud: could not reach the local server (${message || 'unavailable'})\n`;
          socket.end(`HTTP/1.1 502 Bad Gateway\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(body)}\r\nConnection: close\r\n\r\n${body}`);
        } else {
          socket.destroy();
        }
      },
    };
    this.streams.set(sid, stream);
    this.relay.upgraded.add(socket);
    socket.setNoDelay(true);
    socket.on('error', noop);
    send(T.REQ, this.requestInfo(tunnel, req, true));
    if (head?.length) stream.out.write(head);
    stream.out.pump(socket);
    socket.on('close', () => {
      this.relay.upgraded.delete(socket);
      if (!done) {
        finish();
        send(T.ABORT, { code: 'ECONNRESET', message: 'browser went away' });
      }
    });
  }
}

export class Relay extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} [opts.domain]   wildcard domain, e.g. "localcloud.dev" → <id>.localcloud.dev
   * @param {string} [opts.publicUrl] public base URL of the relay (used for cookie routing)
   * @param {'auto'|'subdomain'|'cookie'} [opts.routing]
   * @param {string} [opts.token]    require clients to present this token
   * @param {boolean} [opts.insecure] tunnel URLs use http:// (local development)
   * @param {boolean} [opts.trustProxy] trust X-Forwarded-For / -Proto from a fronting proxy
   * @param {number} [opts.maxSessionsPerIp] concurrent client connections per IP (env LOCALCLOUD_MAX_SESSIONS_PER_IP)
   * @param {number} [opts.maxTunnels]       tunnels on the whole relay, reserved ones included (env LOCALCLOUD_MAX_TUNNELS)
   * @param {number} [opts.maxHeaderSize]    request header bytes (env LOCALCLOUD_MAX_HEADER_SIZE)
   * @param {number} [opts.reconnectGraceMs] how long a request waits for an offline tunnel to come back
   * @param {(msg: string) => void} [opts.log]
   */
  constructor(opts = {}) {
    super();
    this.domain = opts.domain ? opts.domain.toLowerCase().replace(/^\*\./, '').replace(/\/$/, '') : null;
    this.publicUrl = opts.publicUrl ? opts.publicUrl.replace(/\/$/, '') : null;
    this.routing = opts.routing && opts.routing !== 'auto' ? opts.routing : this.domain ? 'subdomain' : 'cookie';
    if (this.routing === 'subdomain' && !this.domain) throw new Error('subdomain routing needs --domain');
    this.token = opts.token || null;
    this.insecure = !!opts.insecure;
    this.trustProxy = opts.trustProxy ?? !/^(0|false|no|off)$/i.test(process.env.LOCALCLOUD_TRUST_PROXY || '');
    this.log = opts.log || noop;
    // Generous defaults: many agent sandboxes share a handful of egress IPs.
    this.maxSessionsPerIp = opts.maxSessionsPerIp ?? envInt('LOCALCLOUD_MAX_SESSIONS_PER_IP', 200);
    this.maxTunnels = opts.maxTunnels ?? envInt('LOCALCLOUD_MAX_TUNNELS', 10_000);
    this.maxHeaderSize = opts.maxHeaderSize ?? envInt('LOCALCLOUD_MAX_HEADER_SIZE', 32 * 1024);
    this.reconnectGraceMs = opts.reconnectGraceMs ?? WAIT_FOR_RECONNECT_MS;
    this.sessions = new Set();
    this.sessionsByIp = new Map(); // ip -> count
    this.tunnels = new Map();
    this.polls = new Map();
    this.upgraded = new Set(); // browser sockets piped through tunnels
    this.wss = new WebSocketServer({ noServer: true, perMessageDeflate: false, maxPayload: 64 * 1024 * 1024 });
    this.gc = setInterval(() => this.collect(), 60_000);
    this.gc.unref();
  }

  // ---------- URLs & request metadata ----------

  publicProto(req) {
    const xf = this.trustProxy && req.headers['x-forwarded-proto'];
    if (xf) return String(xf).split(',')[0].trim();
    return req.socket.encrypted ? 'https' : 'http';
  }

  clientIp(req) {
    const xf = this.trustProxy && (req.headers['fly-client-ip'] || req.headers['cf-connecting-ip'] || req.headers['x-forwarded-for']);
    if (xf) return String(xf).split(',')[0].trim();
    return req.socket.remoteAddress || '';
  }

  baseUrlFor(req) {
    if (this.publicUrl) return this.publicUrl;
    return `${this.publicProto(req)}://${req.headers.host}`;
  }

  tunnelUrl(id, baseUrl) {
    if (this.routing === 'subdomain') return `${this.insecure ? 'http' : 'https'}://${id}.${this.domain}`;
    return `${baseUrl}${API}t/${id}`;
  }

  accessUrl(id, token, baseUrl) {
    if (this.routing === 'subdomain') return `${this.tunnelUrl(id, baseUrl)}/?${ACCESS_PARAM}=${token}`;
    return `${this.tunnelUrl(id, baseUrl)}?${ACCESS_PARAM}=${token}`;
  }

  publicOrigin(id, req) {
    if (this.routing === 'subdomain') return `${this.insecure ? 'http' : 'https'}://${id}.${this.domain}`;
    return this.baseUrlFor(req);
  }

  /** Which tunnel (if any) does this request target? */
  route(req) {
    const host = String(req.headers.host || '').toLowerCase();
    if (this.domain) {
      const domainHasPort = this.domain.includes(':');
      const h = domainHasPort ? host : host.replace(/:\d+$/, '');
      const suffix = '.' + this.domain;
      if (h.endsWith(suffix)) {
        const label = h.slice(0, -suffix.length);
        if (label && !label.includes('.')) return { id: label, via: 'host' };
      }
    }
    if (this.routing === 'cookie' && !req.url.startsWith(API)) {
      const id = parseCookies(req.headers.cookie)[ROUTE_COOKIE];
      if (id) return { id, via: 'cookie' };
    }
    return null;
  }

  // ---------- HTTP handling ----------

  handleRequest(req, res) {
    this.dispatch(req, res).catch((err) => {
      this.log(`error handling ${req.method} ${req.url}: ${err.stack || err.message}`);
      if (!res.headersSent && !res.destroyed) res.writeHead(500, { 'content-type': 'text/plain' });
      if (!res.writableEnded) res.end('localcloud relay error\n');
    });
  }

  async dispatch(req, res) {
    const route = this.route(req);
    if (route) return this.handleTunnelRequest(route, req, res);
    if (req.url.startsWith(API)) return this.handleApi(req, res);
    const path = req.url.split('?')[0];
    if (path === '/' || path === '/index.html') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(landingPage({ relayUrl: this.baseUrlFor(req), version: VERSION, routing: this.routing }));
    }
    if (path === '/robots.txt') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      return res.end('User-agent: *\nDisallow: /\n');
    }
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found\n');
  }

  async handleApi(req, res) {
    const url = new URL(req.url, 'http://relay');
    const path = url.pathname.slice(API.length - 1);
    try {
      if (path === '/health') {
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ ok: true, service: 'localcloud', version: VERSION, protocol: PROTOCOL_VERSION, routing: this.routing, tunnels: this.tunnels.size }));
      }
      if (path === '/http/session' && req.method === 'POST') {
        req.resume();
        if (!this.admit(req)) return res.writeHead(429, { 'content-type': 'text/plain', 'retry-after': '10' }).end('too many connections from your address\n');
        const sid = randomToken(24);
        const transport = new PollTransport(sid);
        this.polls.set(sid, transport);
        transport.once('close', () => this.polls.delete(sid));
        this.attach(transport, req);
        res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        return res.end(JSON.stringify({ sid, hold: POLL_HOLD_MS }));
      }
      if ((path === '/http/up' || path === '/http/down' || path === '/http/close') && req.method === 'POST') {
        const transport = this.polls.get(url.searchParams.get('sid') || '');
        if (!transport) {
          req.resume();
          return res.writeHead(410, { 'cache-control': 'no-store' }).end();
        }
        if (path === '/http/down') {
          req.resume();
          return transport.handleDown(req, res, Number(url.searchParams.get('ack') || 0));
        }
        if (path === '/http/close') {
          req.resume();
          transport.close();
          return res.writeHead(204).end();
        }
        const body = await readBody(req, MAX_UP_BODY);
        return transport.handleUp(res, Number(url.searchParams.get('seq') || 0), body);
      }
      if (path.startsWith('/t/')) {
        // Cookie routing entry point: /__localcloud/t/<id>?__lc_access=…
        let id;
        try {
          id = decodeURIComponent(path.slice(3)).split('/')[0];
        } catch {
          return this.sendPage(res, 400, notFoundPage(path.slice(3)));
        }
        const tunnel = this.tunnels.get(id);
        if (!tunnel) return this.sendPage(res, 404, notFoundPage(id));
        const cookies = [`${ROUTE_COOKIE}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax${this.cookieSecure(req)}`];
        const token = url.searchParams.get(ACCESS_PARAM);
        if (tunnel.access && token && safeEqual(token, tunnel.access)) cookies.push(this.accessCookie(tunnel, req));
        res.writeHead(302, { location: '/', 'set-cookie': cookies, 'cache-control': 'no-store' });
        return res.end();
      }
      if (path === '/exit') {
        res.writeHead(302, { location: '/', 'set-cookie': `${ROUTE_COOKIE}=; Path=/; Max-Age=0` });
        return res.end();
      }
      if (path === '/ask') {
        // Caddy on-demand TLS: only issue certificates for live tunnels.
        const domain = String(url.searchParams.get('domain') || '').toLowerCase();
        const ok = domain === this.domain || (this.domain && domain.endsWith('.' + this.domain) && this.tunnels.has(domain.slice(0, -this.domain.length - 1)));
        return res.writeHead(ok ? 200 : 404).end();
      }
      res.writeHead(404, { 'content-type': 'text/plain' });
      res.end('unknown localcloud endpoint\n');
    } catch (err) {
      if (!res.headersSent) res.writeHead(err.status || 500, { 'content-type': 'text/plain' });
      res.end(`${err.message}\n`);
    }
  }

  cookieSecure(req) {
    return this.publicProto(req) === 'https' ? '; Secure' : '';
  }

  accessCookie(tunnel, req) {
    return `${ACCESS_COOKIE}_${tunnel.id.replace(/[^a-z0-9]/g, '_')}=${tunnel.access}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${this.cookieSecure(req)}`;
  }

  /** Access control. Returns true when the request may continue. */
  authorize(tunnel, req, res) {
    if (tunnel.access) {
      const url = new URL(req.url, 'http://x');
      const token = url.searchParams.get(ACCESS_PARAM);
      if (token && safeEqual(token, tunnel.access)) {
        url.searchParams.delete(ACCESS_PARAM);
        const location = url.pathname + (url.search || '');
        if (res) {
          res.writeHead(302, { location, 'set-cookie': this.accessCookie(tunnel, req), 'cache-control': 'no-store' });
          res.end();
        }
        return false;
      }
      const cookie = parseCookies(req.headers.cookie)[`${ACCESS_COOKIE}_${tunnel.id.replace(/[^a-z0-9]/g, '_')}`];
      if (!cookie || !safeEqual(cookie, tunnel.access)) {
        if (res) this.sendPage(res, 401, privatePage(), req);
        return false;
      }
    }
    if (tunnel.basicAuth) {
      const header = String(req.headers.authorization || '');
      const given = header.startsWith('Basic ') ? Buffer.from(header.slice(6), 'base64').toString() : '';
      if (!safeEqual(given, tunnel.basicAuth)) {
        if (res) {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="localcloud", charset="UTF-8"', 'content-type': 'text/plain' });
          res.end('authentication required\n');
        }
        return false;
      }
    }
    return true;
  }

  sendPage(res, status, html, req) {
    if (req && !wantsHtml(req)) {
      res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(`localcloud: ${http.STATUS_CODES[status] || 'error'}\n`);
    }
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    res.end(html);
  }

  sendUpstreamError(req, res, tunnel, code, message) {
    const status = code === 'ETIMEDOUT' ? 504 : 502;
    if (wantsHtml(req)) {
      res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(upstreamDownPage(tunnel.id, tunnel.port ?? '?', code || message));
    }
    res.writeHead(status, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
    res.end(`localcloud: the local server on port ${tunnel.port ?? '?'} did not respond (${code || message || 'error'})\n`);
  }

  waitOnline(tunnel, ms) {
    if (tunnel.session) return Promise.resolve(tunnel.session);
    return new Promise((resolve) => {
      const done = (s) => {
        clearTimeout(timer);
        resolve(s);
      };
      const timer = setTimeout(() => {
        const i = tunnel.waiters.indexOf(done);
        if (i >= 0) tunnel.waiters.splice(i, 1);
        resolve(null);
      }, ms);
      tunnel.waiters.push(done);
    });
  }

  async handleTunnelRequest(route, req, res) {
    const tunnel = this.tunnels.get(route.id);
    if (!tunnel) {
      req.resume();
      if (route.via === 'cookie') {
        // Stale routing cookie: forget it and show the relay instead.
        res.writeHead(302, { location: '/', 'set-cookie': `${ROUTE_COOKIE}=; Path=/; Max-Age=0` });
        return res.end();
      }
      return this.sendPage(res, 404, notFoundPage(route.id), req);
    }
    if (!this.authorize(tunnel, req, res)) return req.resume();
    if (req.headers['x-localcloud-probe'] && !tunnel.session) {
      req.resume();
      return res.writeHead(503).end();
    }
    return this.forwardWhenOnline(tunnel, req, res, {}, req.headers['x-localcloud-probe'] ? 0 : this.reconnectGraceMs);
  }

  async forwardWhenOnline(tunnel, req, res, opts, wait = this.reconnectGraceMs) {
    const session = await this.waitOnline(tunnel, wait);
    if (res.destroyed) return; // the browser gave up while we waited
    if (!session) {
      req.resume();
      return this.sendPage(res, 503, offlinePage(tunnel.id), req);
    }
    session.forwardHttp(tunnel, req, res, opts);
  }

  handleUpgrade(req, socket, head) {
    socket.on('error', noop);
    this.dispatchUpgrade(req, socket, head).catch((err) => {
      this.log(`error handling upgrade ${req.url}: ${err.stack || err.message}`);
      socket.destroy();
    });
  }

  async dispatchUpgrade(req, socket, head) {
    const route = this.route(req);
    if (!route) {
      if (req.url.split('?')[0] === `${API}ws`) {
        if (!this.admit(req)) {
          socket.end('HTTP/1.1 429 Too Many Requests\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
          return;
        }
        this.wss.handleUpgrade(req, socket, head, (ws) => this.attach(new WsTransport(ws), req));
        return;
      }
      return socket.destroy();
    }
    const tunnel = this.tunnels.get(route.id);
    if (!tunnel) return socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    if (!this.authorize(tunnel, req, null)) return socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    const session = await this.waitOnline(tunnel, this.reconnectGraceMs);
    if (socket.destroyed) return;
    if (!session) {
      socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    session.forwardUpgrade(tunnel, req, socket, head);
  }

  /** Per-IP connection cap, checked before a client transport is created. */
  admit(req) {
    const ip = this.clientIp(req);
    if ((this.sessionsByIp.get(ip) || 0) < this.maxSessionsPerIp) return true;
    this.log(`refused a client connection from ${ip}: ${this.maxSessionsPerIp} already open`);
    return false;
  }

  attach(transport, req) {
    const session = new Session(this, transport, this.clientIp(req));
    session.baseUrl = this.baseUrlFor(req);
    this.sessions.add(session);
    this.sessionsByIp.set(session.remote, (this.sessionsByIp.get(session.remote) || 0) + 1);
    return session;
  }

  detach(session) {
    if (!this.sessions.delete(session)) return;
    const n = (this.sessionsByIp.get(session.remote) || 1) - 1;
    if (n > 0) this.sessionsByIp.set(session.remote, n);
    else this.sessionsByIp.delete(session.remote);
  }

  collect() {
    const now = Date.now();
    for (const [id, t] of this.tunnels) {
      if (!t.session && t.offlineSince && now - t.offlineSince > RESERVATION_MS) {
        for (const w of t.waiters.splice(0)) w(null);
        this.tunnels.delete(id);
      }
    }
  }

  // ---------- lifecycle ----------

  /** @param {{port?: number, host?: string, tlsCert?: string, tlsKey?: string}} [opts] */
  listen({ port = 8080, host = '0.0.0.0', tlsCert, tlsKey } = {}) {
    const handler = (req, res) => this.handleRequest(req, res);
    const serverOpts = { maxHeaderSize: this.maxHeaderSize };
    this.server = tlsCert
      ? https.createServer({ ...serverOpts, cert: fs.readFileSync(tlsCert), key: fs.readFileSync(tlsKey) }, handler)
      : http.createServer(serverOpts, handler);
    this.server.keepAliveTimeout = 65_000;
    this.server.headersTimeout = 66_000;
    this.server.requestTimeout = 0; // long polls and streaming responses
    this.server.on('upgrade', (req, socket, head) => this.handleUpgrade(req, socket, head));
    this.server.on('clientError', (err, socket) => {
      if (!socket.writable) return socket.destroy();
      const status = err.code === 'HPE_HEADER_OVERFLOW' ? '431 Request Header Fields Too Large' : '400 Bad Request';
      socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    });
    return new Promise((resolve, reject) => {
      this.server.once('error', reject);
      this.server.listen(port, host, () => {
        this.server.off('error', reject);
        resolve(this.server.address());
      });
    });
  }

  async close() {
    clearInterval(this.gc);
    for (const c of this.wss.clients) c.terminate();
    for (const s of [...this.sessions]) s.close();
    for (const p of [...this.polls.values()]) p.close();
    for (const s of this.upgraded) s.destroy();
    if (this.server) {
      this.server.closeAllConnections?.();
      await new Promise((r) => this.server.close(() => r()));
    }
  }
}
