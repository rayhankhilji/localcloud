import assert from 'node:assert/strict';
import { PassThrough, Writable } from 'node:stream';
import { describe, test } from 'node:test';
import { Inbound, Outbound } from '../src/flow.js';
import {
  T,
  decodeAck,
  decodeBatch,
  decodeFrame,
  encodeAck,
  encodeBatch,
  encodeFrame,
  filterRawHeaders,
  pairsToObject,
  parseJson,
} from '../src/protocol.js';

describe('frames', () => {
  test('round-trips JSON payloads', () => {
    const buf = encodeFrame(T.REQ, 42, { method: 'GET', url: '/x?y=1', headers: [['a', 'b']] });
    const f = decodeFrame(buf);
    assert.equal(f.type, T.REQ);
    assert.equal(f.sid, 42);
    assert.deepEqual(parseJson(f.payload), { method: 'GET', url: '/x?y=1', headers: [['a', 'b']] });
  });

  test('round-trips binary payloads and Uint8Array views', () => {
    const data = Buffer.from([0, 1, 2, 255, 254]);
    assert.deepEqual(decodeFrame(encodeFrame(T.DATA, 7, data)).payload, data);
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    const view = backing.subarray(2, 5);
    assert.deepEqual([...decodeFrame(encodeFrame(T.DATA, 7, view)).payload], [1, 2, 3]);
  });

  test('empty payloads and max stream id', () => {
    const f = decodeFrame(encodeFrame(T.END, 0xffffffff));
    assert.equal(f.type, T.END);
    assert.equal(f.sid, 0xffffffff);
    assert.equal(f.payload.length, 0);
    assert.deepEqual(parseJson(f.payload), {});
    assert.equal(decodeFrame(encodeFrame(T.PING, 0, null)).payload.length, 0);
  });

  test('rejects truncated frames', () => {
    assert.throws(() => decodeFrame(Buffer.from([1, 0, 0])), /too short/);
  });

  test('acks', () => {
    assert.equal(decodeAck(encodeAck(123456)), 123456);
    assert.equal(decodeAck(encodeAck(2 ** 40)), 0xffffffff);
    assert.equal(decodeAck(Buffer.alloc(2)), 0);
  });
});

describe('batches', () => {
  test('round-trip several frames', () => {
    const frames = [encodeFrame(T.PING), encodeFrame(T.DATA, 3, Buffer.alloc(70_000, 7)), encodeFrame(T.END, 3)];
    const out = decodeBatch(encodeBatch(frames));
    assert.equal(out.length, 3);
    out.forEach((f, i) => assert.deepEqual(f, frames[i]));
  });

  test('empty batch', () => {
    assert.deepEqual(decodeBatch(encodeBatch([])), []);
    assert.deepEqual(decodeBatch(Buffer.alloc(0)), []);
  });

  test('rejects truncated batches', () => {
    const b = encodeBatch([encodeFrame(T.DATA, 1, Buffer.alloc(100))]);
    assert.throws(() => decodeBatch(b.subarray(0, b.length - 1)), /truncated/);
  });
});

describe('headers', () => {
  test('drops hop-by-hop and connection-listed headers', () => {
    const raw = ['Host', 'x', 'Connection', 'keep-alive, X-Secret', 'Keep-Alive', '5', 'X-Secret', 's', 'Transfer-Encoding', 'chunked', 'Accept', '*/*', 'TE', 'trailers'];
    assert.deepEqual(filterRawHeaders(raw), [
      ['Host', 'x'],
      ['Accept', '*/*'],
    ]);
  });

  test('keeps Connection/Upgrade for upgrades', () => {
    const raw = ['Connection', 'Upgrade', 'Upgrade', 'websocket', 'Sec-WebSocket-Key', 'k'];
    assert.deepEqual(filterRawHeaders(raw, { upgrade: true }), [
      ['Connection', 'Upgrade'],
      ['Upgrade', 'websocket'],
      ['Sec-WebSocket-Key', 'k'],
    ]);
  });

  test('custom drop', () => {
    assert.deepEqual(filterRawHeaders(['X-Forwarded-For', '1.2.3.4', 'A', 'b'], { drop: (n) => n.startsWith('x-forwarded-') }), [['A', 'b']]);
  });

  test('pairsToObject keeps repeated headers', () => {
    assert.deepEqual(
      pairsToObject([
        ['Set-Cookie', 'a=1'],
        ['set-cookie', 'b=2'],
        ['SET-COOKIE', 'c=3'],
        ['Content-Type', 'text/plain'],
      ]),
      { 'set-cookie': ['a=1', 'b=2', 'c=3'], 'content-type': 'text/plain' },
    );
  });
});

describe('flow control', () => {
  test('Outbound pauses at the window and resumes on ack', async () => {
    const sent = [];
    const out = new Outbound((type, payload) => sent.push({ type, len: payload?.length || 0 }), 1000);
    const src = new PassThrough();
    let ended = false;
    out.pump(src, () => (ended = true));
    for (let i = 0; i < 10; i++) src.write(Buffer.alloc(300));
    src.end();
    await new Promise((r) => setImmediate(r));
    const dataBytes = () => sent.filter((s) => s.type === T.DATA).reduce((a, s) => a + s.len, 0);
    assert.ok(out.paused, 'should pause');
    assert.ok(dataBytes() >= 1000 && dataBytes() < 3000, `sent ${dataBytes()} bytes before pausing`);
    while (!ended) {
      out.ack(out.inflight);
      await new Promise((r) => setImmediate(r));
    }
    assert.equal(dataBytes(), 3000);
    assert.equal(sent.at(-1).type, T.END);
  });

  test('Outbound.stop discards the rest of the readable', async () => {
    const sent = [];
    const out = new Outbound((type, payload) => sent.push({ type, len: payload?.length || 0 }), 100);
    const src = new PassThrough();
    out.pump(src);
    src.write(Buffer.alloc(200));
    await new Promise((r) => setImmediate(r));
    assert.ok(out.paused);
    out.stop();
    src.write(Buffer.alloc(500));
    src.end();
    await new Promise((r) => src.once('end', r));
    assert.equal(sent.filter((s) => s.type === T.DATA).length, 1);
    assert.equal(sent.filter((s) => s.type === T.END).length, 0);
  });

  test('Inbound acks bytes once they are written', async () => {
    const acks = [];
    let release;
    const gate = new Promise((r) => (release = r));
    const sink = new Writable({
      write(chunk, _enc, cb) {
        gate.then(() => cb());
      },
    });
    const inb = new Inbound(sink, (type, payload) => acks.push(decodeAck(payload)));
    inb.write(Buffer.alloc(10));
    inb.write(Buffer.alloc(20));
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual(acks, []);
    release();
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(acks.reduce((a, b) => a + b, 0), 30);
  });
});
