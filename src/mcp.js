// `localcloud mcp` — a tiny, dependency-free stdio MCP server, so agents that
// speak MCP can share ports as a tool call instead of a shell command.
//
// Transport: newline-delimited JSON-RPC 2.0 on stdin/stdout (logs go to stderr only).
// Dual-era: answers the legacy `initialize` handshake (2024-11-05 … 2025-11-25) and the
// stateless per-request `_meta` protocol (2026-07-28, incl. `server/discover`).

import readline from 'node:readline';
import { parseTarget } from './client/forward.js';
import { resolveConfig } from './config.js';
import { daemonRequest, daemonStatus, ensureDaemon } from './daemon.js';
import { VERSION } from './version.js';

export const MODERN_VERSIONS = ['2026-07-28'];
export const LEGACY_VERSIONS = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
export const SUPPORTED_VERSIONS = [...MODERN_VERSIONS, ...LEGACY_VERSIONS];

const META = 'io.modelcontextprotocol/';
const SERVER_INFO = { name: 'localcloud', title: 'localcloud', version: VERSION };
const INSTRUCTIONS =
  'You are likely running somewhere the user cannot open localhost links. After starting any web/dev server the user should see, call share_port with its port and give the user the returned HTTPS URL. Use auto_share to share every dev server automatically, list_shared/get_url to look URLs up again, stop_sharing to take one down. If a tool reports that no relay is configured, ask the user for their relay URL. If it reports a network-policy block, ask them to allow the relay domain in the sandbox network settings.';

const ERR = { PARSE: -32700, INVALID_REQUEST: -32600, NOT_FOUND: -32601, INVALID_PARAMS: -32602, INTERNAL: -32603, UNSUPPORTED_VERSION: -32022 };

const tunnelSchema = {
  type: 'object',
  properties: {
    port: { type: ['integer', 'null'] },
    target: { type: 'string' },
    url: { type: 'string', description: 'Public HTTPS URL to give the user (includes the access key for protected links)' },
    online: { type: 'boolean' },
    protect: { type: 'boolean' },
  },
  required: ['target', 'url'],
};
const portProp = { type: 'integer', minimum: 1, maximum: 65535, description: 'Local port the server listens on, e.g. 3000 or 5173' };

