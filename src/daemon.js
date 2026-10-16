// Background mode. Coding agents can't babysit a foreground process, so
// `localcloud start` hands tunnels to a small detached daemon and returns
// immediately with the URL. The CLI, the MCP server and the daemon talk JSON
// over a unix socket (named pipe on Windows).

import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Client } from './client/client.js';
import { homeDir } from './config.js';
import { VERSION } from './version.js';
import { PortWatcher, watchSupported } from './watch.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const CLI = fileURLToPath(new URL('../bin/localcloud.js', import.meta.url));

export function paths() {
  const home = homeDir();
  const socket =
    process.platform === 'win32'
      ? `\\\\.\\pipe\\localcloud-${crypto.createHash('sha1').update(home).digest('hex').slice(0, 12)}`
      : path.join(home, 'daemon.sock');
  return { home, socket, log: path.join(home, 'daemon.log'), state: path.join(home, 'tunnels.json') };
}

/** Talk to the daemon. Resolves null when it isn't running. */
export function daemonRequest(method, route, body, timeout = 30_000) {
  const { socket } = paths();
  return new Promise((resolve, reject) => {
    const payload = body ? JSON.stringify(body) : undefined;
    const req = http.request(
      { socketPath: socket, method, path: route, headers: payload ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } : {} },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          let data = {};
          try {
            data = JSON.parse(Buffer.concat(chunks).toString() || '{}');
          } catch {}
          if (res.statusCode >= 400) reject(Object.assign(new Error(data.error || `daemon error ${res.statusCode}`), { status: res.statusCode }));
          else resolve(data);
        });
      },
    );
    req.setTimeout(timeout, () => req.destroy(new Error('daemon did not respond')));
    req.on('error', (err) => {
      if (['ENOENT', 'ECONNREFUSED', 'ENOTSOCK'].includes(err.code)) resolve(null);
      else reject(err);
    });
    req.end(payload);
  });
}

export const daemonStatus = () => daemonRequest('GET', '/status', undefined, 5000).catch(() => null);

/** Identifies the settings a daemon runs with, without exposing the token. */
function configId(cfg) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify([cfg.relay, cfg.token || '', cfg.transport || 'auto']))
    .digest('hex')
    .slice(0, 16);
}

/**
 * Make sure a daemon for this relay is running. Returns its status.
 * @param {{relay: string, token?: string, transport?: string}} cfg
 */
export async function ensureDaemon(cfg) {
  let status = await daemonStatus();
  let restarted = false;
  const stale = status && (status.relay !== cfg.relay || status.version !== VERSION || (status.configId && status.configId !== configId(cfg)) || status.fatal);
  if (stale) {
    await daemonRequest('POST', '/shutdown').catch(() => {});
    await waitFor(async () => !(await daemonStatus()), 5000);
    status = null;
    restarted = true;
  }
  if (status) return { status, started: false, restarted };

  const { home, log } = paths();
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  // A stale socket file is cleaned up by the daemon itself (see runDaemon), so two
  // CLIs racing to start it can't orphan a live daemon by unlinking its socket.
  const out = fs.openSync(log, 'a');
  const child = spawn(process.execPath, [CLI, '__daemon'], {
    detached: true,
    stdio: ['ignore', out, out],
    env: { ...process.env, LOCALCLOUD_DAEMON_CONFIG: JSON.stringify({ relay: cfg.relay, token: cfg.token, transport: cfg.transport }) },
    windowsHide: true,
  });
  child.unref();
  fs.closeSync(out);
  const ok = await waitFor(async () => (status = await daemonStatus()), 10_000);
  if (!ok) throw new Error(`the localcloud daemon didn't start — see ${log}`);
  return { status, started: true, restarted };
}

async function waitFor(fn, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await fn()) return true;
    await sleep(100);
  }
  return false;
}

