import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { Client, FatalError } from './client/client.js';
import { isListening, parseTarget } from './client/forward.js';
import { clientSecret, normalizeRelay, resolveConfig, userConfigPath, writeUserConfig } from './config.js';
import { daemonRequest, daemonStatus, ensureDaemon, paths, runDaemon } from './daemon.js';
import { banner, c, isInteractive, logo, requestLine } from './ui.js';
import { VERSION } from './version.js';
import { PortWatcher, watchSupported } from './watch.js';

const HELP = `
${logo()} ${c.dim(`v${VERSION}`)} — share localhost from anywhere, built for cloud coding agents

${c.bold('Usage')}
  localcloud <port|url>...          Share in the foreground (Ctrl+C to stop)
  localcloud start [port...]        Share in the background and print the URL(s), then exit.
                                    With no port: auto-share every dev server that starts.
  localcloud url <port>             Print just the public URL for a port (shares it if needed)
  localcloud ls                     List what's shared
  localcloud stop [port...]         Stop sharing a port, or stop everything
  localcloud run -- <command>       Run a dev server and share whatever port it opens
  localcloud logs [-f]              Show the background daemon's log
  localcloud doctor                 Check connectivity (proxy, websocket, long-poll)

  localcloud init [--relay <url>]   Teach your coding agents to use localcloud in this repo
                                    --agents <list> | --all, --mcp, --setup, --skill, --no-hook,
                                    --no-detect, --no-claude, --dry-run
  localcloud mcp                    Run as an MCP server (tools: share_port, get_url, list_shared,
                                    stop_sharing, auto_share, status)
  localcloud relay                  Run your own relay server:
                                    --domain <d> [--port <n>] [--token <t>] [--routing <mode>]
                                    [--public-url <url>] [--http] [--trust-proxy=false]
  localcloud config                 Show settings;  config set <key> <value>  /  config unset <key>

${c.bold('Options')}
  --relay <url>          Relay to use              (env LOCALCLOUD_RELAY, or localcloud.json)
  --token <token>        Relay access token        (env LOCALCLOUD_TOKEN)
  --name <name>          Pick the subdomain, e.g. --name my-app → https://my-app.<relay domain>
  --protect              Private link: visitors need the access key in the URL
  --auth <user:pass>     Require HTTP basic auth
  --host-header <mode>   rewrite (default: dev server sees localhost) | preserve | <custom host>
  --transport <mode>     auto (default) | ws | http
  --watch / --no-watch   start: also auto-share new dev servers (default only when no port is given)
  -q, --quiet            Don't print a line per request (foreground)
  --json                 Machine-readable output
  -h, --help / -v, --version

${c.bold('Examples')}
  npx localcloud-cli 3000
  npx localcloud-cli start 5173 --name my-app
  npx localcloud-cli run -- npm run dev
`;

const BOOLEAN = new Set([
  'protect', 'json', 'help', 'version', 'watch', 'no-watch', 'follow', 'quiet', 'insecure', 'http', 'force', 'print',
  // init
  'mcp', 'no-hook', 'all', 'setup', 'skill', 'dry-run', 'no-detect', 'no-claude',
  // relay
  'trust-proxy', 'no-trust-proxy',
]);
const ALIASES = { h: 'help', v: 'version', f: 'follow', n: 'name', p: 'port', q: 'quiet' };

export function parseArgs(argv) {
  const flags = {};
  const positional = [];
  let rest = null;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--') {
      rest = argv.slice(i + 1);
      break;
    }
    if (a.startsWith('--') || (a.startsWith('-') && a.length === 2 && isNaN(Number(a)))) {
      let [key, value] = a.replace(/^--?/, '').split(/=(.*)/s);
      key = ALIASES[key] || key;
      if (BOOLEAN.has(key)) flags[key] = value === undefined ? true : value !== 'false';
      else if (value !== undefined) flags[key] = value;
      else if (i + 1 < argv.length) flags[key] = argv[++i];
      else throw new UsageError(`--${key} needs a value`);
    } else {
      positional.push(a);
    }
  }
  return { flags, positional, rest };
}

class UsageError extends Error {}

const out = (s = '') => process.stdout.write(s + '\n');
const err = (s = '') => process.stderr.write(s + '\n');

function shareOpts(flags) {
  return { name: flags.name, protect: !!flags.protect, basicAuth: flags.auth, hostHeader: flags['host-header'] };
}

