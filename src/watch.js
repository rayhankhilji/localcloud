// Detects TCP ports that start listening, so dev servers get a public URL the
// moment they boot — the way Codespaces / Gitpod port forwarding feels.

import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';

/** Ports that are almost always dev servers, shared even if already listening at startup. */
export const COMMON_DEV_PORTS = new Set([
  1234, 3000, 3001, 3002, 3003, 3333, 4000, 4173, 4200, 4321, 4322, 5000, 5001, 5173, 5174, 5175, 5500, 6006, 7000, 8000, 8001, 8008,
  8080, 8081, 8888, 9000, 9292, 19006,
]);

// Infrastructure that should never be exposed automatically.
const NEVER = new Set([5432, 3306, 6379, 27017, 9229, 9222, 11211, 2375, 2376, 5037]);

function parseProcNet(text, v6) {
  const ports = new Map();
  for (const line of text.split('\n').slice(1)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 4 || cols[3] !== '0A') continue; // 0A = LISTEN
    const [addrHex, portHex] = cols[1].split(':');
    const port = parseInt(portHex, 16);
    let addr;
    if (!v6) {
      addr = addrHex === '00000000' ? '0.0.0.0' : addrHex === '0100007F' ? '127.0.0.1' : 'other';
    } else {
      if (/^0+$/.test(addrHex)) addr = '::';
      else if (addrHex === '00000000000000000000000001000000') addr = '::1';
      else if (addrHex === '0000000000000000FFFF00000100007F') addr = '127.0.0.1';
      else if (addrHex === '0000000000000000FFFF000000000000') addr = '0.0.0.0';
      else addr = 'other';
    }
    if (addr === 'other') {
      if (!ports.has(port)) ports.set(port, addr);
    } else {
      ports.set(port, addr);
    }
  }
  return ports;
}

function lsofPorts() {
  return new Promise((resolve) => {
    execFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN'], { timeout: 5000 }, (err, stdout) => {
      const ports = new Map();
      if (err && !stdout) return resolve(ports);
      for (const line of String(stdout).split('\n').slice(1)) {
        const m = line.match(/\s(\S+):(\d+) \(LISTEN\)/);
        if (!m) continue;
        const host = m[1].replace(/^\[|\]$/g, '');
        const addr = host === '*' ? '0.0.0.0' : ['127.0.0.1', '::1', 'localhost'].includes(host) ? '127.0.0.1' : 'other';
        ports.set(Number(m[2]), addr);
      }
      resolve(ports);
    });
  });
}

/** @returns {Promise<Map<number, string>>} port -> bind address ('0.0.0.0', '::', '127.0.0.1', '::1' or 'other') */
export async function listeningPorts() {
  if (process.platform === 'linux') {
    const out = new Map();
    for (const [file, v6] of [
      ['/proc/net/tcp', false],
      ['/proc/net/tcp6', true],
    ]) {
      try {
        for (const [p, a] of parseProcNet(fs.readFileSync(file, 'utf8'), v6)) if (!out.has(p) || out.get(p) === 'other') out.set(p, a);
      } catch {}
    }
    return out;
  }
  if (process.platform === 'darwin' || process.platform === 'freebsd') return lsofPorts();
  return new Map();
}

export function watchSupported() {
  return process.platform === 'linux' || process.platform === 'darwin';
}

function ignoredFromEnv() {
  return new Set(
    String(process.env.LOCALCLOUD_IGNORE_PORTS || '')
      .split(/[\s,]+/)
      .filter(Boolean)
      .map(Number),
  );
}

/**
 * Emits 'port' (port) when a new local server starts listening, 'closed' (port) when it goes away.
 * Ports already listening when the watcher starts are skipped unless they're common dev ports
 * (so agent infrastructure such as egress proxies is never exposed by accident).
 */
export class PortWatcher extends EventEmitter {
  /** @param {{interval?: number, includeExisting?: 'dev'|'all'|'none', min?: number, ignore?: number[]}} [opts] */
  constructor(opts = {}) {
    super();
    this.interval = opts.interval ?? 1000;
    this.includeExisting = opts.includeExisting ?? 'dev';
    this.min = opts.min ?? 1024;
    this.ignore = new Set([...(opts.ignore || []), ...ignoredFromEnv()]);
    this.baseline = null;
    this.known = new Set();
    this.timer = null;
  }

  eligible(port, addr) {
    return port >= this.min && addr !== 'other' && !NEVER.has(port) && !this.ignore.has(port);
  }

  async start() {
    this.stopped = false;
    const now = await listeningPorts();
    if (this.stopped) return; // stop() was called while we were reading the port table
    this.baseline = new Set(now.keys());
    for (const [port, addr] of now) {
      this.known.add(port);
      const include = this.includeExisting === 'all' || (this.includeExisting === 'dev' && COMMON_DEV_PORTS.has(port));
      if (include && this.eligible(port, addr)) this.emit('port', port);
    }
    const tick = async () => {
      try {
        const ports = await listeningPorts();
        for (const [port, addr] of ports) {
          if (this.known.has(port)) continue;
          this.known.add(port);
          if (this.eligible(port, addr)) this.emit('port', port);
        }
        for (const port of [...this.known]) {
          if (!ports.has(port)) {
            this.known.delete(port);
            this.baseline.delete(port);
            this.emit('closed', port);
          }
        }
      } catch {}
      if (this.timer) this.timer = setTimeout(tick, this.interval);
    };
    this.timer = setTimeout(tick, this.interval);
  }

  stop() {
    this.stopped = true;
    clearTimeout(this.timer);
    this.timer = null;
  }
}
