// Minimal RFC 6455 framing. Workers terminate WebSockets, so to bridge a
// browser WebSocket to the local dev server (which expects a raw TCP byte
// stream after the HTTP upgrade) the relay speaks the client side of the
// protocol itself: frames towards the local server are masked, frames from
// it are not (masked ones are tolerated anyway).

export const OP = Object.freeze({ CONT: 0, TEXT: 1, BINARY: 2, CLOSE: 8, PING: 9, PONG: 10 });

/**
 * @param {number} opcode
 * @param {Uint8Array} [payload]
 * @param {{mask?: boolean, fin?: boolean}} [opts]
 */
export function encodeWsFrame(opcode, payload = new Uint8Array(0), { mask = true, fin = true } = {}) {
  const len = payload.length;
  const ext = len < 126 ? 0 : len < 65536 ? 2 : 8;
  const head = 2 + ext + (mask ? 4 : 0);
  const out = new Uint8Array(head + len);
  out[0] = (fin ? 0x80 : 0) | (opcode & 0x0f);
  if (ext === 0) out[1] = len;
  else if (ext === 2) {
    out[1] = 126;
    out[2] = len >>> 8;
    out[3] = len & 0xff;
  } else {
    out[1] = 127;
    const dv = new DataView(out.buffer);
    dv.setUint32(2, Math.floor(len / 2 ** 32));
    dv.setUint32(6, len >>> 0);
  }
  let off = 2 + ext;
  if (mask) {
    out[1] |= 0x80;
    const key = crypto.getRandomValues(new Uint8Array(4));
    out.set(key, off);
    off += 4;
    for (let i = 0; i < len; i++) out[off + i] = payload[i] ^ key[i & 3];
  } else {
    out.set(payload, off);
  }
  return out;
}

/** Close frame payload: u16 code + UTF-8 reason (codes 1005/1006 are never sent). */
export function closePayload(code, reason = '') {
  if (!code || code === 1005 || code === 1006 || code === 1015) return new Uint8Array(0);
  const r = new TextEncoder().encode(String(reason)).subarray(0, 123);
  const out = new Uint8Array(2 + r.length);
  out[0] = code >>> 8;
  out[1] = code & 0xff;
  out.set(r, 2);
  return out;
}

export function parseClosePayload(p) {
  if (p.length < 2) return { code: 1005, reason: '' };
  return { code: (p[0] << 8) | p[1], reason: new TextDecoder().decode(p.subarray(2)) };
}

/**
 * Incremental frame decoder. Calls onMessage(opcode, payload) for complete
 * data messages (fragments reassembled) and for each control frame.
 */
export class WsDecoder {
  /** @param {(opcode: number, payload: Uint8Array) => void} onMessage */
  constructor(onMessage, { maxMessage = 64 * 1024 * 1024 } = {}) {
    this.onMessage = onMessage;
    this.maxMessage = maxMessage;
    this.chunks = [];
    this.length = 0;
    this.fragments = [];
    this.fragmentBytes = 0;
    this.fragmentOp = 0;
  }

  /** Total buffered bytes available from the front of the queue. */
  peek(n) {
    if (this.length < n) return null;
    if (this.chunks[0].length >= n) return this.chunks[0].subarray(0, n);
    const out = new Uint8Array(n);
    let off = 0;
    for (const c of this.chunks) {
      const take = Math.min(c.length, n - off);
      out.set(c.subarray(0, take), off);
      off += take;
      if (off === n) break;
    }
    return out;
  }

  take(n) {
    const out = this.peek(n);
    let left = n;
    while (left > 0) {
      const c = this.chunks[0];
      if (c.length <= left) {
        this.chunks.shift();
        left -= c.length;
      } else {
        this.chunks[0] = c.subarray(left);
        left = 0;
      }
    }
    this.length -= n;
    return out;
  }

  /** @param {Uint8Array} chunk */
  push(chunk) {
    if (chunk.length) {
      this.chunks.push(chunk);
      this.length += chunk.length;
    }
    for (;;) {
      const h = this.peek(2);
      if (!h) return;
      const b0 = h[0];
      const b1 = h[1];
      const masked = (b1 & 0x80) !== 0;
      let len = b1 & 0x7f;
      let headLen = 2;
      if (len === 126) headLen += 2;
      else if (len === 127) headLen += 8;
      if (masked) headLen += 4;
      const head = this.peek(headLen);
      if (!head) return;
      const dv = new DataView(head.buffer, head.byteOffset, head.byteLength);
      if (len === 126) len = dv.getUint16(2);
      else if (len === 127) len = dv.getUint32(2) * 2 ** 32 + dv.getUint32(6);
      if (len > this.maxMessage) throw new Error('websocket frame too large');
      if (this.length < headLen + len) return;
      const key = masked ? head.slice(headLen - 4, headLen) : null;
      this.take(headLen);
      const payload = len ? this.take(len).slice() : new Uint8Array(0);
      if (key) for (let i = 0; i < payload.length; i++) payload[i] ^= key[i & 3];
      this.frame((b0 & 0x80) !== 0, b0 & 0x0f, payload);
    }
  }

  frame(fin, opcode, payload) {
    if (opcode >= 8) return this.onMessage(opcode, payload); // control frames are never fragmented
    if (opcode !== OP.CONT) {
      this.fragmentOp = opcode;
      this.fragments = [];
      this.fragmentBytes = 0;
    }
    if (fin && !this.fragments.length) return this.onMessage(this.fragmentOp, payload);
    this.fragments.push(payload);
    this.fragmentBytes += payload.length;
    if (this.fragmentBytes > this.maxMessage) throw new Error('websocket message too large');
    if (!fin) return;
    const out = new Uint8Array(this.fragmentBytes);
    let off = 0;
    for (const f of this.fragments) {
      out.set(f, off);
      off += f.length;
    }
    this.fragments = [];
    this.fragmentBytes = 0;
    this.onMessage(this.fragmentOp, out);
  }
}

/** Parse an HTTP/1.x response head (without the trailing CRLFCRLF). */
export function parseResponseHead(bytes) {
  const lines = new TextDecoder('latin1').decode(bytes).split('\r\n');
  const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?$/.exec(lines[0] || '');
  if (!m) return null;
  const headers = [];
  for (const line of lines.slice(1)) {
    const i = line.indexOf(':');
    if (i > 0) headers.push([line.slice(0, i).trim(), line.slice(i + 1).trim()]);
  }
  return { status: Number(m[1]), statusText: m[2] || '', headers };
}

export function indexOfHeadEnd(buf) {
  for (let i = 3; i < buf.length; i++) {
    if (buf[i] === 10 && buf[i - 1] === 13 && buf[i - 2] === 10 && buf[i - 3] === 13) return i - 3;
  }
  return -1;
}

export function concatBytes(a, b) {
  if (!a.length) return b;
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}
