// Tests for `localcloud init` (src/init.js), the MCP server (src/mcp.js) and the shipped
// integration assets (skills/, .claude-plugin/, integrations/, server.json).

import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, test } from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'bin', 'localcloud.js');
const { init, skillMarkdown, copilotSetupSteps, applyBlock, agentInstructions, upsertClaudeHook, upsertMcpJson, flagOn } = await import(path.join(ROOT, 'src', 'init.js'));
const mcp = await import(path.join(ROOT, 'src', 'mcp.js'));

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'localcloud-integrations-'));
let n = 0;
function tmp(files = {}) {
  const dir = path.join(tmpRoot, `t${++n}`);
  fs.mkdirSync(dir, { recursive: true });
  for (const [rel, content] of Object.entries(files)) {
    const file = path.join(dir, rel);
    if (content === null) fs.mkdirSync(file, { recursive: true });
    else {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
  }
  return dir;
}
const read = (dir, rel) => fs.readFileSync(path.join(dir, rel), 'utf8');
const has = (dir, rel) => fs.existsSync(path.join(dir, rel));
const readJson = (dir, rel) => JSON.parse(read(dir, rel));
function snapshot(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else out[path.relative(dir, p)] = fs.readFileSync(p, 'utf8');
    }
  };
  walk(dir);
  return out;
}

