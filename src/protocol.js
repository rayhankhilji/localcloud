// Wire protocol shared by the relay and the client.
//
// Every message is a binary frame:
//   [type: u8][stream id: u32 BE][payload...]
// Control frames carry a JSON payload, DATA frames carry raw bytes.
// Over WebSocket each frame is one binary message; over the HTTP long-poll
// transport frames are batched as [length: u32 BE][frame]...

export const PROTOCOL_VERSION = 1;

export const T = Object.freeze({
  HELLO: 1, // client -> relay  {v, token, client}
  WELCOME: 2, // relay -> client  {ok, error?, version, routing}
  OPEN: 3, // client -> relay  {reqId, name?, secret, protect?, basicAuth?}
  OPENED: 4, // relay -> client  {reqId, ok, id, url, accessUrl?, error?}
  CLOSE_TUNNEL: 5, // client -> relay  {id}
  REQ: 10, // relay -> client  {tunnel, method, url, headers, remote, proto, origin, upgrade}
  RES: 11, // client -> relay  {status, statusText, headers}
  DATA: 12, // both, raw bytes
  END: 13, // both, half-close of a stream
  ABORT: 14, // both  {code, message}
  ACK: 15, // both, u32 bytes consumed (flow control)
  PING: 20,
  PONG: 21,
  NOTICE: 22, // relay -> client  {message}
});

const HEADER = 5;
const EMPTY = Buffer.alloc(0);

/** @param {number} type @param {number} sid @param {Buffer|object|undefined} [payload] */
export function encodeFrame(type, sid = 0, payload) {
  let body;
  if (payload === undefined || payload === null) body = EMPTY;
  else if (Buffer.isBuffer(payload)) body = payload;
  else if (payload instanceof Uint8Array) body = Buffer.from(payload.buffer, payload.byteOffset, payload.byteLength);
  else body = Buffer.from(JSON.stringify(payload));
  const out = Buffer.allocUnsafe(HEADER + body.length);
  out.writeUInt8(type, 0);
  out.writeUInt32BE(sid >>> 0, 1);
  body.copy(out, HEADER);
  return out;
}

/** @param {Buffer} buf */
export function decodeFrame(buf) {
  if (buf.length < HEADER) throw new Error('frame too short');
  return { type: buf.readUInt8(0), sid: buf.readUInt32BE(1), payload: buf.subarray(HEADER) };
}

/** @param {Buffer} payload */
export function parseJson(payload) {
  return payload.length ? JSON.parse(payload.toString('utf8')) : {};
}

export function encodeAck(n) {
  const b = Buffer.allocUnsafe(4);
  b.writeUInt32BE(Math.min(n, 0xffffffff), 0);
  return b;
}

export function decodeAck(payload) {
  return payload.length >= 4 ? payload.readUInt32BE(0) : 0;
}

/** @param {Buffer[]} frames */
export function encodeBatch(frames) {
  let size = 0;
  for (const f of frames) size += 4 + f.length;
  const out = Buffer.allocUnsafe(size);
  let off = 0;
  for (const f of frames) {
    out.writeUInt32BE(f.length, off);
    f.copy(out, off + 4);
    off += 4 + f.length;
  }
  return out;
}

/** @param {Buffer} buf */
export function decodeBatch(buf) {
  const frames = [];
  let off = 0;
  while (off + 4 <= buf.length) {
    const len = buf.readUInt32BE(off);
    if (off + 4 + len > buf.length) throw new Error('truncated batch');
    frames.push(buf.subarray(off + 4, off + 4 + len));
    off += 4 + len;
  }
  return frames;
}

// Hop-by-hop headers never cross the tunnel.
export const HOP_BY_HOP = new Set([
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'trailers',
  'transfer-encoding',
  'upgrade',
]);

/**
 * Turn a flat rawHeaders array into [name, value] pairs, dropping hop-by-hop
 * headers (except the ones needed to replay an upgrade).
 * @param {string[]} raw
 * @param {{upgrade?: boolean, drop?: (name: string) => boolean}} [opts]
 */
export function filterRawHeaders(raw, opts = {}) {
  const connectionTokens = new Set();
  for (let i = 0; i < raw.length; i += 2) {
    if (raw[i].toLowerCase() === 'connection') {
      for (const t of raw[i + 1].split(',')) connectionTokens.add(t.trim().toLowerCase());
    }
  }
  const out = [];
  for (let i = 0; i < raw.length; i += 2) {
    const name = raw[i];
    const lower = name.toLowerCase();
    if (opts.upgrade && (lower === 'connection' || lower === 'upgrade')) {
      out.push([name, raw[i + 1]]);
      continue;
    }
    if (HOP_BY_HOP.has(lower) || connectionTokens.has(lower)) continue;
    if (opts.drop && opts.drop(lower)) continue;
    out.push([name, raw[i + 1]]);
  }
  return out;
}

/** [name, value] pairs -> object with array values for repeated headers. */
export function pairsToObject(pairs) {
  const out = {};
  for (const [name, value] of pairs) {
    const key = name.toLowerCase();
    if (key in out) {
      const prev = out[key];
      out[key] = Array.isArray(prev) ? [...prev, value] : [prev, value];
    } else {
      out[key] = value;
    }
  }
  return out;
}
