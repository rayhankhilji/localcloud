// One Durable Object per connected localcloud client. It owns the client's
// transport (a hibernatable WebSocket, or the HTTPS long-poll queues) and
// its tunnels, and turns browser requests into REQ/DATA/END streams.

import { DurableObject } from 'cloudflare:workers';
import { PROTOCOL_VERSION, T, decodeAck, decodeBatch, decodeFrame, encodeBatch, encodeFrame, parseJson } from '../../src/protocol.js';
import { notFoundPage } from '../../src/relay/pages.js';
import {
  INTERNAL,
  POLL_HOLD_MS,
  VERSION,
  WAIT_FOR_RECONNECT_MS,
  accessUrl,
  authorize,
  config,
  forwardHeaders,
  isUpgrade,
  offline,
  safeEqual,
  sendPage,
  text,
  tunnelUrl,
  upstreamError,
} from './common.js';
import { BodyPipe, Outbound, acker } from './flow.js';
import { OP, WsDecoder, closePayload, concatBytes, encodeWsFrame, indexOfHeadEnd, parseClosePayload, parseResponseHead } from './wsframe.js';

const SESSION_IDLE_MS = 45_000;
const LIVENESS_MS = 60_000;
const MAX_TUNNELS_PER_SESSION = 25;
const MAX_UP_BODY = 64 * 1024 * 1024;
const UPGRADE_TIMEOUT_MS = 30_000;
const NULL_BODY = new Set([101, 204, 205, 304]);
const EMPTY = new Uint8Array(0);

// Binary WebSocket messages normally arrive as ArrayBuffer, but may be Blobs
// (standard binaryType). Blobs are read asynchronously, so keep them in order.
let blobChain = Promise.resolve();
function toBytes(data, cb) {
  if (data instanceof ArrayBuffer) return cb(new Uint8Array(data));
  if (ArrayBuffer.isView(data)) return cb(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    blobChain = blobChain.then(() => data.arrayBuffer()).then((ab) => cb(new Uint8Array(ab)), () => {});
  }
}

/** Server side of the HTTPS long-poll transport, held in DO memory. */
class PollTransport {
  constructor(token, onFrame, onClose) {
    this.kind = 'http';
    this.token = token;
    this.onFrame = onFrame;
    this.onClose = onClose;
    this.queue = [];
    this.pending = null; // {resolve, timer}
    this.lastBatch = null;
    this.downSeq = 0;
    this.upSeq = 0;
    this.closed = false;
    this.scheduled = false;
    this.lastSeen = Date.now();
    this.watchdog = setInterval(() => {
      if (!this.pending && Date.now() - this.lastSeen > SESSION_IDLE_MS) this.close();
    }, 5_000);
  }

  send(buf) {
    if (this.closed) return;
    this.queue.push(buf);
    if (this.pending && !this.scheduled) {
      this.scheduled = true;
      setTimeout(() => {
        this.scheduled = false;
        this.flush();
      }, 0);
    }
  }

  static respond(seq, body) {
    return new Response(body, {
      status: 200,
      headers: { 'content-type': 'application/octet-stream', 'cache-control': 'no-store', 'x-lc-seq': String(seq) },
    });
  }

  flush() {
    const p = this.pending;
    if (!p || !this.queue.length) return;
    this.pending = null;
    clearTimeout(p.timer);
    let take = 0;
    let bytes = 0;
    while (take < this.queue.length && (take === 0 || bytes + this.queue[take].length < 4 * 1024 * 1024)) {
      bytes += this.queue[take].length;
      take++;
    }
    const body = encodeBatch(this.queue.splice(0, take));
    const seq = ++this.downSeq;
    this.lastBatch = { seq, body };
    p.resolve(PollTransport.respond(seq, body));
  }