after(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

describe('localcloud init', () => {
  test('defaults: AGENTS.md, CLAUDE.md and the Claude hook only', () => {
    const dir = tmp();
    const r = init({ dir });
    assert.deepEqual(Object.keys(snapshot(dir)).sort(), ['.claude/settings.json', 'AGENTS.md', 'CLAUDE.md']);
    assert.equal(r.files['AGENTS.md'], 'created');
    assert.match(read(dir, 'AGENTS.md'), /^# Agent instructions\n\n<!-- localcloud:start -->/);
    assert.match(read(dir, 'AGENTS.md'), /npx -y localcloud-cli start <port>/);
    assert.equal(read(dir, 'CLAUDE.md'), '@AGENTS.md\n');
    const hook = readJson(dir, '.claude/settings.json').hooks.SessionStart;
    assert.equal(hook.length, 1);
    assert.equal(hook[0].matcher, 'startup|resume');
    assert.match(hook[0].hooks[0].command, /CLAUDE_CODE_REMOTE.*localcloud-cli start/);
    assert.deepEqual(Object.keys(r.agents), ['agents', 'claude']);
  });

  test('is idempotent: a second run changes nothing', () => {
    const dir = tmp({ '.cursor/': null, '.vscode/': null, 'GEMINI.md': '# Gemini\n', '.clinerules': 'Be nice.\n' });
    init({ dir, mcp: true, setup: true, all: true, relay: 'relay.example.com' });
    const first = snapshot(dir);
    const r = init({ dir, mcp: true, setup: true, all: true, relay: 'relay.example.com' });
    assert.deepEqual(snapshot(dir), first);
    for (const x of r.changes) assert.ok(['unchanged', 'skipped'].includes(x.action), `${x.file} was ${x.action}`);
  });

  test('keeps user content and updates the block in place', () => {
    const old = '<!-- localcloud:start -->\nold instructions\n<!-- localcloud:end -->';
    const dir = tmp({ 'AGENTS.md': `# Mine\n\nBuild with make.\n\n${old}\n\n## After\nkeep me\n`, 'CLAUDE.md': '# Claude rules\nUse tabs.\n' });
    const r = init({ dir });
    const agents = read(dir, 'AGENTS.md');
    assert.equal(r.files['AGENTS.md'], 'updated');
    assert.match(agents, /^# Mine\n\nBuild with make\.\n\n<!-- localcloud:start -->/);
    assert.match(agents, /<!-- localcloud:end -->\n\n## After\nkeep me\n$/);
    assert.doesNotMatch(agents, /old instructions/);
    assert.equal(agents.match(/localcloud:start/g).length, 1);
    const claude = read(dir, 'CLAUDE.md');
    assert.match(claude, /^# Claude rules\nUse tabs\.\n\n<!-- localcloud:start -->/);
  });

  test('CLAUDE.md / GEMINI.md that import AGENTS.md are left alone', () => {
    const dir = tmp({ 'CLAUDE.md': '# x\n@AGENTS.md\n', 'GEMINI.md': '@./AGENTS.md\n' });
    const r = init({ dir });
    assert.equal(r.files['CLAUDE.md'], 'unchanged');
    assert.equal(r.files['GEMINI.md'], 'unchanged');
    assert.equal(read(dir, 'CLAUDE.md'), '# x\n@AGENTS.md\n');
  });

  test('auto-detects tools from existing config and writes their files', () => {
    const dir = tmp({
      '.cursor/': null,
      '.github/copilot-instructions.md': '# Copilot\nUse pnpm.\n',
      '.windsurf/': null,
      '.clinerules/': null,
      '.gemini/': null,
      '.claude/skills/': null,
      '.replit': 'run = "npm run dev"\n',
    });
    const r = init({ dir });
    assert.deepEqual(Object.keys(r.agents).sort(), ['agents', 'claude', 'cline', 'copilot', 'cursor', 'gemini', 'replit', 'skill', 'windsurf']);
    assert.match(read(dir, '.cursor/rules/localcloud.mdc'), /^---\ndescription: .+\nalwaysApply: true\n---\n\n<!-- localcloud:start -->/);
    assert.match(read(dir, '.github/copilot-instructions.md'), /^# Copilot\nUse pnpm\.\n\n<!-- localcloud:start -->/);
    assert.match(read(dir, '.windsurf/rules/localcloud.md'), /^---\ntrigger: always_on\n---\n/);
    assert.match(read(dir, '.clinerules/localcloud.md'), /^<!-- localcloud:start -->/);
    assert.equal(read(dir, 'GEMINI.md'), '@./AGENTS.md\n');
    assert.match(read(dir, '.claude/skills/localcloud/SKILL.md'), /^---\nname: localcloud\ndescription: .+\n---\n\n<!-- localcloud:start -->/);
    assert.match(read(dir, 'replit.md'), /localcloud:start/);
    // MCP-only targets need --mcp; nothing for vscode/codex here.
    assert.ok(!has(dir, '.mcp.json') && !has(dir, '.cursor/mcp.json'));
  });

  test('does not write tool files for tools that are not set up', () => {
    const dir = tmp({ '.github/workflows/ci.yml': 'on: push\n' });
    init({ dir, mcp: true, setup: true });
    assert.ok(!has(dir, '.github/copilot-instructions.md'));
    assert.ok(!has(dir, '.github/workflows/copilot-setup-steps.yml'));
    assert.ok(!has(dir, '.cursor'));
    assert.ok(has(dir, '.mcp.json'), 'Claude Code MCP config is part of the defaults');
  });

  test('.clinerules as a single file gets the block appended', () => {
    const dir = tmp({ '.clinerules': 'Always write tests.\n' });
    init({ dir });
    assert.match(read(dir, '.clinerules'), /^Always write tests\.\n\n<!-- localcloud:start -->/);
    assert.ok(fs.statSync(path.join(dir, '.clinerules')).isFile());
  });

  test('--agents forces tools; --all forces everything; unknown names throw', () => {
    const dir = tmp();
    const r = init({ dir, agents: 'cursor, github-copilot' });
    assert.equal(r.agents.cursor, '--agents');
    assert.equal(r.agents.copilot, '--agents');
    assert.ok(has(dir, '.cursor/rules/localcloud.mdc') && has(dir, '.github/copilot-instructions.md'));
    assert.ok(!has(dir, '.windsurf'));

    const all = tmp();
    const ra = init({ dir: all, all: true, mcp: true });
    for (const f of ['.cursor/rules/localcloud.mdc', '.windsurf/rules/localcloud.md', '.clinerules/localcloud.md', 'GEMINI.md', '.claude/skills/localcloud/SKILL.md', 'replit.md', '.mcp.json', '.cursor/mcp.json', '.vscode/mcp.json', '.gemini/settings.json', '.codex/config.toml']) {
      assert.ok(has(all, f), `${f} missing with --all`);
    }
    assert.ok(ra.hints.some((h) => /Copilot/.test(h)));

    assert.throws(() => init({ dir: tmp(), agents: 'cursor,notepad' }), /unknown agent "notepad"/);
  });

  test('--dry-run writes nothing but reports what would change', () => {
    const dir = tmp({ '.cursor/': null, 'AGENTS.md': '# Mine\n' });
    const before = snapshot(dir);
    const r = init({ dir, 'dry-run': true, mcp: true, relay: 'https://relay.example.com' });
    assert.deepEqual(snapshot(dir), before);
    assert.equal(r.dryRun, true);
    assert.equal(r.files['AGENTS.md'], 'updated');
    assert.equal(r.files['CLAUDE.md'], 'created');
    assert.equal(r.files['.cursor/rules/localcloud.mdc'], 'created');
    assert.equal(r.files['localcloud.json'], 'created');
  });

  test('tolerates string flags from the generic CLI parser', () => {
    assert.equal(flagOn('true'), true);
    assert.equal(flagOn('false'), false);
    assert.equal(flagOn(undefined), false);
    const dir = tmp();
    const r = init({ dir, all: 'true', mcp: 'false', 'dry-run': 'yes' });
    assert.equal(r.dryRun, true);
    assert.ok(r.agents.cursor);
    assert.ok(!('.mcp.json' in r.files));
    assert.deepEqual(snapshot(dir), {});
  });

  test('--mcp merges into existing configs and never clobbers them', () => {
    const dir = tmp({
      '.mcp.json': JSON.stringify({ mcpServers: { other: { command: 'x' } } }),
      '.vscode/mcp.json': '{\n  // comments make this JSONC\n  "servers": {}\n}\n',
      '.cursor/mcp.json': JSON.stringify({ mcpServers: { localcloud: { command: 'custom' } } }),
      '.codex/config.toml': 'model = "o4"\n',
      '.gemini/settings.json': JSON.stringify({ theme: 'dark' }),
    });
    const r = init({ dir, mcp: true });
    assert.deepEqual(readJson(dir, '.mcp.json').mcpServers, { other: { command: 'x' }, localcloud: { command: 'npx', args: ['-y', 'localcloud-cli', 'mcp'] } });
    assert.equal(r.files['.vscode/mcp.json'], 'skipped');
    assert.match(read(dir, '.vscode/mcp.json'), /comments make this JSONC/);
    assert.equal(r.files['.cursor/mcp.json'], 'unchanged');
    assert.equal(readJson(dir, '.cursor/mcp.json').mcpServers.localcloud.command, 'custom');
    assert.match(read(dir, '.codex/config.toml'), /^model = "o4"\n\n\[mcp_servers\.localcloud\]\ncommand = "npx"\nargs = \["-y", "localcloud-cli", "mcp"\]\n$/);
    const gem = readJson(dir, '.gemini/settings.json');
    assert.equal(gem.theme, 'dark');
    assert.deepEqual(gem.mcpServers.localcloud.args, ['-y', 'localcloud-cli', 'mcp']);

    const vs = tmp({ '.vscode/': null });
    init({ dir: vs, mcp: true });
    assert.deepEqual(readJson(vs, '.vscode/mcp.json'), { servers: { localcloud: { type: 'stdio', command: 'npx', args: ['-y', 'localcloud-cli', 'mcp'] } } });
  });

  test('Claude hook: keeps other hooks, upgrades old entries, respects custom ones', () => {
    const old = { matcher: 'startup', hooks: [{ type: 'command', command: 'if [ "$CLAUDE_CODE_REMOTE" = "true" ]; then npx -y localcloud-cli start || true; fi' }] };
    const other = { matcher: 'startup', hooks: [{ type: 'command', command: 'npm ci' }] };
    const dir = tmp({ '.claude/settings.json': JSON.stringify({ permissions: { allow: ['Bash(ls)'] }, hooks: { SessionStart: [other, old] } }) });
    assert.equal(upsertClaudeHook(dir), 'updated');
    const s = readJson(dir, '.claude/settings.json');
    assert.deepEqual(s.permissions, { allow: ['Bash(ls)'] });
    assert.equal(s.hooks.SessionStart.length, 2);
    assert.deepEqual(s.hooks.SessionStart[0], other);
    assert.equal(s.hooks.SessionStart[1].matcher, 'startup|resume');
    assert.equal(upsertClaudeHook(dir), 'unchanged');

    const custom = tmp({ '.claude/settings.json': JSON.stringify({ hooks: { SessionStart: [{ hooks: [{ type: 'command', command: 'localcloud start 3000' }] }] } }) });
    assert.equal(upsertClaudeHook(custom), 'unchanged');
    assert.equal(readJson(custom, '.claude/settings.json').hooks.SessionStart[0].hooks[0].command, 'localcloud start 3000');

    const broken = tmp({ '.claude/settings.json': '{ nope' });
    assert.match(upsertClaudeHook(broken), /^skipped/);
    assert.equal(read(broken, '.claude/settings.json'), '{ nope');

    const noHook = tmp();
    init({ dir: noHook, 'no-hook': true });
    assert.ok(!has(noHook, '.claude/settings.json'));
    assert.equal(upsertMcpJson(noHook), 'created');
    assert.equal(upsertMcpJson(noHook), 'unchanged');
  });

  test('--setup: Copilot workflow is created once; Cursor environment.json is merged', () => {
    const dir = tmp({
      '.github/copilot-instructions.md': '',
      '.cursor/environment.json': JSON.stringify({ install: 'npm ci', terminals: [{ name: 'web', command: 'npm run dev' }] }),
    });
    const r = init({ dir, setup: true, relay: 'https://relay.example.com/' });
    assert.equal(read(dir, '.github/workflows/copilot-setup-steps.yml'), copilotSetupSteps());
    const env = readJson(dir, '.cursor/environment.json');
    assert.equal(env.install, 'npm ci');
    assert.deepEqual(env.terminals.map((t) => t.name), ['web', 'localcloud']);
    assert.deepEqual(env.egressAllowlist, ['relay.example.com']);
    assert.equal(readJson(dir, 'localcloud.json').relay, 'https://relay.example.com');
    assert.equal(r.relay, 'https://relay.example.com');

    const userWf = tmp({ '.github/workflows/copilot-setup-steps.yml': 'jobs: {}\n', '.cursor/': null });
    const r2 = init({ dir: userWf, setup: true });
    assert.equal(r2.files['.github/workflows/copilot-setup-steps.yml'], 'skipped');
    assert.equal(read(userWf, '.github/workflows/copilot-setup-steps.yml'), 'jobs: {}\n');
    assert.equal(r2.files['.cursor/environment.json'], 'skipped');
    assert.ok(!has(userWf, '.cursor/environment.json'));
  });

  test('applyBlock handles new, empty, marked and unmarked text', () => {
    const b = agentInstructions();
    assert.equal(applyBlock(null, b, { header: 'H\n' }), `H\n${b}\n`);
    assert.equal(applyBlock('  \n', b), `${b}\n`);
    assert.equal(applyBlock(`a\n${b}\nz\n`, b), `a\n${b}\nz\n`);
    assert.equal(applyBlock('a\n\n\n', b), `a\n\n${b}\n`);
  });

  test('`localcloud init --json` via the CLI', () => {
    const dir = tmp({ '.cursor/': null });
    const res = spawnSync(process.execPath, [CLI, 'init', '--dir', dir, '--json'], { encoding: 'utf8', env: { ...process.env, NO_COLOR: '1' } });
    assert.equal(res.status, 0, res.stderr);
    const out = JSON.parse(res.stdout);
    assert.equal(out.dir, dir);
    assert.equal(out.files['.cursor/rules/localcloud.mdc'], 'created');
    assert.ok(Array.isArray(out.changes));
  });
});

describe('shipped integration assets', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const MCP_ARGS = ['-y', 'localcloud-cli', 'mcp'];

  test('skill files are generated from src/init.js and stay in sync', () => {
    const expected = skillMarkdown({ markers: false });
    assert.equal(fs.readFileSync(path.join(ROOT, 'skills/localcloud/SKILL.md'), 'utf8'), expected);
    assert.equal(fs.readFileSync(path.join(ROOT, 'integrations/claude-code/skills/localcloud/SKILL.md'), 'utf8'), expected);
    assert.match(expected, /^---\nname: localcloud\ndescription: [^\n]+\n---\n/);
    assert.equal(fs.readFileSync(path.join(ROOT, 'integrations/copilot/copilot-setup-steps.yml'), 'utf8'), copilotSetupSteps());
  });

  test('Claude Code plugin + marketplace manifests', () => {
    const market = JSON.parse(fs.readFileSync(path.join(ROOT, '.claude-plugin/marketplace.json'), 'utf8'));
    assert.equal(market.name, 'localcloud');
    assert.ok(market.owner?.name);
    const entry = market.plugins.find((p) => p.name === 'localcloud');
    assert.ok(entry, 'marketplace lists the localcloud plugin');
    assert.match(entry.source, /^\.\//);
    const pluginDir = path.join(ROOT, entry.source);
    const plugin = JSON.parse(fs.readFileSync(path.join(pluginDir, '.claude-plugin/plugin.json'), 'utf8'));
    assert.equal(plugin.name, entry.name);
    assert.deepEqual(plugin.mcpServers.localcloud, { command: 'npx', args: MCP_ARGS });
    assert.match(plugin.hooks.SessionStart[0].hooks[0].command, /CLAUDE_CODE_REMOTE.*localcloud-cli start/);
    assert.ok(fs.existsSync(path.join(pluginDir, 'skills/localcloud/SKILL.md')));
    assert.ok(!fs.existsSync(path.join(pluginDir, 'bin')), 'a plugin bin/ dir would be put on PATH and blocks claude.ai installs');
  });

  test('server.json (MCP registry) matches the npm package', () => {
    const server = JSON.parse(fs.readFileSync(path.join(ROOT, 'server.json'), 'utf8'));
    assert.match(server.$schema, /^https:\/\/static\.modelcontextprotocol\.io\/schemas\/[\d-]+\/server\.schema\.json$/);
    assert.equal(server.name, 'io.github.rayhankhilji/localcloud');
    assert.ok(server.description.length <= 100);
    const npm = server.packages.find((p) => p.registryType === 'npm');
    assert.equal(npm.identifier, pkg.name);
    assert.equal(npm.version, pkg.version, 'bump server.json together with package.json');
    assert.equal(server.version, pkg.version);
    assert.equal(npm.transport.type, 'stdio');
    assert.deepEqual(npm.packageArguments, [{ type: 'positional', value: 'mcp', description: npm.packageArguments[0].description }]);
    if (pkg.mcpName !== undefined) assert.equal(pkg.mcpName, server.name, 'package.json mcpName must equal server.json name');
  });

  test('every JSON snippet parses and every MCP snippet runs `localcloud-cli mcp`', () => {
    const dir = path.join(ROOT, 'integrations');
    const files = [];
    const walk = (d) => {
      for (const e of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(dir);
    for (const f of files.filter((f) => f.endsWith('.json') && !f.includes('devcontainer'))) {
      const data = JSON.parse(fs.readFileSync(f, 'utf8'));
      const servers = data.mcpServers || data.servers || data.context_servers;
      if (servers?.localcloud) assert.deepEqual(servers.localcloud.args, MCP_ARGS, f);
    }
    assert.match(fs.readFileSync(path.join(dir, 'codex/config.toml'), 'utf8'), /\[mcp_servers\.localcloud\]\ncommand = "npx"\nargs = \["-y", "localcloud-cli", "mcp"\]/);
  });

  test('docs/agents has a guide for every platform', () => {
    for (const f of ['README', 'claude-code', 'codex', 'cursor', 'devin', 'copilot', 'jules', 'windsurf', 'cline', 'gemini-cli', 'replit', 'generic']) {
      assert.ok(fs.existsSync(path.join(ROOT, 'docs/agents', `${f}.md`)), `docs/agents/${f}.md`);
    }
  });
});

describe('localcloud mcp', () => {
  let home;
  let prevHome;
  before(() => {
    home = tmp();
    prevHome = process.env.LOCALCLOUD_HOME;
    process.env.LOCALCLOUD_HOME = home; // no daemon socket here → "nothing shared"
  });
  after(() => {
    if (prevHome === undefined) delete process.env.LOCALCLOUD_HOME;
    else process.env.LOCALCLOUD_HOME = prevHome;
  });
  const call = (method, params, id = 1) => mcp.handleMessage({ jsonrpc: '2.0', id, method, ...(params ? { params } : {}) });
  const modernMeta = { 'io.modelcontextprotocol/protocolVersion': '2026-07-28', 'io.modelcontextprotocol/clientCapabilities': {} };

  test('initialize negotiates a legacy protocol version', async () => {
    const r = await call('initialize', { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 't', version: '1' } });
    assert.equal(r.result.protocolVersion, '2025-06-18');
    assert.equal(r.result.serverInfo.name, 'localcloud');
    assert.ok(r.result.capabilities.tools);
    assert.ok(r.result.instructions);
    const unknown = await call('initialize', { protocolVersion: '1999-01-01' });
    assert.equal(unknown.result.protocolVersion, mcp.LEGACY_VERSIONS[0]);
  });

  test('tools/list exposes annotated tools with valid schemas', async () => {
    const r = await call('tools/list');
    const names = r.result.tools.map((t) => t.name);
    assert.deepEqual(names, ['share_port', 'get_url', 'list_shared', 'stop_sharing', 'auto_share', 'status']);
    for (const t of r.result.tools) {
      assert.equal(t.inputSchema.type, 'object');
      assert.equal(typeof t.description, 'string');
      assert.equal(typeof t.annotations.readOnlyHint, 'boolean');
      assert.match(t.name, /^[A-Za-z0-9_.-]{1,128}$/);
    }
    assert.equal(r.result.tools.find((t) => t.name === 'list_shared').annotations.readOnlyHint, true);
    assert.equal(r.result.tools.find((t) => t.name === 'stop_sharing').annotations.destructiveHint, true);
    assert.equal(r.result.resultType, undefined, 'legacy requests get legacy-shaped results');
  });

  test('list_shared / get_url / stop_sharing work without a daemon', async () => {
    const list = await call('tools/call', { name: 'list_shared', arguments: {} });
    assert.equal(list.result.isError, undefined);
    assert.deepEqual(list.result.structuredContent.tunnels, []);
    assert.equal(list.result.structuredContent.running, false);
    const url = await call('tools/call', { name: 'get_url', arguments: { port: 3000 } });
    assert.deepEqual(url.result.structuredContent, { port: 3000, shared: false, url: null });
    const stop = await call('tools/call', { name: 'stop_sharing', arguments: { port: 3000 } });
    assert.match(stop.result.content[0].text, /not shared/);
    const st = await call('tools/call', { name: 'status', arguments: {} }, 9);
    assert.equal(st.result.structuredContent.running, false);
    assert.equal(st.result.structuredContent.shared, 0);
    assert.equal(typeof st.result.structuredContent.version, 'string');
  });

  test('bad arguments are tool errors; unknown tools are protocol errors', async () => {
    const bad = await call('tools/call', { name: 'share_port', arguments: { port: 70000 } });
    assert.equal(bad.result.isError, true);
    assert.match(bad.result.content[0].text, /port/);
    const unknown = await call('tools/call', { name: 'nope', arguments: {} });
    assert.equal(unknown.error.code, -32602);
    const missing = await call('frobnicate');
    assert.equal(missing.error.code, -32601);
  });

  test('modern (2026-07-28) requests: discover, resultType, version errors', async () => {
    const d = await call('server/discover', { _meta: modernMeta });
    assert.equal(d.result.resultType, 'complete');
    assert.ok(d.result.supportedVersions.includes('2026-07-28'));
    assert.equal(d.result._meta['io.modelcontextprotocol/serverInfo'].name, 'localcloud');
    const list = await call('tools/list', { _meta: modernMeta });
    assert.equal(list.result.resultType, 'complete');
    assert.equal(list.result.tools.length, mcp.TOOLS.length);
    const bad = await call('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '1900-01-01' } });
    assert.equal(bad.error.code, -32022);
    assert.deepEqual(bad.error.data.supported, mcp.SUPPORTED_VERSIONS);
    const noCaps = await call('tools/list', { _meta: { 'io.modelcontextprotocol/protocolVersion': '2026-07-28' } });
    assert.equal(noCaps.error.code, -32602);
  });

  test('resources and notifications', async () => {
    const list = await call('resources/list');
    assert.equal(list.result.resources[0].uri, 'localcloud://status');
    const res = await call('resources/read', { uri: 'localcloud://status' });
    assert.equal(JSON.parse(res.result.contents[0].text).running, false);
    const missing = await call('resources/read', { uri: 'localcloud://nope' });
    assert.equal(missing.error.code, -32602);
    assert.equal(await mcp.handleMessage({ jsonrpc: '2.0', method: 'notifications/initialized' }), null);
  });

  test('stdio round trip through `localcloud mcp`', async () => {
    const child = spawn(process.execPath, [CLI, 'mcp'], { cwd: tmp(), env: { ...process.env, LOCALCLOUD_HOME: home, LOCALCLOUD_RELAY: '' }, stdio: ['pipe', 'pipe', 'pipe'] });
    const lines = [];
    let buf = '';
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        lines.push(JSON.parse(buf.slice(0, i)));
        buf = buf.slice(i + 1);
      }
    });
    const send = (m) => child.stdin.write(JSON.stringify(m) + '\n');
    send({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 't', version: '1' } } });
    send({ jsonrpc: '2.0', method: 'notifications/initialized' });
    send({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
    child.stdin.write('this is not json\n');
    child.stdin.end();
    const code = await new Promise((r) => child.on('exit', r));
    assert.equal(code, 0);
    const byId = Object.fromEntries(lines.map((l) => [l.id, l]));
    assert.equal(byId[1].result.protocolVersion, '2025-11-25');
    assert.equal(byId[2].result.tools.length, mcp.TOOLS.length);
    assert.equal(byId.null.error.code, -32700);
    assert.equal(lines.length, 3, 'notifications get no reply');
  });
});