/** The daemon process itself. */
export async function runDaemon() {
  const cfg = JSON.parse(process.env.LOCALCLOUD_DAEMON_CONFIG || '{}');
  const { socket, state } = paths();
  const log = (msg) => console.log(`${new Date().toISOString()} ${msg}`);
  const client = new Client({ relay: cfg.relay, token: cfg.token, transport: cfg.transport });
  const id = configId(cfg);
  let watcher = null;
  const watchErrors = new Map();

  const writeState = () => {
    try {
      fs.writeFileSync(state, JSON.stringify({ relay: client.relay, tunnels: client.status.tunnels, updated: new Date().toISOString() }, null, 2) + '\n');
    } catch {}
  };

  client.on('status', (s) => {
    if (s.state === 'connected') log(`connected to ${client.relay} via ${s.transport}`);
    else if (s.state === 'error') log(`connection problem: ${s.error.message}`);
    else if (s.state === 'fallback') log(`websocket unavailable (${s.error.message}); using https long-polling`);
    else if (s.state === 'disconnected') log('disconnected, reconnecting…');
  });
  client.on('tunnel', (t) => {
    log(`${t.target} → ${t.accessUrl || t.url}`);
    writeState();
  });
  client.on('unshared', writeState);
  client.on('request', (r) => {
    if (r.error) log(`${r.method} ${r.url} → ${r.error}`);
  });
  client.on('fatal', (err) => log(`fatal: ${err.message}`));
  client.start();

  const shareWithTimeout = (target, opts, ms = 25_000) =>
    Promise.race([
      client.share(target, opts),
      sleep(ms).then(() => {
        throw new Error(client.lastError ? `can't reach the relay: ${client.lastError}` : 'timed out waiting for the relay');
      }),
    ]);

  const startWatch = async () => {
    if (watcher || !watchSupported()) return !!watcher;
    watcher = new PortWatcher();
    watcher.on('port', (port) => {
      log(`detected a server on port ${port}`);
      shareWithTimeout(String(port), {}, 120_000).then(
        () => watchErrors.delete(port),
        (err) => {
          watchErrors.set(port, err.message);
          log(`couldn't share port ${port}: ${err.message}`);
        },
      );
    });
    await watcher.start();
    return true;
  };

  const status = () => ({
    pid: process.pid,
    version: VERSION,
    configId: id,
    fatal: client.fatalError?.message || null,
    ...client.status,
    watch: !!watcher,
    watchSupported: watchSupported(),
  });

  const server = http.createServer(async (req, res) => {
    const json = (code, data) => {
      res.writeHead(code, { 'content-type': 'application/json' });
      res.end(JSON.stringify(data));
    };
    let body = {};
    try {
      const chunks = [];
      for await (const c of req) chunks.push(c);
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString());
    } catch {
      return json(400, { error: 'bad json' });
    }
    try {
      if (req.method === 'GET' && req.url === '/status') return json(200, status());
      if (req.method === 'POST' && req.url === '/share') {
        if (body.target === undefined || body.target === null || body.target === '') return json(400, { error: 'missing target' });
        const t = await shareWithTimeout(String(body.target), body);
        return json(200, { tunnel: t, transport: client.transport?.kind });
      }
      if (req.method === 'POST' && req.url === '/unshare') {
        const ok = client.unshare(String(body.target));
        return json(ok ? 200 : 404, ok ? { ok } : { error: `nothing is shared for ${body.target}` });
      }
      if (req.method === 'POST' && req.url === '/watch') {
        if (body.enabled === false) {
          watcher?.stop();
          watcher = null;
        } else if (!(await startWatch())) {
          return json(400, { error: 'automatic port detection is not supported on this platform' });
        }
        return json(200, status());
      }
      if (req.method === 'POST' && req.url === '/shutdown') {
        json(200, { ok: true });
        setTimeout(() => shutdown('requested'), 50);
        return;
      }
      json(404, { error: 'unknown route' });
    } catch (err) {
      json(500, { error: err.message });
    }
  });

  let stopping = false;
  const shutdown = async (why) => {
    if (stopping) return;
    stopping = true;
    log(`shutting down (${why})`);
    watcher?.stop();
    await client.close().catch(() => {});
    server.close();
    try {
      fs.unlinkSync(state);
    } catch {}
    process.exit(0);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGHUP', () => {}); // outlive the terminal that started us
  process.on('unhandledRejection', (err) => log(`unexpected error: ${err?.stack || err}`));

  const listen = () =>
    new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(socket, () => {
        server.off('error', reject);
        resolve();
      });
    });
  try {
    await listen();
  } catch (err) {
    if (err.code !== 'EADDRINUSE') throw err;
    if (await daemonStatus()) {
      log('another daemon is already running; exiting');
      process.exit(0);
    }
    // Left behind by a daemon that crashed or was killed.
    try {
      fs.unlinkSync(socket);
    } catch {}
    await listen();
  }
  if (process.platform !== 'win32') fs.chmodSync(socket, 0o600);
  log(`localcloud daemon ${VERSION} ready (pid ${process.pid}, relay ${cfg.relay})`);
}