  handleDown(ack) {
    this.lastSeen = Date.now();
    if (this.closed) return new Response(null, { status: 410 });
    if (this.pending) {
      // A newer poll supersedes the old one.
      clearTimeout(this.pending.timer);
      this.pending.resolve(PollTransport.respond(0, EMPTY));
      this.pending = null;
    }
    if (this.lastBatch) {
      if (ack < this.lastBatch.seq) return PollTransport.respond(this.lastBatch.seq, this.lastBatch.body);
      this.lastBatch = null;
    }
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        if (this.pending?.resolve === resolve) {
          this.pending = null;
          this.lastSeen = Date.now();
          resolve(PollTransport.respond(0, EMPTY));
        }
      }, POLL_HOLD_MS);
      this.pending = { resolve, timer };
      if (this.queue.length) this.flush();
    });
  }

  handleUp(seq, body) {
    this.lastSeen = Date.now();
    if (this.closed) return new Response(null, { status: 410 });
    if (seq <= this.upSeq) return new Response(null, { status: 204 }); // duplicate retry
    if (seq !== this.upSeq + 1) return new Response(null, { status: 409 });
    let frames;
    try {
      frames = decodeBatch(body);
    } catch {
      return new Response(null, { status: 400 });
    }
    this.upSeq = seq;
    for (const f of frames) this.onFrame(f);
    return new Response(null, { status: 204 });
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.watchdog);
    if (this.pending) {
      clearTimeout(this.pending.timer);
      this.pending.resolve(new Response(null, { status: 410 }));
      this.pending = null;
    }
    this.onClose();
  }
}

