// Outbound networking that survives the sandboxes cloud agents run in:
// HTTP(S) proxies via CONNECT, NO_PROXY, and TLS-intercepting proxies whose
// CA lives in NODE_EXTRA_CA_CERTS / SSL_CERT_FILE / the system store.

import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import tls from 'node:tls';

const CA_ENV_VARS = ['NODE_EXTRA_CA_CERTS', 'SSL_CERT_FILE', 'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'GIT_SSL_CAINFO'];
const SYSTEM_CA_FILES = [
  '/etc/ssl/certs/ca-certificates.crt', // Debian / Ubuntu / Alpine
  '/etc/pki/tls/certs/ca-bundle.crt', // Fedora / RHEL
  '/etc/ssl/ca-bundle.pem', // openSUSE
  '/etc/ssl/cert.pem', // macOS / Alpine
];

let caCache;

/** Root CAs plus every extra bundle we can find. Undefined means "Node defaults are enough". */
export function getCA() {
  if (caCache !== undefined) return caCache || undefined;
  const files = new Set();
  for (const name of CA_ENV_VARS) if (process.env[name]) files.add(process.env[name]);
  for (const f of SYSTEM_CA_FILES) files.add(f);
  const extra = [];
  for (const f of files) {
    try {
      const pem = fs.readFileSync(f, 'utf8');
      if (pem.includes('BEGIN CERTIFICATE')) extra.push(pem);
    } catch {}
  }
  caCache = extra.length ? [...tls.rootCertificates, ...extra] : null;
  return caCache || undefined;
}

function envProxy(protocol) {
  const e = process.env;
  const list =
    protocol === 'https:' || protocol === 'wss:'
      ? [e.HTTPS_PROXY, e.https_proxy, e.ALL_PROXY, e.all_proxy]
      : [e.HTTP_PROXY, e.http_proxy, e.ALL_PROXY, e.all_proxy];
  return list.find((v) => v && v.trim()) || null;
}

function ipv4ToInt(ip) {
  return ip.split('.').reduce((acc, o) => (acc << 8) + Number(o), 0) >>> 0;
}

/** @param {string} host @param {number} port @param {string} noProxy */
export function matchesNoProxy(host, port, noProxy) {
  if (!noProxy) return false;
  host = host.toLowerCase().replace(/^\[|\]$/g, '');
  for (let entry of noProxy.split(/[\s,]+/)) {
    entry = entry.trim().toLowerCase();
    if (!entry) continue;
    if (entry === '*') return true;
    let entryPort = null;
    const m = entry.match(/^(.*):(\d+)$/);
    if (m && !entry.includes('::')) {
      entry = m[1];
      entryPort = Number(m[2]);
    }
    if (entryPort && entryPort !== port) continue;
    entry = entry.replace(/^\[|\]$/g, '');
    if (entry.includes('/') && net.isIPv4(host)) {
      const [base, bits] = entry.split('/');
      if (net.isIPv4(base)) {
        const mask = Number(bits) === 0 ? 0 : (~0 << (32 - Number(bits))) >>> 0;
        if ((ipv4ToInt(host) & mask) === (ipv4ToInt(base) & mask)) return true;
      }
      continue;
    }
    if (entry.startsWith('*.')) entry = entry.slice(1);
    if (entry.startsWith('.')) {
      if (host.endsWith(entry) || host === entry.slice(1)) return true;
    } else if (host === entry || host.endsWith('.' + entry)) {
      return true;
    }
  }
  return false;
}

/**
 * Which proxy (if any) should be used to reach `url`.
 * @param {URL} url
 * @param {{proxy?: string|null, noProxy?: string}} [opts] explicit overrides (null = no proxy)
 */
export function proxyFor(url, opts = {}) {
  const proxy = opts.proxy !== undefined ? opts.proxy : envProxy(url.protocol);
  if (!proxy) return null;
  const noProxy = opts.noProxy !== undefined ? opts.noProxy : process.env.NO_PROXY ?? process.env.no_proxy ?? '';
  const port = Number(url.port) || (url.protocol === 'https:' || url.protocol === 'wss:' ? 443 : 80);
  if (matchesNoProxy(url.hostname, port, noProxy)) return null;
  return new URL(proxy.includes('://') ? proxy : `http://${proxy}`);
}

export class ProxyError extends Error {
  constructor(message, status) {
    super(message);
    this.code = 'EPROXY';
    this.status = status;
  }
}

/** Open a raw TCP tunnel to host:port through an HTTP(S) proxy. */
export function connectThroughProxy(proxyUrl, host, port, timeout = 15000) {
  return new Promise((resolve, reject) => {
    const isHttps = proxyUrl.protocol === 'https:';
    const headers = { host: `${host}:${port}` };
    if (proxyUrl.username) {
      const cred = `${decodeURIComponent(proxyUrl.username)}:${decodeURIComponent(proxyUrl.password)}`;
      headers['proxy-authorization'] = 'Basic ' + Buffer.from(cred).toString('base64');
    }
    const req = (isHttps ? https : http).request({
      host: proxyUrl.hostname.replace(/^\[|\]$/g, ''),
      port: Number(proxyUrl.port) || (isHttps ? 443 : 80),
      method: 'CONNECT',
      path: `${host.includes(':') ? `[${host}]` : host}:${port}`,
      headers,
      agent: false,
      ca: isHttps ? getCA() : undefined,
    });
    const timer = setTimeout(() => req.destroy(new ProxyError(`proxy CONNECT to ${host} timed out`)), timeout);
    req.once('connect', (res, socket, head) => {
      clearTimeout(timer);
      if (res.statusCode !== 200) {
        socket.destroy();
        const hint = res.statusCode === 403 || res.statusCode === 407 ? ' (blocked by the network policy?)' : '';
        reject(new ProxyError(`proxy refused CONNECT to ${host}:${port}: HTTP ${res.statusCode}${hint}`, res.statusCode));
        return;
      }
      if (head && head.length) socket.unshift(head);
      resolve(socket);
    });
    req.once('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
    req.end();
  });
}

/**
 * An http(s).Agent that transparently tunnels through the configured proxy.
 * Works with node:http(s) requests and with the `ws` WebSocket client.
 * @param {URL|string} target
 * @param {{proxy?: string|null, noProxy?: string, keepAlive?: boolean}} [opts]
 */
export function createAgent(target, opts = {}) {
  const url = typeof target === 'string' ? new URL(target) : target;
  const secure = url.protocol === 'https:' || url.protocol === 'wss:';
  const proxy = proxyFor(url, opts);
  const ca = secure ? getCA() : undefined;
  const Base = secure ? https.Agent : http.Agent;
  const agentOpts = { keepAlive: opts.keepAlive ?? true, keepAliveMsecs: 10_000, maxSockets: 8 };
  if (ca) agentOpts.ca = ca;

  class TunnelAgent extends Base {
    createConnection(options, cb) {
      if (!proxy) return super.createConnection(options, cb);
      const host = options.host || options.hostname || url.hostname;
      const port = Number(options.port) || (secure ? 443 : 80);
      connectThroughProxy(proxy, host, port).then(
        (socket) => {
          if (!secure) return cb(null, socket);
          const tlsSocket = tls.connect({
            socket,
            servername: net.isIP(host) ? undefined : host,
            ca,
            ALPNProtocols: ['http/1.1'],
          });
          let done = false;
          tlsSocket.once('secureConnect', () => {
            done = true;
            cb(null, tlsSocket);
          });
          tlsSocket.once('error', (err) => {
            if (!done) cb(err);
          });
        },
        (err) => cb(err),
      );
      return undefined;
    }
  }
  const agent = new TunnelAgent(agentOpts);
  agent.proxy = proxy;
  return agent;
}

/**
 * Small promise wrapper around http(s).request.
 * @returns {Promise<{status: number, headers: import('node:http').IncomingHttpHeaders, body: Buffer}>}
 */
export function request(url, { method = 'GET', headers = {}, body, agent, timeout = 30_000, signal } = {}) {
  const u = typeof url === 'string' ? new URL(url) : url;
  const mod = u.protocol === 'https:' ? https : http;
  return new Promise((resolve, reject) => {
    const req = mod.request(u, { method, headers, agent, signal }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode || 0, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on('error', reject);
    });
    req.setTimeout(timeout, () => req.destroy(Object.assign(new Error(`request to ${u.host} timed out`), { code: 'ETIMEDOUT' })));
    req.on('error', reject);
    req.end(body);
  });
}