function requireRelay(flags) {
  const cfg = resolveConfig(flags);
  if (!cfg.relay) {
    throw new UsageError(`localcloud needs a relay to connect to.

  • Pass one:       npx localcloud-cli 3000 --relay https://your-relay.example.com
  • Set it once:    export LOCALCLOUD_RELAY=https://your-relay.example.com
                    or commit {"relay": "https://…"} as localcloud.json in your repo
  • Run your own:   npx localcloud-cli relay   (free on Fly.io / Render / any VPS — see docs/self-hosting.md)`);
  }
  return cfg;
}

function friendly(e) {
  const m = e.message || String(e);
  if (/blocked by the network policy|HTTP 403|HTTP 407/.test(m)) {
    return `${m}\n\n  Your sandbox's network policy is blocking the relay. Allow its domain in your environment's\n  network settings (e.g. Claude Code → environment → Network access → Allowed domains), then retry.`;
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(m)) return `${m}\n\n  The relay's hostname doesn't resolve. Check the --relay URL (or LOCALCLOUD_RELAY).`;
  return m;
}

// ---------------------------------------------------------------- commands

async function cmdShare(targets, flags) {
  const cfg = requireRelay(flags);
  if (flags.name && targets.length > 1) throw new UsageError('--name only works with a single port');
  const parsed = targets.map((t) => (parseTarget(t), t));
  const client = new Client({ relay: cfg.relay, token: cfg.token, transport: cfg.transport, secret: clientSecret() });
  const json = !!flags.json;
  let shown = false;

  client.on('status', (s) => {
    if (json) return;
    if (s.state === 'error' && !shown) err(c.yellow(`  … can't reach ${cfg.relay} yet: ${friendly(s.error)} (retrying)`));
    if (s.state === 'disconnected') err(c.yellow('  ⚠ connection lost — reconnecting (your URL stays the same)…'));
    if (s.state === 'connected' && shown) err(c.green(`  ✓ reconnected`));
  });
  client.on('tunnel', (t, { changed }) => {
    if (changed && !json) out(`\n  ${c.yellow('URL changed:')} ${c.bold(t.accessUrl || t.url)}\n`);
  });
  client.on('request', (r) => {
    if (!json && !flags.quiet) out(requestLine(r));
  });
  client.on('notice', (m) => err(c.yellow(`  ℹ ${m}`)));
  client.on('fatal', (e) => {
    err(c.red(`✖ ${friendly(e)}`));
    process.exit(1);
  });

  const results = [];
  try {
    for (const t of parsed) results.push(await client.share(t, shareOpts(flags)));
  } catch (e) {
    // e.g. the name is taken: nothing will ever be shared, so don't hang around.
    await client.close();
    throw e;
  }
  shown = true;
  if (json) out(JSON.stringify({ relay: cfg.relay, transport: client.transport?.kind, tunnels: results }));
  else {
    for (const t of results) out(banner(t, { transport: client.transport?.kind }));
    for (const t of results) {
      if (!t.target.includes('://') && !(await isListening(t.port))) {
        out(c.yellow(`  ⚠ nothing is listening on port ${t.port} yet — visitors will see a waiting page until your server starts.`));
      }
    }
    out(c.dim('  Requests will show up below. Ctrl+C to stop.\n'));
  }

  const stop = async () => {
    await client.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  await new Promise(() => {});
}

function printTunnelLines(tunnels, json, extra = {}) {
  if (json) return out(JSON.stringify({ ...extra, tunnels }));
  for (const t of tunnels) {
    const local = /^\d+$/.test(t.target) ? `http://localhost:${t.port}` : t.target;
    const url = t.accessUrl || t.url;
    if (!url) out(`${local} → ${c.yellow('starting…')}`);
    else out(`${local} → ${c.bold(c.cyan(url))}${t.online === false ? c.yellow('  (reconnecting)') : ''}`);
  }
}

async function cmdStart(targets, flags) {
  const cfg = requireRelay(flags);
  const { status, restarted } = await ensureDaemon(cfg);
  if (restarted && !flags.json) err(c.dim('(restarted the background daemon with the new settings)'));
  const results = [];
  const failures = [];
  for (const t of targets) {
    parseTarget(t);
    try {
      const r = await daemonRequest('POST', '/share', { target: t, ...shareOpts(flags) });
      results.push(r.tunnel);
    } catch (e) {
      failures.push(`${t}: ${friendly(e)}`);
    }
  }
  const watch = flags.watch || (!targets.length && !flags['no-watch']);
  let st = status;
  if (watch) {
    try {
      st = await daemonRequest('POST', '/watch', { enabled: true });
    } catch (e) {
      failures.push(`watch: ${e.message}`);
    }
  }
  if (flags.json) {
    out(JSON.stringify({ relay: cfg.relay, watch: !!st?.watch, tunnels: results.length ? results : st?.tunnels || [], errors: failures }));
  } else {
    if (results.length) printTunnelLines(results, false);
    if (watch && st?.watch) {
      const already = (st.tunnels || []).filter((t) => !results.some((r) => r.key === t.key));
      if (already.length) printTunnelLines(already, false);
      out(
        `${c.green('✓')} localcloud is watching for dev servers — any port that starts listening gets a public URL.\n` +
          `  Run ${c.bold('localcloud ls')} (or ${c.bold('localcloud url <port>')}) to see the URLs.`,
      );
    }
    for (const f of failures) err(c.red(`✖ ${f}`));
  }
  if (failures.length && !results.length && !st?.watch) process.exitCode = 1;
}

async function cmdUrl(targets, flags) {
  if (targets.length !== 1) throw new UsageError('usage: localcloud url <port>');
  const cfg = requireRelay(flags);
  await ensureDaemon(cfg);
  const r = await daemonRequest('POST', '/share', { target: targets[0], ...shareOpts(flags) });
  out(flags.json ? JSON.stringify(r.tunnel) : r.tunnel.accessUrl || r.tunnel.url);
}

async function cmdList(flags) {
  const st = await daemonStatus();
  if (!st) {
    if (flags.json) return out(JSON.stringify({ running: false, tunnels: [] }));
    return out(`Nothing is shared. Start with ${c.bold('localcloud start <port>')} (or just ${c.bold('localcloud start')} to auto-share dev servers).`);
  }
  if (flags.json) return out(JSON.stringify({ running: true, ...st }));
  const state = st.connected ? c.green(`connected via ${st.transport === 'ws' ? 'websocket' : 'https long-poll'}`) : c.yellow(`connecting… ${st.error ? `(${st.error})` : ''}`);
  out(`${logo()}  ${c.dim(st.relay)}  ${state}${st.watch ? c.dim('  · auto-sharing new dev servers') : ''}`);
  if (!st.tunnels.length) out(c.dim(st.watch ? '  No dev servers detected yet.' : '  Nothing shared yet.'));
  else printTunnelLines(st.tunnels, false);
}

async function cmdStop(targets, flags) {
  const st = await daemonStatus();
  if (!st) return out(flags.json ? JSON.stringify({ ok: true }) : 'localcloud is not running.');
  if (!targets.length) {
    await daemonRequest('POST', '/shutdown');
    return out(flags.json ? JSON.stringify({ ok: true }) : `${c.green('✓')} stopped localcloud (all tunnels closed).`);
  }
  for (const t of targets) {
    try {
      await daemonRequest('POST', '/unshare', { target: t });
      if (!flags.json) out(`${c.green('✓')} stopped sharing ${t}`);
    } catch (e) {
      err(c.red(`✖ ${e.message}`));
      process.exitCode = 1;
    }
  }
}

async function cmdLogs(flags) {
  const { log } = paths();
  if (!fs.existsSync(log)) return out('No logs yet.');
  const text = fs.readFileSync(log, 'utf8');
  out(text.split('\n').slice(-60).join('\n').trimEnd());
  if (!flags.follow) return;
  let pos = fs.statSync(log).size;
  fs.watchFile(log, { interval: 500 }, (cur) => {
    if (cur.size < pos) pos = 0;
    if (cur.size === pos) return;
    const fd = fs.openSync(log, 'r');
    const buf = Buffer.alloc(cur.size - pos);
    fs.readSync(fd, buf, 0, buf.length, pos);
    fs.closeSync(fd);
    pos = cur.size;
    process.stdout.write(buf);
  });
  await new Promise(() => {});
}

async function cmdRun(command, flags) {
  if (!command?.length) throw new UsageError('usage: localcloud run -- <command>   e.g. localcloud run -- npm run dev');
  const cfg = requireRelay(flags);
  if (!watchSupported()) throw new UsageError('`localcloud run` needs automatic port detection, which is not available on this platform. Use `localcloud <port>` instead.');
  const client = new Client({ relay: cfg.relay, token: cfg.token, transport: cfg.transport, secret: clientSecret() });
  client.on('fatal', (e) => err(c.red(`[localcloud] ✖ ${friendly(e)}`)));
  client.on('notice', (m) => err(c.yellow(`[localcloud] ℹ ${m}`)));
  client.on('status', (s) => {
    if (s.state === 'disconnected') err(c.yellow('[localcloud] connection lost — reconnecting…'));
  });
  client.start();

  const watcher = new PortWatcher({ includeExisting: 'none' });
  await watcher.start();
  let named = false;
  watcher.on('port', async (port) => {
    try {
      const opts = shareOpts(flags);
      if (named) delete opts.name; // the name goes to the first server only
      named = true;
      const t = await client.share(String(port), opts);
      if (flags.json) out(JSON.stringify(t));
      else err(banner(t, { transport: client.transport?.kind }));
    } catch (e) {
      err(c.red(`[localcloud] couldn't share port ${port}: ${friendly(e)}`));
    }
  });

  const child = spawn(command[0], command.slice(1), { stdio: 'inherit', shell: process.platform === 'win32' });
  const forwardSignal = (sig) => child.kill(sig);
  process.on('SIGINT', forwardSignal);
  process.on('SIGTERM', forwardSignal);
  child.on('error', (e) => {
    err(c.red(`[localcloud] failed to start ${command[0]}: ${e.message}`));
    process.exit(127);
  });
  child.on('exit', async (code, signal) => {
    watcher.stop();
    await client.close();
    process.exit(code ?? (signal ? 1 : 0));
  });
}

async function cmdDoctor(flags) {
  const { request, createAgent, getCA, proxyFor } = await import('./net.js');
  const { WsClientTransport, HttpClientTransport } = await import('./client/transports.js');
  const cfg = resolveConfig(flags);
  const ok = (s) => out(`  ${c.green('✓')} ${s}`);
  const bad = (s) => out(`  ${c.red('✖')} ${s}`);
  const info = (s) => out(`  ${c.dim('•')} ${s}`);
  out(`\n${logo()} doctor\n`);
  info(`node ${process.version} on ${process.platform}, localcloud ${VERSION}`);
  if (!cfg.relay) {
    bad('no relay configured (use --relay, LOCALCLOUD_RELAY or localcloud.json)');
    process.exitCode = 1;
    return;
  }
  info(`relay ${c.bold(cfg.relay)} ${c.dim(`(from ${cfg.relaySource})`)}`);
  const relayUrl = new URL(cfg.relay);
  const proxy = proxyFor(relayUrl);
  info(proxy ? `egress proxy ${proxy.host} (from HTTPS_PROXY)` : 'no egress proxy');
  info(getCA() ? 'extra CA certificates loaded (TLS-intercepting proxies are fine)' : 'using Node.js default CAs');

  let healthy = false;
  try {
    const t0 = Date.now();
    const res = await request(new URL('/__localcloud/health', cfg.relay), { agent: createAgent(relayUrl), timeout: 10_000 });
    const body = JSON.parse(res.body.toString() || '{}');
    if (res.status === 200 && body.service === 'localcloud') {
      healthy = true;
      ok(`relay reachable in ${Date.now() - t0}ms (relay v${body.version}, ${body.routing} routing)`);
    } else bad(`relay answered HTTP ${res.status} — is that URL a localcloud relay?`);
  } catch (e) {
    bad(`can't reach the relay: ${friendly(e)}`);
  }
  if (healthy) {
    try {
      const t = await WsClientTransport.connect(cfg.relay, { timeout: 8000 });
      t.close();
      ok('websocket transport works (fastest)');
    } catch (e) {
      info(`websocket transport unavailable: ${e.message} — localcloud will use long-polling`);
    }
    try {
      const t = await HttpClientTransport.connect(cfg.relay);
      t.close();
      ok('https long-poll transport works (fallback)');
    } catch (e) {
      bad(`long-poll transport failed: ${e.message}`);
    }
  }
  const st = await daemonStatus();
  info(st ? `background daemon running (pid ${st.pid}), ${st.tunnels.length} tunnel(s)` : 'background daemon not running');
  out('');
  if (!healthy) process.exitCode = 1;
}

async function cmdRelay(flags) {
  const { Relay } = await import('./relay/server.js');
  const env = process.env;
  const insecure = !!(flags.insecure || flags.http);
  const trustProxy = flags['no-trust-proxy'] ? false : flags['trust-proxy'] !== undefined ? !!flags['trust-proxy'] : undefined; // undefined: LOCALCLOUD_TRUST_PROXY, default on
  const relay = new Relay({
    trustProxy,
    domain: flags.domain || env.LOCALCLOUD_DOMAIN,
    publicUrl: flags['public-url'] || env.LOCALCLOUD_PUBLIC_URL,
    routing: flags.routing || env.LOCALCLOUD_ROUTING,
    token: flags.token || env.LOCALCLOUD_RELAY_TOKEN,
    insecure: insecure || env.LOCALCLOUD_INSECURE === '1',
    log: (m) => console.log(`${new Date().toISOString()} ${m}`),
  });
  const port = Number(flags.port || env.PORT || 8080);
  const host = flags.host || env.HOST || '0.0.0.0';
  await relay.listen({ port, host, tlsCert: flags['tls-cert'] || env.LOCALCLOUD_TLS_CERT, tlsKey: flags['tls-key'] || env.LOCALCLOUD_TLS_KEY });
  out(`${logo()} relay ${VERSION} listening on ${host}:${port}`);
  out(`  routing: ${relay.routing}${relay.domain ? ` (*.${relay.domain})` : ' (single domain; set --domain for <id>.<domain> URLs)'}`);
  out(`  clients: ${relay.token ? 'token required' : 'open to anyone (set LOCALCLOUD_RELAY_TOKEN to restrict)'}`);
  const stop = async () => {
    await relay.close();
    process.exit(0);
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
}

async function cmdConfig(args, flags) {
  if (args[0] === 'set') {
    const [, key, value] = args;
    if (!['relay', 'token', 'transport'].includes(key) || value === undefined) throw new UsageError('usage: localcloud config set <relay|token|transport> <value>');
    const file = writeUserConfig({ [key]: key === 'relay' ? normalizeRelay(value) : value });
    return out(`${c.green('✓')} saved ${key} to ${file}`);
  }
  if (args[0] === 'unset') {
    if (!['relay', 'token', 'transport'].includes(args[1])) throw new UsageError('usage: localcloud config unset <relay|token|transport>');
    const file = writeUserConfig({ [args[1]]: null });
    return out(`${c.green('✓')} removed ${args[1]} from ${file}`);
  }
  const cfg = resolveConfig(flags);
  const data = { relay: cfg.relay || null, relaySource: cfg.relaySource, token: cfg.token ? '(set)' : null, transport: cfg.transport, userConfig: userConfigPath(), projectConfig: cfg.project?.file || null };
  out(flags.json ? JSON.stringify(data) : Object.entries(data).map(([k, v]) => `${k.padEnd(14)} ${v ?? c.dim('—')}`).join('\n'));
}

// ---------------------------------------------------------------- main

const COMMANDS = new Set(['share', 'start', 'up', 'url', 'ls', 'list', 'status', 'stop', 'down', 'logs', 'run', 'doctor', 'relay', 'init', 'mcp', 'config', 'help', '__daemon']);

export async function main(argv) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    err(c.red(e.message));
    process.exitCode = 2;
    return 2;
  }
  const { flags, positional, rest } = parsed;
  if (flags.version) return out(VERSION);
  let [cmd, ...args] = positional;
  if (cmd && !COMMANDS.has(cmd)) {
    args = positional;
    cmd = 'share';
  }
  if (!cmd || cmd === 'help' || flags.help) {
    if (!cmd && rest) cmd = 'run';
    else return out(HELP);
  }
  try {
    const code = await dispatch(cmd, args, flags, rest);
    // Commands report failures through process.exitCode or a numeric return value.
    if (typeof code === 'number' && code) process.exitCode = code;
    return code;
  } catch (e) {
    if (e instanceof UsageError) err(e.message);
    else if (e instanceof FatalError) err(c.red(`✖ ${friendly(e)}`));
    else err(c.red(`✖ ${friendly(e)}`));
    if (process.env.LOCALCLOUD_DEBUG && !(e instanceof UsageError)) err(e.stack);
    process.exitCode = e instanceof UsageError ? 2 : 1;
  }
}

async function dispatch(cmd, args, flags, rest) {
  switch (cmd) {
    case 'share':
      if (!args.length) throw new UsageError('which port? e.g. localcloud 3000');
      return await cmdShare(args, flags);
    case 'start':
    case 'up':
      return await cmdStart(args, flags);
    case 'url':
      return await cmdUrl(args, flags);
    case 'ls':
    case 'list':
    case 'status':
      return await cmdList(flags);
    case 'stop':
    case 'down':
      return await cmdStop(args, flags);
    case 'logs':
      return await cmdLogs(flags);
    case 'run':
      return await cmdRun(rest || args, flags);
    case 'doctor':
      return await cmdDoctor(flags);
    case 'relay':
      return await cmdRelay(flags);
    case 'config':
      return await cmdConfig(args, flags);
    case 'init': {
      const { runInit } = await import('./init.js');
      return await runInit(flags);
    }
    case 'mcp': {
      const { runMcp } = await import('./mcp.js');
      return await runMcp(flags);
    }
    case '__daemon':
      return await runDaemon();
  }
}

export { isInteractive };
