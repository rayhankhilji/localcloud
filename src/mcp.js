// `localcloud mcp` — a tiny stdio MCP server, so agents that speak MCP can
// share ports as a tool call instead of a shell command.

import readline from 'node:readline';
import { parseTarget } from './client/forward.js';
import { resolveConfig } from './config.js';
import { daemonRequest, daemonStatus, ensureDaemon } from './daemon.js';
import { VERSION } from './version.js';

const TOOLS = [
  {
    name: 'share_port',
    description:
      'Expose a local server (e.g. a dev server on port 3000) at a public HTTPS URL the user can open in their browser. Use this whenever you start a web server the user should see — localhost is not reachable from their machine. Returns the URL.',
    inputSchema: {
      type: 'object',
      properties: {
        port: { type: 'integer', description: 'Local port the server listens on, e.g. 3000 or 5173' },
        name: { type: 'string', description: 'Optional preferred subdomain, e.g. "my-app"' },
        protect: { type: 'boolean', description: 'Make the link private (it will carry an access key)' },
      },
      required: ['port'],
    },
  },
  {
    name: 'list_shared',
    description: 'List local ports currently shared through localcloud and their public URLs.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'stop_sharing',
    description: 'Stop sharing a local port.',
    inputSchema: { type: 'object', properties: { port: { type: 'integer' } }, required: ['port'] },
  },
  {
    name: 'auto_share',
    description: 'Automatically share every dev server that starts listening from now on (and ones already running on common dev ports).',
    inputSchema: { type: 'object', properties: {} },
  },
];

function format(tunnels) {
  if (!tunnels.length) return 'Nothing is shared right now.';
  return tunnels.map((t) => `localhost:${t.port} → ${t.accessUrl || t.url}${t.online === false ? ' (reconnecting)' : ''}`).join('\n');
}

async function callTool(name, args, flags) {
  if (name === 'list_shared') {
    const st = await daemonStatus();
    return format(st?.tunnels || []);
  }
  if (name === 'stop_sharing') {
    await daemonRequest('POST', '/unshare', { target: String(args.port) });
    return `Stopped sharing port ${args.port}.`;
  }
  const cfg = resolveConfig(flags);
  if (!cfg.relay) throw new Error('No relay configured. Set LOCALCLOUD_RELAY or add {"relay": "https://…"} to localcloud.json.');
  await ensureDaemon(cfg);
  if (name === 'auto_share') {
    const st = await daemonRequest('POST', '/watch', { enabled: true });
    return `Auto-sharing is on. New dev servers get a public URL automatically; call list_shared to see them.\n${format(st.tunnels)}`;
  }
  if (name === 'share_port') {
    parseTarget(String(args.port));
    const r = await daemonRequest('POST', '/share', { target: String(args.port), name: args.name, protect: !!args.protect });
    const url = r.tunnel.accessUrl || r.tunnel.url;
    return `${url}\n\nPublic URL for localhost:${args.port}. Share this link with the user.`;
  }
  throw new Error(`unknown tool ${name}`);
}

export async function runMcp(flags = {}) {
  const send = (msg) => process.stdout.write(JSON.stringify(msg) + '\n');
  const rl = readline.createInterface({ input: process.stdin, terminal: false });
  rl.on('line', async (line) => {
    if (!line.trim()) return;
    let msg;
    try {
      msg = JSON.parse(line);
    } catch {
      return send({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'parse error' } });
    }
    const reply = (result) => msg.id !== undefined && send({ jsonrpc: '2.0', id: msg.id, result });
    const fail = (code, message) => msg.id !== undefined && send({ jsonrpc: '2.0', id: msg.id, error: { code, message } });
    switch (msg.method) {
      case 'initialize':
        return reply({
          protocolVersion: msg.params?.protocolVersion || '2025-06-18',
          capabilities: { tools: {} },
          serverInfo: { name: 'localcloud', version: VERSION },
          instructions: 'Use share_port after starting any web/dev server so the user gets a public HTTPS URL instead of an unreachable localhost link.',
        });
      case 'ping':
        return reply({});
      case 'tools/list':
        return reply({ tools: TOOLS });
      case 'tools/call':
        try {
          const text = await callTool(msg.params?.name, msg.params?.arguments || {}, flags);
          return reply({ content: [{ type: 'text', text }] });
        } catch (e) {
          return reply({ content: [{ type: 'text', text: `localcloud error: ${e.message}` }], isError: true });
        }
      default:
        if (msg.method?.startsWith('notifications/')) return;
        return fail(-32601, `method not found: ${msg.method}`);
    }
  });
  await new Promise((r) => rl.once('close', r));
}
