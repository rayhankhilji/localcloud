// The localcloud client: one connection to the relay, any number of tunnels.
// Reconnects forever with backoff and keeps every tunnel's URL stable.

import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import os from 'node:os';
import { PROTOCOL_VERSION, T, decodeAck, decodeFrame, encodeFrame, parseJson } from '../protocol.js';
import { VERSION } from '../version.js';
import { forward, parseTarget } from './forward.js';
import { HttpClientTransport, WsClientTransport } from './transports.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class FatalError extends Error {}

export class Client extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.relay           relay base URL, e.g. https://localcloud.dev
   * @param {string} [opts.token]         relay access token, if the relay requires one
   * @param {'auto'|'ws'|'http'} [opts.transport]
   * @param {string|null} [opts.proxy]    override HTTPS_PROXY (null disables)
   * @param {string} [opts.noProxy]       override NO_PROXY
   */
  constructor(opts) {
    super();
    if (!opts?.relay) throw new FatalError('no relay configured');
    this.relay = opts.relay.replace(/\/$/, '');
    this.token = opts.token || undefined;
    this.transportMode = opts.transport || 'auto';
    this.netOpts = {};
    if (opts.proxy !== undefined) this.netOpts.proxy = opts.proxy;
    if (opts.noProxy !== undefined) this.netOpts.noProxy = opts.noProxy;
    this.secret = opts.secret || crypto.randomBytes(24).toString('base64url');
    this.tunnels = new Map(); // key -> tunnel
    this.byId = new Map(); // relay id -> tunnel
    this.streams = new Map();
    this.pendingOpens = new Map();
    this.reqId = 0;
    this.transport = null;
    this.connected = false;
    this.closed = false;
    this.stickyHttp = this.transportMode === 'http';
    this.lastError = null;
    this.on('error', () => {}); // errors are reported via 'status'
  }

  get status() {
    return {
      relay: this.relay,
      connected: this.connected,
      transport: this.transport?.kind || null,
      error: this.lastError,
      tunnels: [...this.tunnels.values()].map((t) => this.describe(t)),
    };
  }

  describe(t) {
    return { key: t.key, port: t.target.port, target: t.spec, id: t.id, url: t.url, accessUrl: t.accessUrl, online: t.online, name: t.name || null, protect: !!t.protect };
  }

  /** Start connecting in the background. Resolves after the first successful handshake. */
  start() {
    if (!this.running) {
      this.running = this.loop();
      this.firstConnect = new Promise((resolve, reject) => {
        this._resolveFirst = resolve;
        this._rejectFirst = reject;
      });
      this.firstConnect.catch(() => {});
    }
    return this.firstConnect;
  }

  async loop() {
    let attempt = 0;
    while (!this.closed) {
      let transport;
      try {
        transport = await this.connectTransport();
        await this.handshake(transport);
      } catch (err) {
        transport?.close();
        this.lastError = err.message;
        this.emit('status', { state: 'error', error: err });
        if (err instanceof FatalError) {
          this._rejectFirst?.(err);
          this.closed = true;
          this.emit('fatal', err);
          return;
        }
        attempt++;
        await sleep(Math.min(10_000, 400 * 2 ** Math.min(attempt, 5)) + Math.random() * 300);
        continue;
      }
      attempt = 0;
      this.lastError = null;
      await this.session(transport);
      if (this.closed) return;
      this.emit('status', { state: 'reconnecting' });
      await sleep(300 + Math.random() * 300);
    }
  }

  async connectTransport() {
    if (this.transportMode === 'ws') return WsClientTransport.connect(this.relay, this.netOpts);
    if (this.stickyHttp) return HttpClientTransport.connect(this.relay, this.netOpts);
    try {
      const t = await WsClientTransport.connect(this.relay, { ...this.netOpts, timeout: 7000 });
      t.probe = true;
      return t;
    } catch (wsErr) {
      try {
        const t = await HttpClientTransport.connect(this.relay, this.netOpts);
        this.stickyHttp = true;
        this.emit('status', { state: 'fallback', error: wsErr });
        return t;
      } catch (httpErr) {
        // Report the more informative error (a proxy refusal beats a timeout).
        throw httpErr.code === 'EPROXY' || !wsErr.message ? httpErr : wsErr;
      }
    }
  }

  handshake(transport) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        if (transport.kind === 'ws' && this.transportMode === 'auto') this.stickyHttp = true; // upgrade "worked" but frames don't flow
        reject(new Error('relay did not answer the handshake'));
      }, 10_000);
      const onFrame = (buf) => {
        let f;
        try {
          f = decodeFrame(buf);
        } catch {
          return;
        }
        if (f.type !== T.WELCOME) return;
        cleanup();
        const msg = parseJson(f.payload);
        if (!msg.ok) return reject(new FatalError(msg.error || 'relay refused the connection'));
        this.relayInfo = msg;
        resolve(msg);
      };
      const onClose = () => {
        cleanup();
        reject(new Error('connection closed during handshake'));
      };
      const cleanup = () => {
        clearTimeout(timer);
        transport.off('frame', onFrame);
        transport.off('close', onClose);
      };
      transport.on('frame', onFrame);
      transport.once('close', onClose);
      transport.send(
        encodeFrame(T.HELLO, 0, {
          v: PROTOCOL_VERSION,
          token: this.token,
          client: { version: VERSION, platform: process.platform, hostname: os.hostname(), agent: detectAgent() },
        }),
      );
    });
  }

  send(type, sid, payload) {
    this.transport?.send(encodeFrame(type, sid, payload));
  }

  async session(transport) {
    this.transport = transport;
    this.connected = true;
    let lastRx = Date.now();
    const onFrame = (buf) => {
      lastRx = Date.now();
      this.onFrame(buf);
    };
    transport.on('frame', onFrame);
    const closed = new Promise((r) => transport.once('close', r));
    const heartbeat = setInterval(() => {
      if (Date.now() - lastRx > 45_000) return transport.close();
      this.send(T.PING, 0);
    }, 15_000);

    this.emit('status', { state: 'connected', transport: transport.kind });
    this._resolveFirst?.(this.relayInfo);
    for (const t of this.tunnels.values()) this.openTunnel(t).catch(() => {});

    await closed;
    clearInterval(heartbeat);
    transport.off('frame', onFrame);
    this.transport = null;
    this.connected = false;
    for (const s of this.streams.values()) s.onAbort();
    this.streams.clear();
    for (const t of this.tunnels.values()) t.online = false;
    for (const p of this.pendingOpens.values()) p.reject(new Error('disconnected'));
    this.pendingOpens.clear();
    this.emit('status', { state: 'disconnected' });
  }

  onFrame(buf) {
    let f;
    try {
      f = decodeFrame(buf);
    } catch {
      return;
    }
    switch (f.type) {
      case T.PING:
        return this.send(T.PONG, 0);
      case T.OPENED: {
        const msg = parseJson(f.payload);
        const p = this.pendingOpens.get(msg.reqId);
        if (!p) return;
        this.pendingOpens.delete(msg.reqId);
        return msg.ok ? p.resolve(msg) : p.reject(Object.assign(new Error(msg.error), { code: msg.code }));
      }
      case T.REQ: {
        const req = parseJson(f.payload);
        const tunnel = this.byId.get(req.tunnel);
        if (!tunnel) return this.send(T.ABORT, f.sid, { code: 'ENOTUNNEL', message: 'tunnel not active on this client' });
        const sid = f.sid;
        const stream = forward(
          this,
          sid,
          req,
          tunnel,
          (info) => this.emit('request', { ...info, tunnel: tunnel.id, port: tunnel.target.port }),
          () => {
            if (this.streams.get(sid) === stream) this.streams.delete(sid);
          },
        );
        this.streams.set(f.sid, stream);
        return;
      }
      case T.DATA:
        return this.streams.get(f.sid)?.onData(f.payload);
      case T.END:
        return this.streams.get(f.sid)?.onEnd();
      case T.ABORT: {
        const s = this.streams.get(f.sid);
        this.streams.delete(f.sid);
        return s?.onAbort();
      }
      case T.ACK:
        return this.streams.get(f.sid)?.out.ack(decodeAck(f.payload));
      case T.NOTICE:
        return this.emit('notice', parseJson(f.payload).message);
    }
  }

  waitConnected() {
    if (this.connected) return Promise.resolve();
    return new Promise((resolve, reject) => {
      const onStatus = (s) => {
        if (s.state !== 'connected') return;
        cleanup();
        resolve();
      };
      const onFatal = (err) => {
        cleanup();
        reject(err);
      };
      const cleanup = () => {
        this.off('status', onStatus);
        this.off('fatal', onFatal);
      };
      this.on('status', onStatus);
      this.on('fatal', onFatal);
    });
  }

  openTunnel(t) {
    if (!this.connected) return Promise.reject(new Error('not connected'));
    if (t.opening) return t.opening;
    t.opening = this._open(t).finally(() => (t.opening = null));
    return t.opening;
  }

  _open(t) {
    const reqId = ++this.reqId;
    const p = new Promise((resolve, reject) => this.pendingOpens.set(reqId, { resolve, reject }));
    this.send(T.OPEN, 0, { reqId, name: t.id || t.name, secret: this.secret, port: t.target.port, protect: !!t.protect, basicAuth: t.basicAuth });
    return p.then(
      (msg) => {
        if (t.id && t.id !== msg.id) this.byId.delete(t.id);
        const changed = t.url && t.url !== msg.url;
        t.id = msg.id;
        t.url = msg.url;
        t.accessUrl = msg.accessUrl;
        t.online = true;
        this.byId.set(t.id, t);
        this.emit('tunnel', this.describe(t), { changed });
        return this.describe(t);
      },
      async (err) => {
        // Our auto-assigned name was lost (relay restarted & reused it): get a new one.
        if (err.code === 'name_taken' && t.id && !t.name) {
          this.byId.delete(t.id);
          t.id = null;
          return this._open(t);
        }
        t.lastError = err.message;
        throw err;
      },
    );
  }

  /**
   * Share a local port (or URL). Resolves with the public URL.
   * @param {string|number} spec
   * @param {{name?: string, protect?: boolean, basicAuth?: string, hostHeader?: string}} [opts]
   */
  async share(spec, opts = {}) {
    const target = parseTarget(spec);
    const existing = this.tunnels.get(target.key);
    if (existing && existing.online && !opts.name && !!opts.protect === !!existing.protect) return this.describe(existing);
    const t = existing || { key: target.key, spec: String(spec), target, id: null, url: null, online: false };
    if (existing && opts.name && opts.name !== existing.name) {
      this.send(T.CLOSE_TUNNEL, 0, { id: existing.id });
      this.byId.delete(existing.id);
      t.id = null;
    }
    t.name = opts.name || t.name || null;
    t.protect = !!opts.protect;
    t.basicAuth = opts.basicAuth;
    t.hostHeader = opts.hostHeader;
    this.tunnels.set(t.key, t);
    this.start();
    try {
      await this.waitConnected();
      return await this.openTunnel(t);
    } catch (err) {
      if (!existing) this.tunnels.delete(t.key);
      throw err;
    }
  }

  unshare(spec) {
    let key;
    try {
      key = parseTarget(spec).key;
    } catch {
      return false;
    }
    const t = this.tunnels.get(key);
    if (!t) return false;
    this.tunnels.delete(key);
    if (t.id) {
      this.byId.delete(t.id);
      this.send(T.CLOSE_TUNNEL, 0, { id: t.id });
    }
    this.emit('unshared', this.describe(t));
    return true;
  }

  async close() {
    this.closed = true;
    for (const t of this.tunnels.values()) if (t.id) this.send(T.CLOSE_TUNNEL, 0, { id: t.id });
    await sleep(this.transport?.kind === 'http' ? 150 : 20);
    this.transport?.close();
    this._rejectFirst?.(new Error('closed'));
  }
}

/** Best effort guess of which coding agent we're running under (for relay stats / UX). */
export function detectAgent() {
  const e = process.env;
  if (e.CLAUDE_CODE_REMOTE === 'true') return 'claude-code-web';
  if (e.CLAUDECODE) return 'claude-code';
  if (e.CODEX_SANDBOX || e.CODEX_PROXY_CERT || e.CODEX_HOME) return 'codex';
  if (e.CURSOR_AGENT || e.CURSOR_TRACE_ID) return 'cursor';
  if (e.DEVIN || e.DEVIN_SESSION_ID) return 'devin';
  if (e.REPL_ID) return 'replit';
  if (e.CODESPACES) return 'codespaces';
  if (e.GITPOD_WORKSPACE_ID) return 'gitpod';
  return 'unknown';
}
