// Helpers shared by the Worker entry and the Durable Objects.
//
// The wire protocol, tunnel names and HTML pages are imported straight from
// the Node relay so both relays can never drift apart (this needs the
// `nodejs_compat` flag for Buffer / node:crypto).

import pkg from '../../package.json';
import { HOP_BY_HOP } from '../../src/protocol.js';
import { offlinePage, privatePage, upstreamDownPage } from '../../src/relay/pages.js';

export const VERSION = pkg.version;
export const API = '/__localcloud/';
export const ROUTE_COOKIE = '__lc_t';
export const ACCESS_COOKIE = '__lc_a';
export const ACCESS_PARAM = '__lc_access';
export const POLL_HOLD_MS = 15_000;
export const WAIT_FOR_RECONNECT_MS = 8_000;

// Headers the Worker uses to talk to its Durable Objects. Anything with this
// prefix coming from the internet is stripped before it reaches a DO.
export const INTERNAL = 'x-localcloud-internal-';

const STATUS_TEXT = { 401: 'Unauthorized', 404: 'Not Found', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

export function config(env) {
  const domain = env.DOMAIN ? String(env.DOMAIN).trim().toLowerCase().replace(/^\*\./, '').replace(/\/$/, '') || null : null;
  const routing = env.ROUTING && env.ROUTING !== 'auto' ? env.ROUTING : domain ? 'subdomain' : 'cookie';
  return {
    domain,
    routing,
    insecure: /^(1|true|yes|on)$/i.test(String(env.INSECURE || '')),
    token: env.RELAY_TOKEN || null,
    publicUrl: env.PUBLIC_URL ? String(env.PUBLIC_URL).replace(/\/$/, '') : null,
  };
}

const enc = new TextEncoder();

/** Constant time string comparison. */
export function safeEqual(a, b) {
  const x = enc.encode(String(a));
  const y = enc.encode(String(b));
  if (x.length !== y.length) return false;
  return crypto.subtle.timingSafeEqual(x, y);
}

export function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of String(header).split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    if (!k) continue;
    try {
      out[k] = decodeURIComponent(part.slice(i + 1).trim());
    } catch {
      out[k] = part.slice(i + 1).trim();
    }
  }
  return out;
}

export function stripRelayCookies(value) {
  return String(value)
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s && !s.startsWith('__lc_'))
    .join('; ');
}

export function wantsHtml(request) {
  return request.method === 'GET' && /text\/html/.test(request.headers.get('accept') || '');
}

export function isUpgrade(request) {
  return (request.headers.get('upgrade') || '').toLowerCase() === 'websocket';
}

export function publicProto(request) {
  return new URL(request.url).protocol.replace(/:$/, '');
}

export function baseUrlFor(cfg, request) {
  if (cfg.publicUrl) return cfg.publicUrl;
  const u = new URL(request.url);
  return `${u.protocol}//${u.host}`;
}

export function tunnelUrl(cfg, id, baseUrl) {
  if (cfg.routing === 'subdomain') return `${cfg.insecure ? 'http' : 'https'}://${id}.${cfg.domain}`;
  return `${baseUrl}${API}t/${id}`;
}

export function accessUrl(cfg, id, token, baseUrl) {
  if (cfg.routing === 'subdomain') return `${tunnelUrl(cfg, id, baseUrl)}/?${ACCESS_PARAM}=${token}`;
  return `${tunnelUrl(cfg, id, baseUrl)}?${ACCESS_PARAM}=${token}`;
}

export function publicOrigin(cfg, id, baseUrl) {
  if (cfg.routing === 'subdomain') return `${cfg.insecure ? 'http' : 'https'}://${id}.${cfg.domain}`;
  return baseUrl;
}

export function cookieSecure(request) {
  return publicProto(request) === 'https' ? '; Secure' : '';
}

export function accessCookieName(id) {
  return `${ACCESS_COOKIE}_${id.replace(/[^a-z0-9]/g, '_')}`;
}

export function accessCookie(tunnel, request) {
  return `${accessCookieName(tunnel.id)}=${tunnel.access}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${cookieSecure(request)}`;
}

export function text(status, body, headers = {}) {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store', ...headers } });
}

export function json(status, body) {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
}

export function sendPage(status, html, request) {
  if (request && !wantsHtml(request)) return text(status, `localcloud: ${STATUS_TEXT[status] || 'error'}\n`);
  return new Response(html, { status, headers: { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' } });
}

export function upstreamError(request, tunnel, code, message) {
  const status = code === 'ETIMEDOUT' ? 504 : 502;
  const port = tunnel?.port ?? '?';
  if (wantsHtml(request)) return sendPage(status, upstreamDownPage(tunnel?.id || '?', port, code || message), request);
  return text(status, `localcloud: the local server on port ${port} did not respond (${code || message || 'error'})\n`);
}

export function offline(request, id) {
  return sendPage(503, offlinePage(id), request);
}

/**
 * Access control (access token and/or basic auth). Returns a Response when
 * the request must stop here, or null when it may continue.
 * @param {{id: string, access?: string|null, basicAuth?: string|null}} tunnel
 * @param {Request} request
 */
export function authorize(tunnel, request) {
  const upgrade = isUpgrade(request);
  if (tunnel.access) {
    const url = new URL(request.url);
    const token = url.searchParams.get(ACCESS_PARAM);
    if (token && safeEqual(token, tunnel.access)) {
      if (upgrade) return null;
      url.searchParams.delete(ACCESS_PARAM);
      const location = url.pathname + (url.search || '');
      return new Response(null, { status: 302, headers: { location, 'set-cookie': accessCookie(tunnel, request), 'cache-control': 'no-store' } });
    }
    const cookie = parseCookies(request.headers.get('cookie'))[accessCookieName(tunnel.id)];
    if (!cookie || !safeEqual(cookie, tunnel.access)) {
      if (upgrade) return new Response(null, { status: 404 });
      return sendPage(401, privatePage(), request);
    }
  }
  if (tunnel.basicAuth) {
    const header = request.headers.get('authorization') || '';
    let given = '';
    try {
      given = header.startsWith('Basic ') ? new TextDecoder().decode(Uint8Array.from(atob(header.slice(6)), (c) => c.charCodeAt(0))) : '';
    } catch {}
    if (!safeEqual(given, tunnel.basicAuth)) {
      if (upgrade) return new Response(null, { status: 404 });
      return text(401, 'authentication required\n', { 'www-authenticate': 'Basic realm="localcloud", charset="UTF-8"' });
    }
  }
  return null;
}

/** Request headers forwarded to the local server, as [name, value] pairs. */
export function forwardHeaders(request, tunnel, { upgrade = false } = {}) {
  const connectionTokens = new Set();
  for (const t of (request.headers.get('connection') || '').split(',')) connectionTokens.add(t.trim().toLowerCase());
  const out = [];
  for (const [name, value] of request.headers) {
    if (HOP_BY_HOP.has(name) || connectionTokens.has(name)) continue;
    if (
      name.startsWith('x-forwarded-') ||
      name === 'forwarded' ||
      name === 'x-real-ip' ||
      name === 'x-localcloud-probe' ||
      name.startsWith(INTERNAL) ||
      name.startsWith('cf-') ||
      name === 'cdn-loop' ||
      (tunnel.basicAuth && name === 'authorization')
    )
      continue;
    if (upgrade && name.startsWith('sec-websocket-') && name !== 'sec-websocket-protocol') continue;
    if (name === 'cookie') {
      const v = stripRelayCookies(value);
      if (v) out.push([name, v]);
      continue;
    }
    out.push([name, value]);
  }
  return out;
}