export const TOOLS = [
  {
    name: 'share_port',
    title: 'Share a local port',
    description:
      'Expose a local server (e.g. a dev server on port 3000) at a public HTTPS URL the user can open in their browser. Use this whenever you start a web server the user should see — localhost is not reachable from their machine. Idempotent: sharing an already-shared port returns the same URL. Returns the URL.',
    inputSchema: {
      type: 'object',
      properties: {
        port: portProp,
        name: { type: 'string', description: 'Optional preferred subdomain, e.g. "my-app"' },
        protect: { type: 'boolean', description: 'Make the link private (the URL carries an access key)' },
      },
      required: ['port'],
      additionalProperties: false,
    },
    outputSchema: { type: 'object', properties: { url: { type: 'string' }, port: { type: 'integer' }, tunnel: tunnelSchema }, required: ['url', 'port'] },
    annotations: { title: 'Share a local port', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'get_url',
    title: 'Get the public URL for a port',
    description: 'Look up the public HTTPS URL of a port that is already shared (including ones auto-shared by auto_share). Does not share anything; use share_port for that.',
    inputSchema: { type: 'object', properties: { port: portProp }, required: ['port'], additionalProperties: false },
    outputSchema: { type: 'object', properties: { port: { type: 'integer' }, shared: { type: 'boolean' }, url: { type: ['string', 'null'] } }, required: ['port', 'shared'] },
    annotations: { title: 'Get the public URL for a port', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'list_shared',
    title: 'List shared ports',
    description: 'List local ports currently shared through localcloud, their public URLs, and whether the relay connection is up.',
    inputSchema: { type: 'object', additionalProperties: false },
    outputSchema: {
      type: 'object',
      properties: { running: { type: 'boolean' }, relay: { type: ['string', 'null'] }, connected: { type: 'boolean' }, autoShare: { type: 'boolean' }, tunnels: { type: 'array', items: tunnelSchema } },
      required: ['running', 'tunnels'],
    },
    annotations: { title: 'List shared ports', readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  },
  {
    name: 'stop_sharing',
    title: 'Stop sharing a port',
    description: 'Stop sharing a local port. Its public URL stops working. The local server keeps running.',
    inputSchema: { type: 'object', properties: { port: portProp }, required: ['port'], additionalProperties: false },
    annotations: { title: 'Stop sharing a port', readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
  },
  {
    name: 'auto_share',
    title: 'Auto-share dev servers',
    description:
      'Automatically share every dev server that starts listening from now on (and ones already running on common dev ports). Call list_shared afterwards to see the URLs. Pass enabled: false to turn it off.',
    inputSchema: { type: 'object', properties: { enabled: { type: 'boolean', default: true, description: 'false turns auto-sharing off' } }, additionalProperties: false },
    annotations: { title: 'Auto-share dev servers', readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
  },
];

export const RESOURCES = [
  {
    uri: 'localcloud://status',
    name: 'status',
    title: 'localcloud status',
    description: 'Shared ports, public URLs and relay connection state (JSON).',
    mimeType: 'application/json',
  },
];

class ToolError extends Error {}
class ProtocolError extends Error {
  constructor(code, message, data) {
    super(message);
    this.code = code;
    this.data = data;
  }
}

const tunnelUrl = (t) => t.accessUrl || t.url;
const publicTunnel = (t) => ({ port: t.port ?? null, target: String(t.target ?? t.port), url: tunnelUrl(t) || '', online: t.online !== false, protect: !!t.protect });

function format(tunnels) {
  if (!tunnels.length) return 'Nothing is shared right now.';
  return tunnels.map((t) => `localhost:${t.port} → ${tunnelUrl(t)}${t.online === false ? ' (reconnecting)' : ''}`).join('\n');
}

function checkPort(args) {
  const port = typeof args.port === 'string' && /^\d+$/.test(args.port) ? Number(args.port) : args.port;
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new ToolError(`"port" must be an integer between 1 and 65535 (got ${JSON.stringify(args.port)})`);
  return port;
}

async function statusSnapshot() {
  const st = await daemonStatus();
  if (!st) return { running: false, relay: null, connected: false, autoShare: false, tunnels: [] };
  return { running: true, relay: st.relay || null, connected: !!st.connected, autoShare: !!st.watch, tunnels: (st.tunnels || []).map(publicTunnel) };
}

const text = (t, structuredContent) => ({ content: [{ type: 'text', text: t }], ...(structuredContent !== undefined ? { structuredContent } : {}) });

async function callTool(name, args, flags) {
  if (name === 'list_shared') {
    const snap = await statusSnapshot();
    const head = snap.running ? `${snap.connected ? 'Connected to' : 'Connecting to'} ${snap.relay}${snap.autoShare ? ' · auto-sharing new dev servers' : ''}\n` : '';
    return text(head + format(snap.tunnels), snap);
  }
  if (name === 'get_url') {
    const port = checkPort(args);
    const snap = await statusSnapshot();
    const t = snap.tunnels.find((x) => x.port === port);
    if (!t) return text(`Port ${port} is not shared. Call share_port to share it.`, { port, shared: false, url: null });
    return text(t.url, { port, shared: true, url: t.url });
  }
  if (name === 'stop_sharing') {
    const port = checkPort(args);
    const st = await daemonStatus();
    if (!st) return text(`Port ${port} is not shared (localcloud is not running).`);
    try {
      await daemonRequest('POST', '/unshare', { target: String(port) });
    } catch (e) {
      if (e.status === 404) return text(`Port ${port} was not shared.`);
      throw e;
    }
    return text(`Stopped sharing port ${port}.`);
  }
  if (name === 'share_port') {
    const port = checkPort(args);
    if (args.name !== undefined && typeof args.name !== 'string') throw new ToolError('"name" must be a string');
    parseTarget(String(port));
    await ready(flags);
    const r = await daemonRequest('POST', '/share', { target: String(port), name: args.name || undefined, protect: !!args.protect });
    const url = tunnelUrl(r.tunnel);
    return text(`${url}\n\nPublic URL for localhost:${port}. Share this link with the user.`, { url, port, tunnel: publicTunnel(r.tunnel) });
  }
  if (name === 'auto_share') {
    if (args.enabled === false) {
      const st = await daemonStatus();
      if (st) await daemonRequest('POST', '/watch', { enabled: false });
      return text('Auto-sharing is off. Ports that are already shared stay shared.');
    }
    await ready(flags);
    const st = await daemonRequest('POST', '/watch', { enabled: true });
    return text(`Auto-sharing is on. New dev servers get a public URL automatically; call list_shared to see them.\n${format(st.tunnels || [])}`);
  }
  throw new ProtocolError(ERR.INVALID_PARAMS, `Unknown tool: ${name}`);
}

async function ready(flags) {
  const cfg = resolveConfig(flags);
  if (!cfg.relay) throw new ToolError('No relay configured. Ask the user for their relay URL, then set LOCALCLOUD_RELAY or add {"relay": "https://…"} to localcloud.json in the project.');
  await ensureDaemon(cfg);
}

function friendlyError(e) {
  const m = e.message || String(e);
  if (/blocked by the network policy|HTTP 403|HTTP 407/.test(m)) return `${m}\n\nThe sandbox's network policy is blocking the relay. Ask the user to allow the relay's domain in their environment's network settings.`;
  return m;
}

/**
 * Handle one parsed JSON-RPC message. Returns the response object, or null for notifications.
 * Exported for tests; `runMcp` wires it to stdio.
 */
export async function handleMessage(msg, flags = {}) {
  const isRequest = msg && typeof msg === 'object' && 'method' in msg && msg.id !== undefined && msg.id !== null;
  const isNotification = msg && typeof msg === 'object' && typeof msg.method === 'string' && (msg.id === undefined);
  if (isNotification) return null;
  if (!isRequest || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') {
    // Responses from the client (we never send requests) are ignored.
    if (msg && typeof msg === 'object' && !('method' in msg) && ('result' in msg || 'error' in msg)) return null;
    return { jsonrpc: '2.0', id: msg?.id ?? null, error: { code: ERR.INVALID_REQUEST, message: 'invalid request' } };
  }
  const { id, method } = msg;
  const params = msg.params && typeof msg.params === 'object' ? msg.params : {};
  const meta = params._meta && typeof params._meta === 'object' ? params._meta : {};
  const requested = meta[`${META}protocolVersion`];
  const modern = requested !== undefined;
  const ok = (result) => ({
    jsonrpc: '2.0',
    id,
    result: modern ? { resultType: 'complete', ...result, _meta: { ...(result._meta || {}), [`${META}serverInfo`]: SERVER_INFO } } : result,
  });
  const fail = (code, message, data) => ({ jsonrpc: '2.0', id, error: { code, message, ...(data !== undefined ? { data } : {}) } });

  if (modern) {
    if (!SUPPORTED_VERSIONS.includes(requested)) return fail(ERR.UNSUPPORTED_VERSION, 'Unsupported protocol version', { supported: SUPPORTED_VERSIONS, requested });
    if (MODERN_VERSIONS.includes(requested) && method !== 'server/discover' && (typeof meta[`${META}clientCapabilities`] !== 'object' || meta[`${META}clientCapabilities`] === null)) {
      return fail(ERR.INVALID_PARAMS, `missing _meta["${META}clientCapabilities"]`);
    }
  }

  try {
    switch (method) {
      case 'initialize': {
        const want = params.protocolVersion;
        const protocolVersion = LEGACY_VERSIONS.includes(want) ? want : LEGACY_VERSIONS[0];
        return ok({ protocolVersion, capabilities: { tools: {}, resources: {} }, serverInfo: SERVER_INFO, instructions: INSTRUCTIONS });
      }
      case 'server/discover':
        return ok({ supportedVersions: SUPPORTED_VERSIONS, capabilities: { tools: {}, resources: {} }, _meta: { [`${META}serverInfo`]: SERVER_INFO }, instructions: INSTRUCTIONS });
      case 'ping':
        return ok({});
      case 'tools/list':
        return ok({ tools: TOOLS });
      case 'tools/call': {
        if (typeof params.name !== 'string') return fail(ERR.INVALID_PARAMS, 'tools/call needs a tool "name"');
        const args = params.arguments && typeof params.arguments === 'object' ? params.arguments : {};
        try {
          return ok(await callTool(params.name, args, flags));
        } catch (e) {
          if (e instanceof ProtocolError) throw e;
          return ok({ content: [{ type: 'text', text: `localcloud error: ${friendlyError(e)}` }], isError: true });
        }
      }
      case 'resources/list':
        return ok({ resources: RESOURCES });
      case 'resources/templates/list':
        return ok({ resourceTemplates: [] });
      case 'resources/read': {
        if (params.uri !== 'localcloud://status') return fail(ERR.INVALID_PARAMS, `Resource not found: ${params.uri}`, { uri: params.uri });
        const snap = await statusSnapshot();
        return ok({ contents: [{ uri: params.uri, mimeType: 'application/json', text: JSON.stringify(snap, null, 2) }] });
      }
      case 'prompts/list':
        return ok({ prompts: [] });
      case 'logging/setLevel':
        return ok({});
      default:
        return fail(ERR.NOT_FOUND, `method not found: ${method}`);
    }
  } catch (e) {
    if (e instanceof ProtocolError) return fail(e.code, e.message, e.data);
    return fail(ERR.INTERNAL, e.message || String(e));
  }
}

export async function runMcp(flags = {}) {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  const inflight = new Set();
  rl.on('line', (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: ERR.PARSE, message: 'parse error' } });
    }
    // JSON-RPC batches (legacy 2025-03-26) — answer each element.
    const items = Array.isArray(msg) ? msg : [msg];
    const p = Promise.all(items.map((m) => handleMessage(m, flags))).then((replies) => {
      const out = replies.filter(Boolean);
      if (!out.length) return;
      if (Array.isArray(msg)) send(out);
      else send(out[0]);
    });
    inflight.add(p);
    p.finally(() => inflight.delete(p));
  });
  await new Promise((r) => rl.once('close', r));
  await Promise.allSettled([...inflight]);
}
