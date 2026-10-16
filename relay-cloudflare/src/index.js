// localcloud relay for Cloudflare Workers + Durable Objects.
//
//   browser ──> Worker ──(registry lookup, cached)──> Session DO ──WebSocket/long-poll──> localcloud client
//
// The Worker is stateless: it routes `<id>.<DOMAIN>` (or the cookie-routing
// entry point) to the Session DO that holds the client's connection, and
// `/__localcloud/*` API calls to the right place. See README.md.

import { PROTOCOL_VERSION } from '../../src/protocol.js';
import { landingPage, notFoundPage } from '../../src/relay/pages.js';
import {
  ACCESS_PARAM,
  API,
  INTERNAL,
  ROUTE_COOKIE,
  VERSION,
  WAIT_FOR_RECONNECT_MS,
  accessCookie,
  authorize,
  baseUrlFor,
  config,
  cookieSecure,
  isUpgrade,
  json,
  offline,
  parseCookies,
  publicOrigin,
  publicProto,
  safeEqual,
  sendPage,
  text,
} from './common.js';

export { Registry } from './registry.js';
export { Session } from './session.js';

// Per-isolate cache of tunnel id -> session DO id. Staleness is harmless: a
// session that no longer serves a tunnel re-routes the request itself.
const ROUTE_TTL_MS = 15_000;
const routeCache = new Map();

function cacheGet(id) {
  const hit = routeCache.get(id);
  if (!hit) return null;
  if (hit.exp < Date.now()) {
    routeCache.delete(id);
    return null;
  }
  return hit.session;
}

function cachePut(id, session) {
  if (routeCache.size > 10_000) routeCache.clear();
  routeCache.set(id, { session, exp: Date.now() + ROUTE_TTL_MS });
}

const registry = (env) => env.REGISTRY.get(env.REGISTRY.idFromName('registry'));

/** Which tunnel (if any) does this request target? */
function route(cfg, request, url) {
  const host = (request.headers.get('host') || url.host).toLowerCase();
  if (cfg.domain) {
    const h = cfg.domain.includes(':') ? host : host.replace(/:\d+$/, '');
    const suffix = '.' + cfg.domain;
    if (h.endsWith(suffix)) {
      const label = h.slice(0, -suffix.length);
      if (label && !label.includes('.')) return { id: label, via: 'host' };
    }
  }
  if (cfg.routing === 'cookie' && !url.pathname.startsWith(API)) {
    const id = parseCookies(request.headers.get('cookie'))[ROUTE_COOKIE];
    if (id) return { id, via: 'cookie' };
  }
  return null;
}

/** Copy of the request with our internal headers (and nothing spoofed). */
function internalRequest(request, fields, init = {}) {
  const headers = new Headers();
  for (const [k, v] of request.headers) if (!k.startsWith(INTERNAL)) headers.append(k, v);
  for (const [k, v] of Object.entries(fields)) if (v != null) headers.set(INTERNAL + k, String(v));
  return new Request(request, { headers, ...init });
}

function remoteIp(request) {
  return request.headers.get('cf-connecting-ip') || request.headers.get('x-real-ip') || '';
}

async function handleTunnelRequest(cfg, env, route, request) {
  const id = route.id;
  const baseUrl = baseUrlFor(cfg, request);
  const forward = (session) =>
    env.SESSION.get(env.SESSION.idFromString(session)).fetch(
      internalRequest(request, {
        op: 'tunnel',
        tunnel: id,
        via: route.via,
        remote: remoteIp(request),
        proto: publicProto(request),
        origin: publicOrigin(cfg, id, baseUrl),
      }),
    );

  const cached = cacheGet(id);
  if (cached) return forward(cached);

  const reg = registry(env);
  let tunnel = await reg.lookup(id);
  if (!tunnel) {
    if (route.via === 'cookie') {
      // Stale routing cookie: forget it and show the relay instead.
      return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': `${ROUTE_COOKIE}=; Path=/; Max-Age=0` } });
    }
    return sendPage(404, notFoundPage(id), request);
  }
  if (tunnel.session) {
    cachePut(id, tunnel.session);
    return forward(tunnel.session);
  }
  // Known but offline: same behaviour as the Node relay (auth first, then wait a little for a reconnect).
  const denied = authorize(tunnel, request);
  if (denied) return denied;
  const probe = request.headers.has('x-localcloud-probe');
  if (probe) return new Response(null, { status: 503, headers: { 'cache-control': 'no-store' } });
  const r = await reg.waitOnline(id, WAIT_FOR_RECONNECT_MS);
  if (r.missing) return sendPage(404, notFoundPage(id), request);
  if (!r.tunnel.session) return isUpgrade(request) ? new Response(null, { status: 503 }) : offline(request, id);
  cachePut(id, r.tunnel.session);
  return forward(r.tunnel.session);
}

