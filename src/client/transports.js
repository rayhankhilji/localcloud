// Client side transports. Both expose: send(buf), close(), 'frame' and 'close' events.

import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import { createAgent, request } from '../net.js';
import { decodeBatch, encodeBatch } from '../protocol.js';
import { VERSION } from '../version.js';

const UA = `localcloud/${VERSION} (node ${process.version}; ${process.platform})`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function apiUrl(relay, path) {
  const u = new URL(relay);
  const [pathname, query] = path.split('?');
  u.pathname = u.pathname.replace(/\/$/, '') + '/__localcloud' + pathname;
  u.search = query ? `?${query}` : '';
  return u;
}

export class WsClientTransport extends EventEmitter {
  /** @param {string} relay @param {{proxy?: string|null, noProxy?: string, timeout?: number}} [opts] */
  static connect(relay, opts = {}) {
    const url = apiUrl(relay, '/ws');
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
    const agent = createAgent(url, { ...opts, keepAlive: false });
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url, {
        agent,
        perMessageDeflate: false,
        handshakeTimeout: opts.timeout ?? 8000,
        headers: { 'user-agent': UA },
        maxPayload: 64 * 1024 * 1024,
      });
      const fail = (err) => {
        cleanup();
        // terminate() emits a late 'error' that would otherwise crash the process.
        ws.on('error', () => {});
        try {
          ws.terminate();
        } catch {}
        reject(err);
      };
      const onError = (err) => fail(err);
      const onUnexpected = (_req, res) => fail(Object.assign(new Error(`websocket upgrade rejected: HTTP ${res.statusCode}`), { status: res.statusCode }));
      const onOpen = () => {
        cleanup();
        resolve(new WsClientTransport(ws));
      };
      const cleanup = () => {
        ws.off('error', onError);
        ws.off('unexpected-response', onUnexpected);
        ws.off('open', onOpen);
      };
      ws.on('error', onError);
      ws.on('unexpected-response', onUnexpected);
      ws.on('open', onOpen);
    });
  }

  constructor(ws) {
    super();
    this.kind = 'ws';
    this.ws = ws;
    ws.on('message', (data, isBinary) => {
      if (isBinary) this.emit('frame', Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data));
    });
    ws.on('error', () => {});
    ws.once('close', () => this.emit('close'));
  }

  send(buf) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(buf);
  }

  /** Resolves once queued frames have been written (or after `ms`). */
  async drain(ms = 1000) {
    const end = Date.now() + ms;
    while (this.ws.readyState === WebSocket.OPEN && this.ws.bufferedAmount > 0 && Date.now() < end) await sleep(10);
  }

  close() {
    try {
      // A clean close frame lets the relay notice immediately; terminate if it doesn't answer.
      if (this.ws.readyState === WebSocket.OPEN) {
        this.ws.close();
        setTimeout(() => this.ws.terminate(), 1000).unref();
      } else this.ws.terminate();
    } catch {}
  }
}

/**
 * HTTPS long-polling: one held "down" request at a time for relay → client
 * frames and sequenced "up" POSTs for client → relay frames. Survives proxies
 * that refuse WebSocket upgrades or buffer streaming responses.
 */
export class HttpClientTransport extends EventEmitter {
  /** @param {string} relay @param {{proxy?: string|null, noProxy?: string, timeout?: number}} [opts] */
  static async connect(relay, opts = {}) {
    const url = apiUrl(relay, '/http/session');
    const agent = createAgent(url, opts);
    const res = await request(url, { method: 'POST', agent, headers: { 'user-agent': UA, 'content-length': 0 }, timeout: opts.timeout ?? 10_000 });
    if (res.status !== 200) throw Object.assign(new Error(`relay refused long-poll session: HTTP ${res.status}`), { status: res.status });
    const { sid, hold } = JSON.parse(res.body.toString());
    return new HttpClientTransport(relay, sid, agent, hold || 15_000);
  }

  constructor(relay, sid, agent, hold) {
    super();
    this.kind = 'http';
    this.relay = relay;
    this.sid = sid;
    this.agent = agent;
    this.hold = hold;
    this.queue = [];
    this.upSeq = 0;
    this.downAck = 0;
    this.flushing = false;
    this.closed = false;
    this.downLoop();
  }

  send(buf) {
    if (this.closed) return;
    this.queue.push(buf);
    if (!this.flushing) this.flush();
  }

  async flush() {
    this.flushing = true;
    try {
      while (this.queue.length && !this.closed) {
        let take = 0;
        let bytes = 0;
        while (take < this.queue.length && (take === 0 || bytes + this.queue[take].length < 4 * 1024 * 1024)) {
          bytes += this.queue[take].length;
          take++;
        }
        const body = encodeBatch(this.queue.splice(0, take));
        const seq = ++this.upSeq;
        const url = apiUrl(this.relay, `/http/up?sid=${encodeURIComponent(this.sid)}&seq=${seq}`);
        let failures = 0;
        for (;;) {
          if (this.closed) return;
          try {
            const res = await request(url, {
              method: 'POST',
              agent: this.agent,
              body,
              headers: { 'content-type': 'application/octet-stream', 'content-length': body.length, 'user-agent': UA },
              timeout: 30_000,
            });
            if (res.status === 204 || res.status === 200) break;
            if (res.status === 410 || res.status === 409) return this.close();
            throw new Error(`HTTP ${res.status}`);
          } catch {
            if (++failures > 6) return this.close();
            await sleep(Math.min(250 * 2 ** failures, 4000));
          }
        }
      }
    } finally {
      this.flushing = false;
    }
  }

  async downLoop() {
    let failures = 0;
    while (!this.closed) {
      const url = apiUrl(this.relay, `/http/down?sid=${encodeURIComponent(this.sid)}&ack=${this.downAck}`);
      try {
        const res = await request(url, {
          method: 'POST',
          agent: this.agent,
          headers: { 'content-length': 0, 'user-agent': UA },
          timeout: this.hold + 15_000,
        });
        if (res.status === 410 || res.status === 404) return this.close();
        if (res.status !== 200) throw new Error(`HTTP ${res.status}`);
        failures = 0;
        const seq = Number(res.headers['x-lc-seq'] || 0);
        if (seq && seq > this.downAck) {
          this.downAck = seq;
          for (const f of decodeBatch(res.body)) {
            if (this.closed) return;
            this.emit('frame', f);
          }
        }
      } catch {
        if (this.closed) return;
        if (++failures > 6) return this.close();
        await sleep(Math.min(250 * 2 ** failures, 4000));
      }
    }
  }

  /** Resolves once queued frames have been posted (or after `ms`). */
  async drain(ms = 1000) {
    const end = Date.now() + ms;
    while (!this.closed && (this.queue.length || this.flushing) && Date.now() < end) await sleep(10);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.queue = [];
    this.emit('close');
    // Tell the relay right away instead of letting the session time out, then drop our sockets.
    const url = apiUrl(this.relay, `/http/close?sid=${encodeURIComponent(this.sid)}`);
    request(url, { method: 'POST', agent: this.agent, headers: { 'content-length': 0, 'user-agent': UA }, timeout: 2000 })
      .catch(() => {})
      .finally(() => this.agent.destroy());
  }
}
