// Per-stream credit based flow control, so a fast sender can never flood a
// slow receiver (or the relay's memory) no matter which transport is used.

import { T, encodeAck } from './protocol.js';

export const WINDOW = 2 * 1024 * 1024;

/** Sends a readable as DATA frames, pausing while too many bytes are unacknowledged. */
export class Outbound {
  /** @param {(type: number, payload?: Buffer) => void} send */
  constructor(send, window = WINDOW) {
    this.send = send;
    this.window = window;
    this.inflight = 0;
    this.sentBytes = 0;
    this.paused = false;
    this.readable = null;
    this.ended = false;
  }

  /** Send bytes that did not come from the pumped readable (e.g. an upgrade head). */
  write(chunk) {
    if (!chunk.length) return;
    this.inflight += chunk.length;
    this.sentBytes += chunk.length;
    this.send(T.DATA, chunk);
  }

  /** @param {import('node:stream').Readable} readable @param {() => void} [onEnd] */
  pump(readable, onEnd) {
    this.readable = readable;
    readable.on('data', (chunk) => {
      if (this.stopped) return;
      this.write(chunk);
      if (this.inflight >= this.window && !this.paused) {
        this.paused = true;
        readable.pause();
      }
    });
    readable.once('end', () => {
      if (this.stopped) return;
      this.ended = true;
      this.send(T.END);
      onEnd?.();
    });
  }

  /** The other side is gone: drain the rest of the readable into the void (so its socket can be reused). */
  stop() {
    if (this.stopped) return;
    this.stopped = true;
    if (this.readable && !this.readable.destroyed) this.readable.resume();
  }

  ack(n) {
    this.inflight = Math.max(0, this.inflight - n);
    if (this.paused && !this.stopped && this.inflight < this.window / 2 && this.readable) {
      this.paused = false;
      this.readable.resume();
    }
  }
}

/** Writes incoming DATA to a writable and acknowledges bytes once they are flushed. */
export class Inbound {
  /** @param {import('node:stream').Writable} writable @param {(type: number, payload?: Buffer) => void} send */
  constructor(writable, send) {
    this.writable = writable;
    this.send = send;
    this.pending = 0;
    this.scheduled = false;
  }

  write(chunk) {
    const n = chunk.length;
    if (this.writable.destroyed) return;
    this.writable.write(chunk, () => {
      this.pending += n;
      if (!this.scheduled) {
        this.scheduled = true;
        setImmediate(() => {
          this.scheduled = false;
          if (this.pending) {
            this.send(T.ACK, encodeAck(this.pending));
            this.pending = 0;
          }
        });
      }
    });
  }
}