function sessionStub(env, sid) {
  const [hex, token] = String(sid || '').split('.');
  if (!hex || !token || !/^[0-9a-f]{64}$/.test(hex)) return null;
  try {
    return { stub: env.SESSION.get(env.SESSION.idFromString(hex)), token };
  } catch {
    return null;
  }
}

async function handleApi(cfg, env, request, url) {
  const path = url.pathname.slice(API.length - 1);
  const gone = () => new Response(null, { status: 410, headers: { 'cache-control': 'no-store' } });

  if (path === '/health') {
    let tunnels;
    try {
      tunnels = (await registry(env).count()).online;
    } catch {}
    return json(200, { ok: true, service: 'localcloud', version: VERSION, protocol: PROTOCOL_VERSION, routing: cfg.routing, tunnels, runtime: 'cloudflare-workers' });
  }

  if (path === '/ws') {
    if (!isUpgrade(request)) return text(426, 'expected a websocket upgrade\n', { upgrade: 'websocket' });
    const stub = env.SESSION.get(env.SESSION.newUniqueId());
    return stub.fetch(internalRequest(request, { op: 'ws', base: baseUrlFor(cfg, request), remote: remoteIp(request) }));
  }

  if (path === '/http/session' && request.method === 'POST') {
    const stub = env.SESSION.get(env.SESSION.newUniqueId());
    return stub.fetch(internalRequest(request, { op: 'poll-session', base: baseUrlFor(cfg, request), remote: remoteIp(request) }));
  }

  const pollOps = { '/http/up': 'poll-up', '/http/down': 'poll-down', '/http/close': 'poll-close' };
  if (pollOps[path] && request.method === 'POST') {
    const s = sessionStub(env, url.searchParams.get('sid'));
    if (!s) return gone();
    return s.stub.fetch(internalRequest(request, { op: pollOps[path], token: s.token }));
  }

  if (path.startsWith('/t/')) {
    // Cookie routing entry point: /__localcloud/t/<id>?__lc_access=…
    let id;
    try {
      id = decodeURIComponent(path.slice(3)).split('/')[0];
    } catch {
      return text(400, 'bad tunnel id\n');
    }
    const tunnel = await registry(env).lookup(id);
    if (!tunnel) return sendPage(404, notFoundPage(id), request);
    const headers = new Headers({ location: '/', 'cache-control': 'no-store' });
    headers.append('set-cookie', `${ROUTE_COOKIE}=${encodeURIComponent(id)}; Path=/; HttpOnly; SameSite=Lax${cookieSecure(request)}`);
    const token = url.searchParams.get(ACCESS_PARAM);
    if (tunnel.access && token && safeEqual(token, tunnel.access)) headers.append('set-cookie', accessCookie(tunnel, request));
    return new Response(null, { status: 302, headers });
  }

  if (path === '/exit') {
    return new Response(null, { status: 302, headers: { location: '/', 'set-cookie': `${ROUTE_COOKIE}=; Path=/; Max-Age=0` } });
  }

  return text(404, 'unknown localcloud endpoint\n');
}

export default {
  /** @param {Request} request */
  async fetch(request, env) {
    const cfg = config(env);
    const url = new URL(request.url);
    try {
      const r = route(cfg, request, url);
      if (r) return await handleTunnelRequest(cfg, env, r, request);
      if (url.pathname.startsWith(API)) return await handleApi(cfg, env, request, url);
      if (url.pathname === '/' || url.pathname === '/index.html') {
        return new Response(landingPage({ relayUrl: baseUrlFor(cfg, request), version: VERSION, routing: cfg.routing }), {
          headers: { 'content-type': 'text/html; charset=utf-8' },
        });
      }
      if (url.pathname === '/robots.txt') return text(200, 'User-agent: *\nDisallow: /\n');
      return text(404, 'not found\n');
    } catch (err) {
      console.log(`relay error: ${err.stack || err}`);
      return text(500, 'localcloud relay error\n');
    }
  },
};