export class Session extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.cfg = config(env);
    this.selfId = ctx.id.toString();
    this.streams = new Map(); // sid -> stream
    this.nextSid = 1;
    this.poll = null;
    this.lastRx = 0;
    this.persistedRx = 0;
    this.dead = false;
    this.tunnels = new Map(); // id -> {id, port, access, basicAuth}
    this.meta = null; // {kind, ready, baseUrl, remote}
    ctx.blockConcurrencyWhile(async () => {
      // After hibernation the class is rebuilt from scratch: reload state.
      const saved = await ctx.storage.get(['tunnels', 'meta']);
      this.tunnels = new Map(saved.get('tunnels') || []);
      this.meta = saved.get('meta') || null;
    });
  }

  registry() {
    return this.env.REGISTRY.get(this.env.REGISTRY.idFromName('registry'));
  }

  ws() {
    return this.ctx.getWebSockets()[0] || null;
  }

  transportAlive() {
    if (this.dead) return false;
    if (this.poll) return !this.poll.closed;
    const ws = this.ws();
    return !!ws && ws.readyState === WebSocket.OPEN;
  }

  sendRaw(buf) {
    if (this.poll) return this.poll.send(buf);
    const ws = this.ws();
    if (ws && ws.readyState === WebSocket.OPEN) {
      try {
        ws.send(buf);
      } catch {}
    }
  }

  send(type, sid, payload) {
    this.sendRaw(encodeFrame(type, sid, payload));
  }

  saveTunnels() {
    return this.ctx.storage.put('tunnels', [...this.tunnels]);
  }

  // ---------- entry points ----------

  async fetch(request) {
    const op = request.headers.get(INTERNAL + 'op');
    switch (op) {
      case 'ws':
        return this.acceptClientWebSocket(request);
      case 'poll-session':
        return this.createPollSession(request);
      case 'poll-up':
      case 'poll-down': {
        const token = request.headers.get(INTERNAL + 'token') || '';
        if (!this.poll || this.poll.closed || !safeEqual(token, this.poll.token)) return new Response(null, { status: 410, headers: { 'cache-control': 'no-store' } });
        const url = new URL(request.url);
        if (op === 'poll-down') return this.poll.handleDown(Number(url.searchParams.get('ack') || 0));
        const len = Number(request.headers.get('content-length') || 0);
        if (len > MAX_UP_BODY) return new Response(null, { status: 413 });
        const body = Buffer.from(await request.arrayBuffer());
        return this.poll.handleUp(Number(url.searchParams.get('seq') || 0), body);
      }
      case 'tunnel':
        return this.handleTunnel(request);
      default:
        return text(400, 'bad internal request\n');
    }
  }

  async startSession(kind, request) {
    this.meta = {
      kind,
      ready: false,
      baseUrl: request.headers.get(INTERNAL + 'base') || '',
      remote: request.headers.get(INTERNAL + 'remote') || '',
    };
    this.lastRx = Date.now();
    await this.ctx.storage.put({ meta: this.meta, rx: this.lastRx });
    await this.ctx.storage.setAlarm(Date.now() + LIVENESS_MS);
  }

  async acceptClientWebSocket(request) {
    if (!isUpgrade(request)) return text(426, 'expected a websocket upgrade\n');
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    // Hibernation API: the DO can be evicted between frames while idle.
    this.ctx.acceptWebSocket(server);
    await this.startSession('ws', request);
    return new Response(null, { status: 101, webSocket: client });
  }

  async createPollSession(request) {
    const token = [...crypto.getRandomValues(new Uint8Array(18))].map((b) => b.toString(16).padStart(2, '0')).join('');
    this.poll = new PollTransport(
      token,
      (buf) => this.onFrame(buf),
      () => this.die(),
    );
    await this.startSession('http', request);
    return new Response(JSON.stringify({ sid: `${this.selfId}.${token}`, hold: POLL_HOLD_MS }), {
      status: 200,
      headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
    });
  }

  // Hibernatable WebSocket handlers.
  async webSocketMessage(ws, message) {
    if (typeof message === 'string') return;
    toBytes(message, (bytes) => this.onFrame(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength)));
  }

  async webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye');
    } catch {}
    await this.die();
  }

  async webSocketError() {
    await this.die();
  }

  async alarm() {
    if (this.dead || !this.meta) return;
    if (!this.transportAlive()) return this.die();
    if (!this.meta.ready) {
      // Connected but never said HELLO.
      this.closeTransport();
      return;
    }
    const rx = this.lastRx || (await this.ctx.storage.get('rx')) || 0;
    if (Date.now() - rx > SESSION_IDLE_MS * 2) {
      try {
        this.ws()?.close(1001, 'idle');
      } catch {}
      this.poll?.close();
      return this.die();
    }
    await this.ctx.storage.setAlarm(Date.now() + LIVENESS_MS);
  }

  /** Called by the registry when another session took over a tunnel. */
  async dropTunnel(id) {
    if (this.tunnels.delete(id)) await this.saveTunnels();
  }

  /** The client is gone: abort streams, park tunnels in the registry, forget everything. */
  async die() {
    if (this.dead) return;
    this.dead = true;
    for (const s of [...this.streams.values()]) s.onAbort({ code: 'ECONNRESET', message: 'tunnel disconnected' });
    this.streams.clear();
    const ids = [...this.tunnels.keys()];
    this.tunnels.clear();
    if (this.poll && !this.poll.closed) this.poll.close();
    try {
      if (ids.length) await this.registry().offline(ids, this.selfId);
    } catch (err) {
      console.log(`registry offline failed: ${err.message}`);
    }
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ---------- protocol ----------

  onFrame(buf) {
    this.lastRx = Date.now();
    if (this.lastRx - this.persistedRx > 30_000) {
      // Survives hibernation so the liveness alarm can tell a silent client from an idle one.
      this.persistedRx = this.lastRx;
      this.ctx.storage.put('rx', this.lastRx).catch(() => {});
    }
    let f;
    try {
      f = decodeFrame(buf);
    } catch {
      return this.closeTransport();
    }
    if (!this.meta?.ready && f.type !== T.HELLO) return this.closeTransport();
    try {
      switch (f.type) {
        case T.HELLO:
          return this.onHello(parseJson(f.payload));
        case T.OPEN:
          return void this.onOpen(parseJson(f.payload)).catch((err) => console.log(`open failed: ${err.stack || err}`));
        case T.CLOSE_TUNNEL:
          return void this.onCloseTunnel(parseJson(f.payload)).catch(() => {});
        case T.PING:
          return this.send(T.PONG, 0);
        case T.PONG:
          return;
        case T.RES:
          return this.streams.get(f.sid)?.onRes?.(parseJson(f.payload));
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
      console.log(`session error: ${err.stack || err}`);
    }
  }

  closeTransport() {
    if (this.poll) return this.poll.close();
    try {
      this.ws()?.close(1002, 'protocol error');
    } catch {}
    this.die();
  }

  onHello(msg) {
    let error = null;
    if (Number(msg.v) !== PROTOCOL_VERSION) error = `protocol mismatch (client v${msg.v}, relay v${PROTOCOL_VERSION}) — update localcloud`;
    else if (this.cfg.token && !safeEqual(msg.token || '', this.cfg.token)) error = 'this relay requires a valid LOCALCLOUD_TOKEN';
    if (error) {
      this.send(T.WELCOME, 0, { ok: false, error });
      setTimeout(() => this.closeTransport(), 200);
      return;
    }
    this.meta = { ...this.meta, ready: true };
    this.ctx.storage.put('meta', this.meta).catch(() => {});
    this.send(T.WELCOME, 0, { ok: true, version: VERSION, routing: this.cfg.routing, transport: this.meta.kind, runtime: 'cloudflare-workers' });
  }

  async onOpen(msg) {
    const reply = (body) => this.send(T.OPENED, 0, { reqId: msg.reqId, ...body });
    if (typeof msg.secret !== 'string' || msg.secret.length < 16) return reply({ ok: false, error: 'invalid secret' });
    if (this.tunnels.size >= MAX_TUNNELS_PER_SESSION && !(msg.name && this.tunnels.has(msg.name))) {
      return reply({ ok: false, error: 'too many tunnels on one connection' });
    }
    const r = await this.registry().claim({
      name: msg.name || undefined,
      secret: msg.secret,
      session: this.selfId,
      port: msg.port,
      protect: !!msg.protect,
      basicAuth: msg.basicAuth,
    });
    if (!r.ok) return reply({ ok: false, error: r.error, code: r.code });
    if (this.dead) return;
    this.tunnels.set(r.id, { id: r.id, port: r.port, access: r.access, basicAuth: r.basicAuth });
    await this.saveTunnels();
    const base = this.meta?.baseUrl || '';
    reply({ ok: true, id: r.id, url: tunnelUrl(this.cfg, r.id, base), accessUrl: r.access ? accessUrl(this.cfg, r.id, r.access, base) : undefined });
  }

  async onCloseTunnel({ id }) {
    if (!this.tunnels.delete(id)) return;
    await this.saveTunnels();
    await this.registry().close(id, this.selfId);
  }

  // ---------- browser traffic ----------

  info(request, tunnel, upgrade, headers) {
    const url = new URL(request.url);
    return {
      tunnel: tunnel.id,
      method: request.method,
      url: url.pathname + url.search,
      headers,
      remote: request.headers.get(INTERNAL + 'remote') || '',
      proto: request.headers.get(INTERNAL + 'proto') || 'https',
      origin: request.headers.get(INTERNAL + 'origin') || url.origin,
      upgrade,
      // A body without a known length arrived chunked (Workers hide transfer-encoding).
      chunked: !upgrade && !!request.body && !request.headers.has('content-length'),
    };
  }

  async handleTunnel(request) {
    const id = request.headers.get(INTERNAL + 'tunnel');
    let tunnel = this.tunnels.get(id);
    if (tunnel && !this.transportAlive()) {
      await this.die();
      tunnel = null;
    }
    if (!tunnel) return this.reroute(request, id);
    const denied = authorize(tunnel, request);
    if (denied) return denied;
    return isUpgrade(request) ? this.forwardUpgrade(tunnel, request) : this.forwardHttp(tunnel, request);
  }

  /** This session no longer serves the tunnel (stale cache or reconnect): find who does. */
  async reroute(request, id) {
    const hop = Number(request.headers.get(INTERNAL + 'hop') || 0);
    const probe = request.headers.has('x-localcloud-probe');
    const r = await this.registry().waitOnline(id, probe || hop >= 2 ? 0 : WAIT_FOR_RECONNECT_MS, this.selfId);
    if (r.missing) return sendPage(404, notFoundPage(id), request);
    const t = r.tunnel;
    const denied = authorize(t, request);
    if (denied) return denied;
    if (!t.session || t.session === this.selfId || hop >= 2) return probe ? new Response(null, { status: 503 }) : offline(request, id);
    const headers = new Headers(request.headers);
    headers.set(INTERNAL + 'hop', String(hop + 1));
    const stub = this.env.SESSION.get(this.env.SESSION.idFromString(t.session));
    return stub.fetch(new Request(request, { headers }));
  }

  /** Forward a normal HTTP request through the tunnel and stream the response back. */
  forwardHttp(tunnel, request) {
    const sid = this.nextSid++;
    const send = (type, payload) => this.send(type, sid, payload);
    const ack = acker(send);
    let done = false;
    let pipe = null;
    let resolve;
    const response = new Promise((r) => (resolve = r));
    const finish = () => {
      done = true;
      this.streams.delete(sid);
    };
    const stream = {
      out: new Outbound(send),
      responded: false,
      onRes: (msg) => {
        if (stream.responded || done) return;
        stream.responded = true;
        let status = Number(msg.status) || 502;
        if (status < 200 || status > 599) status = 502;
        const headers = new Headers();
        for (const [k, v] of msg.headers || []) {
          try {
            headers.append(k, v);
          } catch {}
        }
        const init = { status, statusText: msg.statusText || '', headers };
        // The body is already encoded by the local server: don't let the runtime re-compress it.
        if (headers.has('content-encoding')) init.encodeBody = 'manual';
        if (request.method === 'HEAD' || NULL_BODY.has(status)) return resolve(new Response(null, init));
        pipe = new BodyPipe(ack, () => {
          // The browser went away mid-response.
          if (!done) {
            finish();
            stream.out.cancel();
            send(T.ABORT, { code: 'ECONNRESET', message: 'browser went away' });
          }
        });
        resolve(new Response(pipe.stream, init));
      },
      onData: (chunk) => {
        // Copy: the frame is a view into a transport buffer we don't own.
        if (!pipe || !pipe.push(new Uint8Array(chunk))) ack(chunk.length);
      },
      onEnd: () => {
        if (done) return;
        finish();
        stream.out.cancel(); // the local server is done: stop sending the request body
        if (!stream.responded) return resolve(upstreamError(request, tunnel, 'EPROTO', 'stream ended without a response'));
        pipe?.end();
      },
      onAbort: ({ code, message } = {}) => {
        if (done) return;
        finish();
        stream.out.cancel();
        if (!stream.responded) return resolve(upstreamError(request, tunnel, code, message));
        pipe?.abort(new Error(message || 'aborted'));
      },
    };
    this.streams.set(sid, stream);
    send(T.REQ, this.info(request, tunnel, false, forwardHeaders(request, tunnel)));
    stream.out.pump(request.body, (err) => {
      if (done) return;
      send(T.ABORT, { code: 'ECONNRESET', message: `browser request failed: ${err.message}` });
      stream.onAbort({ code: 'ECONNRESET', message: 'browser went away' });
    });
    return response;
  }

  /**
   * Bridge a browser WebSocket to the local server. Workers terminate the
   * browser's WebSocket, so the relay plays WebSocket *client* towards the
   * local server: the client process writes the upgrade request we describe in
   * REQ, we parse the raw `101` response and the frames that follow, and
   * translate between frames and browser messages.
   */
  forwardUpgrade(tunnel, request) {
    const sid = this.nextSid++;
    const send = (type, payload) => this.send(type, sid, payload);
    const ack = acker(send);
    const out = new Outbound(send);
    const key = btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(16))));
    const headers = forwardHeaders(request, tunnel, { upgrade: true });
    headers.push(['Connection', 'Upgrade'], ['Upgrade', 'websocket'], ['Sec-WebSocket-Version', '13'], ['Sec-WebSocket-Key', key]);

    return new Promise((resolve) => {
      let phase = 'head'; // head -> ws | http
      let head = EMPTY;
      let server = null;
      let decoder = null;
      let httpRes = null;
      let done = false;
      let sentClose = false;
      const timer = setTimeout(() => stream.onAbort({ code: 'ETIMEDOUT', message: 'the local server did not answer the upgrade' }), UPGRADE_TIMEOUT_MS);

      const finish = () => {
        done = true;
        clearTimeout(timer);
        this.streams.delete(sid);
        out.cancel();
      };
      const closeBrowser = (code, reason) => {
        if (!server) return;
        try {
          server.close(code, reason);
        } catch {
          try {
            server.close(1000, reason);
          } catch {}
        }
      };
      const sendFrame = (opcode, payload) => {
        if (!done) out.write(encodeWsFrame(opcode, payload, { mask: true }));
      };

      const startWs = (parsed, rest) => {
        phase = 'ws';
        clearTimeout(timer);
        const pair = new WebSocketPair();
        const [client, srv] = Object.values(pair);
        server = srv;
        server.accept();
        try {
          server.binaryType = 'arraybuffer'; // newer compatibility dates default to Blob
        } catch {}
        server.addEventListener('message', (ev) => {
          if (typeof ev.data === 'string') sendFrame(OP.TEXT, new TextEncoder().encode(ev.data));
          else toBytes(ev.data, (bytes) => sendFrame(OP.BINARY, bytes));
        });
        const onBrowserClose = (ev) => {
          if (done) return;
          if (!sentClose) {
            sentClose = true;
            sendFrame(OP.CLOSE, closePayload(ev?.code, ev?.reason));
          }
          // Give the local server a moment to answer the close, then hang up.
          setTimeout(() => {
            if (!done) {
              out.end();
              finish();
              send(T.ABORT, { code: 'ECONNRESET', message: 'browser closed the websocket' });
            }
          }, 1000);
        };
        server.addEventListener('close', onBrowserClose);
        server.addEventListener('error', onBrowserClose);
        decoder = new WsDecoder((opcode, payload) => {
          if (opcode === OP.TEXT) {
            try {
              server.send(new TextDecoder().decode(payload));
            } catch {}
          } else if (opcode === OP.BINARY) {
            try {
              server.send(payload);
            } catch {}
          } else if (opcode === OP.PING) {
            sendFrame(OP.PONG, payload);
          } else if (opcode === OP.CLOSE) {
            const { code, reason } = parseClosePayload(payload);
            if (!sentClose) {
              sentClose = true;
              sendFrame(OP.CLOSE, payload.subarray(0, 125));
            }
            closeBrowser(code === 1005 ? 1000 : code, reason);
          }
        });
        const respHeaders = new Headers();
        const proto = parsed.headers.find(([k]) => k.toLowerCase() === 'sec-websocket-protocol');
        if (proto) respHeaders.set('Sec-WebSocket-Protocol', proto[1]);
        resolve(new Response(null, { status: 101, webSocket: client, headers: respHeaders }));
        if (rest.length) feed(rest);
      };

      const feed = (bytes) => {
        try {
          decoder.push(bytes);
        } catch (err) {
          closeBrowser(1009, err.message);
          stream.onAbort({ code: 'EPROTO', message: err.message });
        }
      };

      const finishHttp = () => {
        if (done) return;
        finish();
        send(T.ABORT, { code: 'ECONNRESET', message: 'upgrade refused' });
        const body = httpRes.chunks.length ? httpRes.chunks.reduce(concatBytes, EMPTY) : null;
        const h = new Headers();
        for (const [k, v] of httpRes.headers) {
          const lower = k.toLowerCase();
          if (lower === 'connection' || lower === 'transfer-encoding' || lower === 'keep-alive') continue;
          try {
            h.append(k, v);
          } catch {}
        }
        const status = httpRes.status >= 200 && httpRes.status <= 599 ? httpRes.status : 502;
        resolve(new Response(NULL_BODY.has(status) ? null : body, { status, statusText: httpRes.statusText, headers: h }));
      };

      const stream = {
        out,
        onData: (chunk) => {
          if (done) return;
          ack(chunk.length);
          const bytes = new Uint8Array(chunk);
          if (phase === 'ws') return feed(bytes);
          if (phase === 'http') {
            httpRes.chunks.push(bytes);
            httpRes.received += bytes.length;
            if (httpRes.expected >= 0 && httpRes.received >= httpRes.expected) finishHttp();
            return;
          }
          head = concatBytes(head, bytes);
          const end = indexOfHeadEnd(head);
          if (end < 0) {
            if (head.length > 64 * 1024) stream.onAbort({ code: 'EPROTO', message: 'upgrade response head too large' });
            return;
          }
          const parsed = parseResponseHead(head.subarray(0, end));
          const rest = head.subarray(end + 4);
          if (!parsed) return stream.onAbort({ code: 'EPROTO', message: 'invalid upgrade response from the local server' });
          if (parsed.status === 101) return startWs(parsed, rest);
          // The local server refused the upgrade: relay its answer as plain HTTP.
          phase = 'http';
          const cl = parsed.headers.find(([k]) => k.toLowerCase() === 'content-length');
          httpRes = { ...parsed, chunks: rest.length ? [rest] : [], received: rest.length, expected: cl ? Number(cl[1]) : -1 };
          if (httpRes.expected >= 0 && httpRes.received >= httpRes.expected) finishHttp();
        },
        onEnd: () => {
          if (done) return;
          if (phase === 'http') return finishHttp();
          if (phase === 'head') return stream.onAbort({ code: 'ECONNRESET', message: 'the local server closed the connection' });
          finish();
          closeBrowser(1000, '');
        },
        onAbort: ({ code, message } = {}) => {
          if (done) return;
          finish();
          send(T.ABORT, { code: code || 'ECONNRESET', message: message || 'aborted' });
          if (phase === 'head') return resolve(upstreamError(request, tunnel, code, message));
          if (phase === 'http') return resolve(upstreamError(request, tunnel, code, message));
          closeBrowser(1011, 'tunnel closed');
        },
      };
      this.streams.set(sid, stream);
      send(T.REQ, this.info(request, tunnel, true, headers));
    });
  }
}
