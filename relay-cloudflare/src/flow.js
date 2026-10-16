// Web-streams flavoured port of ../../src/flow.js: per-stream credit flow
// control (same window, same ACK semantics as the Node relay).

import { T, encodeAck } from '../../src/protocol.js';

export const WINDOW = 2 * 1024 * 1024;
// Keep individual DATA frames small: Cloudflare caps WebSocket message size.
export const MAX_CHUNK = 64 * 1024;

/** Sends bytes as DATA frames and lets the producer wait while too much is unacknowledged. */
export class Outbound {
  /** @param {(type: number, payload?: Uint8Array) => void} send */
  constructor(send, window = WINDOW) {
    this.send = send;
    this.window = window;
    this.inflight = 0;
    this.waiter = null;
    this.ended = false;
  }

  write(chunk) {
    for (let off = 0; off < chunk.length; off += MAX_CHUNK) {
      const part = chunk.subarray(off, Math.min(chunk.length, off + MAX_CHUNK));
      this.inflight += part.length;
      this.send(T.DATA, part);
    }
  }

  end() {
    if (this.ended) return;
    this.ended = true;
    this.send(T.END);
  }

  /** Resolves once the window has room again. */
  ready() {
    if (this.inflight < this.window) return Promise.resolve();
    return new Promise((resolve) => (this.waiter = resolve));
  }

  ack(n) {
    this.inflight = Math.max(0, this.inflight - n);
    if (this.waiter && this.inflight < this.window / 2) {
      const w = this.waiter;
      this.waiter = null;
      w();
    }
  }

  /** Release a waiting producer for good (stream aborted). */
  cancel() {
    this.ended = true;
    const w = this.waiter;
    this.waiter = null;
    w?.();
  }

  /**
   * Pump a ReadableStream (e.g. a browser request body) through the tunnel.
   * @param {ReadableStream<Uint8Array>|null} body
   * @param {(err: Error) => void} onError
   */
  async pump(body, onError) {
    if (!body) return this.end();
    const reader = body.getReader();
    try {
      for (;;) {
        await this.ready();
        if (this.ended) return reader.cancel().catch(() => {});
        const { done, value } = await reader.read();
        if (done) break;
        if (this.ended) return reader.cancel().catch(() => {});
        if (value?.length) this.write(value instanceof Uint8Array ? value : new Uint8Array(value));
      }
      this.end();
    } catch (err) {
      if (!this.ended) onError(err);
    }
  }
}

/** Coalesces ACKs for bytes the receiving side has consumed. */
export function acker(send) {
  let pending = 0;
  let scheduled = false;
  return (n) => {
    pending += n;
    if (scheduled) return;
    scheduled = true;
    setTimeout(() => {
      scheduled = false;
      if (pending) {
        send(T.ACK, encodeAck(pending));
        pending = 0;
      }
    }, 0);
  };
}

/**
 * A response body fed by DATA frames. Bytes are acknowledged only when the
 * runtime pulls them (i.e. the browser is actually reading), and cancel()
 * tells us the browser went away.
 */
export class BodyPipe {
  /**
   * @param {(n: number) => void} onConsumed
   * @param {(reason: unknown) => void} onCancel
   * @param {number} [stallMs] give up when bytes sit unread this long (0 = never)
   */
  constructor(onConsumed, onCancel, stallMs = 0) {
    this.onCancel = onCancel;
    this.stallMs = stallMs;
    this.lastPull = Date.now();
    this.stallTimer = null;
    this.queue = [];
    this.ended = false;
    this.error = null;
    this.wake = null;
    this.cancelled = false;
    this.stream = new ReadableStream(
      {
        pull: async (controller) => {
          this.lastPull = Date.now();
          while (!this.queue.length && !this.ended && !this.error) await new Promise((r) => (this.wake = r));
          if (this.queue.length) {
            const chunk = this.queue.shift();
            controller.enqueue(chunk);
            onConsumed(chunk.length);
            return;
          }
          if (this.error) controller.error(this.error);
          else controller.close();
        },
        cancel: (reason) => this.cancel(reason),
      },
      { highWaterMark: 0 },
    );
  }

  cancel(reason) {
    if (this.cancelled) return;
    this.cancelled = true;
    this.queue = [];
    clearInterval(this.stallTimer);
    this.onCancel(reason);
  }

  // Not every runtime path tells a Durable Object that the browser hung up
  // (e.g. local workerd never cancels the stream). A response whose bytes
  // nobody pulls for stallMs is treated as abandoned.
  watchStall() {
    if (!this.stallMs || this.stallTimer) return;
    this.stallTimer = setInterval(() => {
      if (this.cancelled || (this.ended && !this.queue.length) || this.error) return clearInterval(this.stallTimer);
      if (this.queue.length && Date.now() - this.lastPull > this.stallMs) this.cancel(new Error('response stalled'));
    }, Math.min(5_000, Math.max(250, this.stallMs / 4)));
  }

  notify() {
    const w = this.wake;
    this.wake = null;
    w?.();
  }

  push(chunk) {
    if (this.cancelled || this.ended) return false;
    this.queue.push(chunk);
    this.watchStall();
    this.notify();
    return true;
  }

  end() {
    this.ended = true;
    clearInterval(this.stallTimer);
    this.notify();
  }

  abort(err) {
    this.error = err || new Error('aborted');
    clearInterval(this.stallTimer);
    this.notify();
  }
}
