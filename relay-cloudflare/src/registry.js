// The registry: one Durable Object (named "registry") that maps tunnel ids to
// the Session DO currently serving them, and keeps names reserved (by
// secret) for an hour after a client disconnects so URLs survive reconnects.
//
// It is only on the hot path for cache misses: Workers cache lookups for a
// few seconds and Session DOs re-route stale hits themselves.

import { DurableObject } from 'cloudflare:workers';
import { generateName, normalizeName, randomToken } from '../../src/names.js';
import { safeEqual } from './common.js';

const RESERVATION_MS = 60 * 60_000;
const SWEEP_MS = 15 * 60_000;
const KEY = (id) => `t:${id}`;

/** What callers outside the registry may see (never the secret). */
function view(rec) {
  return rec ? { id: rec.id, session: rec.session || null, port: rec.port ?? null, access: rec.access || null, basicAuth: rec.basicAuth || null } : null;
}

export class Registry extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.waiters = new Map(); // id -> Set<() => void>
  }

  async get(id) {
    if (typeof id !== 'string' || !id) return null;
    const rec = await this.ctx.storage.get(KEY(id));
    if (!rec) return null;
    if (!rec.session && rec.offlineSince && Date.now() - rec.offlineSince > RESERVATION_MS) {
      await this.ctx.storage.delete(KEY(id));
      return null;
    }
    return rec;
  }

  wake(id) {
    const set = this.waiters.get(id);
    if (!set) return;
    this.waiters.delete(id);
    for (const w of set) w();
  }

  /**
   * Reserve (or re-claim) a tunnel id for a session.
   * @param {{name?: string, secret: string, session: string, port?: number, protect?: boolean, basicAuth?: string}} msg
   */
  async claim(msg) {
    let id;
    let rec = null;
    if (msg.name) {
      id = normalizeName(msg.name);
      if (!id) return { ok: false, error: `"${msg.name}" can't be used as a name` };
      rec = await this.get(id);
      if (rec && !safeEqual(rec.secret, msg.secret)) return { ok: false, error: `the name "${id}" is already taken`, code: 'name_taken' };
    } else {
      do id = generateName();
      while (await this.get(id));
    }
    rec ||= { id, secret: msg.secret, access: null };
    const previous = rec.session;
    rec.port = msg.port ?? null;
    rec.access = msg.protect ? rec.access || randomToken(18) : null;
    rec.basicAuth = typeof msg.basicAuth === 'string' && msg.basicAuth.includes(':') ? msg.basicAuth : null;
    rec.session = msg.session;
    rec.offlineSince = 0;
    await this.ctx.storage.put(KEY(id), rec);
    if (previous && previous !== msg.session) {
      // The client reconnected on a new session: tell the old one to let go.
      try {
        const stub = this.env.SESSION.get(this.env.SESSION.idFromString(previous));
        stub.dropTunnel(id).catch(() => {});
      } catch {}
    }
    this.wake(id);
    return { ok: true, ...view(rec) };
  }

  async lookup(id) {
    return view(await this.get(id));
  }

  /**
   * Wait (up to ms) until the tunnel is served by a session other than `exclude`.
   * @returns {Promise<{missing: true} | {tunnel: object}>}
   */
  async waitOnline(id, ms = 0, exclude = null) {
    let rec = await this.get(id);
    if (!rec) return { missing: true };
    if (exclude && rec.session === exclude) {
      // That session told us it does not serve the tunnel (it lost its client).
      rec.session = null;
      rec.offlineSince = Date.now();
      await this.ctx.storage.put(KEY(id), rec);
      await this.scheduleSweep();
    }
    if (!rec.session && ms > 0) {
      await new Promise((resolve) => {
        let set = this.waiters.get(id);
        if (!set) this.waiters.set(id, (set = new Set()));
        const done = () => {
          clearTimeout(timer);
          set.delete(done);
          resolve();
        };
        const timer = setTimeout(done, Math.min(ms, 30_000));
        set.add(done);
      });
      rec = await this.get(id);
      if (!rec) return { missing: true };
    }
    return { tunnel: view(rec) };
  }

  /** A session lost its client: its tunnels stay reserved for a while. */
  async offline(ids, session) {
    const now = Date.now();
    for (const id of ids) {
      const rec = await this.get(id);
      if (rec && rec.session === session) {
        rec.session = null;
        rec.offlineSince = now;
        await this.ctx.storage.put(KEY(id), rec);
      }
    }
    await this.scheduleSweep();
  }

  /** The client stopped sharing: free the name right away. */
  async close(id, session) {
    const rec = await this.get(id);
    if (rec && rec.session === session) await this.ctx.storage.delete(KEY(id));
  }

  async count() {
    const all = await this.ctx.storage.list({ prefix: 't:' });
    let online = 0;
    for (const rec of all.values()) if (rec.session) online++;
    return { tunnels: all.size, online };
  }

  async scheduleSweep() {
    if ((await this.ctx.storage.getAlarm()) == null) await this.ctx.storage.setAlarm(Date.now() + SWEEP_MS);
  }

  async alarm() {
    const now = Date.now();
    let waiting = 0;
    for (const [key, rec] of await this.ctx.storage.list({ prefix: 't:' })) {
      if (rec.session || !rec.offlineSince) continue;
      if (now - rec.offlineSince > RESERVATION_MS) await this.ctx.storage.delete(key);
      else waiting++;
    }
    if (waiting) await this.ctx.storage.setAlarm(now + SWEEP_MS);
  }
}
