// `localcloud init` — wires localcloud into a repo so every coding agent that
// works on it knows how to share its dev servers, with zero prompting.
//
// Always written:   AGENTS.md block, CLAUDE.md (imports AGENTS.md), Claude Code SessionStart hook
// Auto-detected:    tool-specific rules files, only when that tool is already configured in the repo
//                   (or forced with --all / --agents cursor,copilot,…)
// --mcp:            MCP server configs for every selected tool that reads one from the repo
// --setup:          safe edits to existing setup files (.cursor/environment.json) and a
//                   Copilot setup-steps workflow when none exists
//
// Idempotent: everything we write is either between <!-- localcloud:start/end --> markers or a
// keyed JSON/TOML entry, so re-running updates in place and never touches user content.

import fs from 'node:fs';
import path from 'node:path';
import { normalizeRelay } from './config.js';
import { c, logo } from './ui.js';

export const NPX = 'npx -y localcloud-cli';
const START = '<!-- localcloud:start -->';
const END = '<!-- localcloud:end -->';
const MCP_ARGS = ['-y', 'localcloud-cli', 'mcp'];
const REPO = 'https://github.com/rayhankhilji/localcloud';
const DOCS = `${REPO}/blob/main/docs/agents`;
const SNIPPETS = `${REPO}/tree/main/integrations`;

// ---------------------------------------------------------------- content

function instructionsBody(cmd = NPX) {
  return `## Previewing dev servers (localcloud)

This project may be worked on by a cloud coding agent, where \`localhost\` is not reachable by the user.
Whenever you start a dev server (or any web server) that the user should see, share it:

\`\`\`sh
${cmd} start <port>      # prints a public https URL and returns immediately
\`\`\`

- Give the user the printed **https URL** instead of a \`localhost\` link.
- \`${cmd} url <port>\` prints just the URL; \`${cmd} ls\` lists everything shared; \`${cmd} stop <port>\` stops sharing.
- \`${cmd} start\` with no port auto-shares every dev server that starts listening.
- If the \`localcloud\` MCP tools (\`share_port\`, \`get_url\`, \`list_shared\`) are available, you can use them instead.
- Keep the server bound to localhost and its usual port — no host/allowedHosts config changes are needed.
- If it says no relay is configured, ask the user for their relay URL instead of guessing one.
- If sharing fails, run \`${cmd} doctor\` and report what it says (usually the relay's domain must be added to the sandbox's network allowlist).`;
}

export function agentInstructions(cmd = NPX) {
  return `${START}\n${instructionsBody(cmd)}\n${END}`;
}

export const SKILL_DESCRIPTION =
  'Share a local dev server (localhost:3000, :5173, …) at a public HTTPS URL with localcloud. Use whenever you start a web/dev server the user should open, when the user asks for a preview link, or when a localhost link would be unreachable because you are running in a cloud sandbox.';

const SKILL_FRONT = `---\nname: localcloud\ndescription: ${SKILL_DESCRIPTION}\n---\n\n`;

function skillBody(cmd = NPX) {
  return `# localcloud — share localhost from a cloud sandbox

You are probably running somewhere the user's browser can't reach (a cloud VM or container).
A \`http://localhost:…\` link is useless to them. localcloud gives any local port a public HTTPS URL.

## Share a dev server

1. Start the server as usual (\`npm run dev\`, \`python -m http.server 8000\`, …). Don't change its host or port.
2. Share the port — this returns immediately and prints the URL:

   \`\`\`sh
   ${cmd} start 5173
   \`\`\`

3. Give the user the printed \`https://…\` URL. Mention it again whenever you restart the server; the URL stays the same.

Alternatives:

- \`${cmd} start\` (no port) — auto-share every dev server that starts listening from now on.
- \`${cmd} run -- npm run dev\` — run a command in the foreground and share whatever port it opens.
- \`${cmd} url 5173\` — print just the URL (shares it if needed). \`--json\` gives machine-readable output.
- MCP tools, if the \`localcloud\` MCP server is connected: \`share_port\`, \`get_url\`, \`list_shared\`, \`stop_sharing\`, \`auto_share\`.

## Manage

- \`${cmd} ls\` — what is shared, and whether the relay connection is up.
- \`${cmd} stop 5173\` — stop sharing one port; \`${cmd} stop\` — stop everything.
- \`--protect\` makes a private link (the URL carries an access key); \`--name my-app\` picks the subdomain.

## When it fails

- "needs a relay": no relay is configured. Ask the user for their relay URL; then pass \`--relay <url>\`,
  set \`LOCALCLOUD_RELAY\`, or commit \`{"relay": "https://…"}\` as \`localcloud.json\`. Don't invent a relay.
- "blocked by the network policy" / HTTP 403 / 407: the sandbox's egress allowlist doesn't include the relay's domain.
  Tell the user to add it in their agent environment's network settings.
- Anything else: run \`${cmd} doctor\` and report its output. \`${cmd} logs\` shows the background daemon's log.
- The page loads but shows "waiting for your server": nothing is listening on that port yet — start the server.

No framework config is needed: the Host header is rewritten to \`localhost\`, so Vite/Next/webpack host checks pass,
and HMR websockets work through the tunnel.`;
}

/** The Claude Code / Agent Skills SKILL.md. `skills/localcloud/SKILL.md` in the repo is this with markers: false. */
export function skillMarkdown({ markers = true, cmd = NPX } = {}) {
  const body = skillBody(cmd);
  return markers ? `${SKILL_FRONT}${START}\n${body}\n${END}\n` : `${SKILL_FRONT}${body}\n`;
}

const CURSOR_FRONT = `---
description: Share dev servers at a public HTTPS URL with localcloud (the user can't open localhost links from a cloud agent)
alwaysApply: true
---

`;
const WINDSURF_FRONT = `---
trigger: always_on
---

`;

// The SessionStart hook: in Claude Code cloud sessions, start auto-sharing dev servers.
const HOOK_COMMAND = `if [ "$CLAUDE_CODE_REMOTE" = "true" ]; then ${NPX} start || true; fi`;
const HOOK_MATCHER = 'startup|resume';

export function copilotSetupSteps() {
  return `# Prepares the GitHub Copilot coding agent's environment.
# Docs: https://docs.github.com/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment
name: "Copilot Setup Steps"

on:
  workflow_dispatch:
  push:
    paths: [.github/workflows/copilot-setup-steps.yml]
  pull_request:
    paths: [.github/workflows/copilot-setup-steps.yml]

jobs:
  # The job MUST be called copilot-setup-steps or Copilot won't pick it up.
  copilot-setup-steps:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      # Install localcloud so the agent can share dev servers without downloading it mid-task.
      - run: npm install -g localcloud-cli
      # Start auto-sharing in the background (needs a relay: localcloud.json or LOCALCLOUD_RELAY).
      - run: localcloud start || true
`;
}

// ---------------------------------------------------------------- targets

const exists = (dir, rel) => fs.existsSync(path.join(dir, rel));
const isDir = (dir, rel) => {
  try {
    return fs.statSync(path.join(dir, rel)).isDirectory();
  } catch {
    return false;
  }
};

/** Every tool `init` knows how to configure. `detect` decides whether it's set up in the repo already. */
export const TARGETS = {
  agents: { label: 'AGENTS.md (Codex, Cursor, Copilot, Jules, Devin, Zed, OpenHands, Gemini, …)', always: true },
  claude: { label: 'Claude Code (CLAUDE.md + SessionStart hook)', always: true },
  skill: { label: 'Claude Code skill', detect: (d) => exists(d, '.claude/skills') },
  cursor: { label: 'Cursor', detect: (d) => exists(d, '.cursor') || exists(d, '.cursorrules') },
  copilot: {
    label: 'GitHub Copilot',
    detect: (d) => exists(d, '.github/copilot-instructions.md') || exists(d, '.github/instructions') || exists(d, '.github/workflows/copilot-setup-steps.yml'),
  },
  windsurf: { label: 'Windsurf / Devin Desktop', detect: (d) => exists(d, '.windsurf') || exists(d, '.windsurfrules') || exists(d, '.devin/rules') },
  cline: { label: 'Cline', detect: (d) => exists(d, '.clinerules') || exists(d, '.cline') },
  gemini: { label: 'Gemini CLI', detect: (d) => exists(d, 'GEMINI.md') || exists(d, '.gemini') },
  codex: { label: 'OpenAI Codex (MCP only; reads AGENTS.md)', detect: (d) => exists(d, '.codex') },
  vscode: { label: 'VS Code (MCP only)', detect: (d) => exists(d, '.vscode') },
  replit: { label: 'Replit Agent', detect: (d) => exists(d, '.replit') || exists(d, 'replit.md') },
};

const ALIASES = {
  'claude-code': 'claude',
  'claude-skill': 'skill',
  skills: 'skill',
  'github-copilot': 'copilot',
  github: 'copilot',
  'gemini-cli': 'gemini',
  devin: 'windsurf',
  'devin-desktop': 'windsurf',
  'vs-code': 'vscode',
  code: 'vscode',
  openai: 'codex',
  agentsmd: 'agents',
  'agents.md': 'agents',
};

/** Flags may arrive as booleans or strings ("true"/"false") depending on how the CLI parsed them. */
export function flagOn(v) {
  if (v === undefined || v === null || v === false) return false;
  if (typeof v === 'string') return !['false', '0', 'no', 'off', ''].includes(v.toLowerCase());
  return !!v;
}

function parseAgentList(value) {
  if (!value || value === true) return [];
  const list = String(value)
    .split(/[\s,]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
    .map((s) => ALIASES[s] || s);
  const unknown = list.filter((s) => s !== 'all' && !TARGETS[s]);
  if (unknown.length) throw new Error(`unknown agent "${unknown.join(', ')}" — choose from: ${Object.keys(TARGETS).join(', ')}, all`);
  return list;
}

/** Which targets to configure, and why. */
export function selectTargets(dir, flags = {}) {
  const explicit = parseAgentList(flags.agents ?? flags.agent);
  const all = flagOn(flags.all) || explicit.includes('all');
  const detect = !flagOn(flags['no-detect']);
  const selected = new Map();
  for (const [id, t] of Object.entries(TARGETS)) {
    if (t.always) selected.set(id, 'default');
    else if (all) selected.set(id, '--all');
    else if (explicit.includes(id)) selected.set(id, '--agents');
    else if (detect && t.detect(dir)) selected.set(id, 'detected');
  }
  if (flagOn(flags['no-claude'])) selected.delete('claude');
  if (flagOn(flags.skill)) selected.set('skill', selected.get('skill') || '--skill');
  return selected;
}

// ---------------------------------------------------------------- file plumbing

/** Collects changes; in dry-run mode it computes them without touching the disk. */
class Changes {
  constructor(dir, dryRun) {
    this.dir = dir;
    this.dryRun = dryRun;
    this.list = [];
    this.pending = new Map();
  }
  abs(rel) {
    return path.join(this.dir, rel);
  }
  read(rel) {
    if (this.pending.has(rel)) return this.pending.get(rel);
    try {
      return fs.readFileSync(this.abs(rel), 'utf8');
    } catch {
      return null;
    }
  }
  note(rel, action, note) {
    this.list.push({ file: rel, action, ...(note ? { note } : {}) });
    return action;
  }
  /** Run `fn(oldText|null)` → new text (string), or {skip: reason}. */
  edit(rel, fn, note) {
    const before = this.read(rel);
    let after;
    try {
      after = fn(before);
    } catch (e) {
      return this.note(rel, 'skipped', e.message);
    }
    if (after && typeof after === 'object') return this.note(rel, after.skip ? 'skipped' : 'unchanged', after.skip || after.unchanged);
    if (after === before) return this.note(rel, 'unchanged', note);
    if (!this.dryRun) {
      fs.mkdirSync(path.dirname(this.abs(rel)), { recursive: true });
      fs.writeFileSync(this.abs(rel), after);
    }
    this.pending.set(rel, after);
    return this.note(rel, before === null ? 'created' : 'updated', note);
  }
}

/** Pure: insert or replace the marked localcloud block in `text` (null = file doesn't exist). */
export function applyBlock(text, block, { header = '' } = {}) {
  if (text === null || text === undefined) return `${header}${block}\n`;
  const start = text.indexOf(START);
  const end = text.indexOf(END, start);
  if (start >= 0 && end > start) return text.slice(0, start) + block + text.slice(end + END.length);
  if (!text.trim()) return `${header}${block}\n`;
  return `${text.replace(/\s*$/, '')}\n\n${block}\n`;
}

/** Insert or replace the localcloud block inside a markdown file. */
export function upsertBlock(file, block, { create = true, header = '' } = {}) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (text === null && !create) return 'skipped';
  const next = applyBlock(text, block, { header });
  if (next === text) return 'unchanged';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, next);
  return text === null ? 'created' : 'updated';
}

function parseJsonFile(text, rel) {
  if (text === null) return {};
  if (!text.trim()) return {};
  try {
    const data = JSON.parse(text);
    if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error();
    return data;
  } catch {
    throw new Error(`${rel} is not plain JSON (comments?) — add the localcloud entry by hand`);
  }
}
const json = (data) => JSON.stringify(data, null, 2) + '\n';

function editJson(changes, rel, mutate, note) {
  return changes.edit(
    rel,
    (text) => {
      const data = parseJsonFile(text, rel);
      const before = JSON.stringify(data);
      const result = mutate(data);
      if (result && typeof result === 'object' && (result.skip || result.unchanged)) return result;
      return text !== null && JSON.stringify(data) === before ? text : json(data);
    },
    note,
  );
}

// ---------------------------------------------------------------- writers

const isOurHook = (h) => typeof h?.command === 'string' && /localcloud(-cli)? start/.test(h.command);

function hookMutator(data) {
  if (typeof data.hooks !== 'object' || data.hooks === null || Array.isArray(data.hooks)) data.hooks = {};
  if (!Array.isArray(data.hooks.SessionStart)) data.hooks.SessionStart = [];
  const entries = data.hooks.SessionStart;
  const existing = entries.find((e) => Array.isArray(e?.hooks) && e.hooks.some(isOurHook));
  if (!existing) {
    entries.push({ matcher: HOOK_MATCHER, hooks: [{ type: 'command', command: HOOK_COMMAND }] });
    return;
  }
  // Upgrade entries written by an older `localcloud init`; keep anything the user customised.
  const ours = existing.hooks.find(isOurHook);
  if (ours.command === HOOK_COMMAND && existing.matcher === 'startup') existing.matcher = HOOK_MATCHER;
  else if (ours.command !== HOOK_COMMAND) return { unchanged: 'custom localcloud hook kept' };
}

/** Add a SessionStart hook so Claude Code cloud sessions auto-share dev servers. */
export function upsertClaudeHook(dir) {
  const changes = new Changes(dir, false);
  const action = editJson(changes, path.join('.claude', 'settings.json'), hookMutator);
  return action === 'skipped' ? `skipped (${changes.list[0].note})` : action;
}

const mcpEntry = (extra = {}) => ({ ...extra, command: 'npx', args: [...MCP_ARGS] });

function mcpServersMutator(key, entry) {
  return (data) => {
    if (typeof data[key] !== 'object' || data[key] === null || Array.isArray(data[key])) data[key] = {};
    if (data[key].localcloud) return { unchanged: 'localcloud server already configured' };
    data[key].localcloud = entry;
  };
}

export function upsertMcpJson(dir) {
  const changes = new Changes(dir, false);
  const action = editJson(changes, '.mcp.json', mcpServersMutator('mcpServers', mcpEntry()));
  return action === 'skipped' ? `skipped (${changes.list[0].note})` : action;
}

function upsertCodexToml(changes) {
  const rel = path.join('.codex', 'config.toml');
  return changes.edit(
    rel,
    (text) => {
      if (text !== null && /^\s*\[\s*mcp_servers\s*\.\s*"?localcloud"?\s*\]/m.test(text)) return { unchanged: 'localcloud server already configured' };
      const table = `[mcp_servers.localcloud]\ncommand = "npx"\nargs = [${MCP_ARGS.map((a) => JSON.stringify(a)).join(', ')}]\n`;
      return text === null || !text.trim() ? table : `${text.replace(/\s*$/, '')}\n\n${table}`;
    },
    'applies to trusted projects',
  );
}

function writeGemini(changes, block) {
  const settings = (() => {
    try {
      return JSON.parse(changes.read(path.join('.gemini', 'settings.json')) || '{}');
    } catch {
      return {};
    }
  })();
  const names = [].concat(settings?.context?.fileName || []);
  if (names.includes('AGENTS.md')) return changes.note('GEMINI.md', 'unchanged', 'Gemini already loads AGENTS.md (context.fileName)');
  return changes.edit('GEMINI.md', (text) => {
    if (text === null) return '@./AGENTS.md\n';
    if (/^@(\.\/)?AGENTS\.md\s*$/m.test(text)) return { unchanged: 'already imports AGENTS.md' };
    return applyBlock(text, block);
  });
}

function writeClaudeMd(changes, block) {
  return changes.edit('CLAUDE.md', (text) => {
    if (text === null) return '@AGENTS.md\n';
    if (/^@(\.\/)?AGENTS\.md\s*$/m.test(text)) return { unchanged: 'already imports AGENTS.md' };
    return applyBlock(text, block);
  });
}

function writeCline(changes, block) {
  // `.clinerules` may be a single rules file (older Cline) or a directory of rule files.
  if (exists(changes.dir, '.clinerules') && !isDir(changes.dir, '.clinerules')) return changes.edit('.clinerules', (t) => applyBlock(t, block));
  const dirName = !exists(changes.dir, '.clinerules') && isDir(changes.dir, '.cline/rules') ? '.cline/rules' : '.clinerules';
  return changes.edit(path.join(dirName, 'localcloud.md'), (t) => applyBlock(t, block));
}

function writeCursorEnvironment(changes, relayHost) {
  const rel = path.join('.cursor', 'environment.json');
  if (changes.read(rel) === null) return changes.note(rel, 'skipped', `no environment.json — add a "terminals" entry running \`localcloud start\` (${DOCS}/cursor.md)`);
  return editJson(changes, rel, (data) => {
    let changed = false;
    const terminals = Array.isArray(data.terminals) ? data.terminals : [];
    const flat = terminals.flat ? terminals.flat() : terminals;
    if (!flat.some((t) => /localcloud/.test(t?.command || ''))) {
      terminals.push({ name: 'localcloud', command: `${NPX} start || true`, description: 'Auto-shares dev servers at public HTTPS URLs; run `npx -y localcloud-cli ls` to see them' });
      data.terminals = terminals;
      changed = true;
    }
    if (relayHost) {
      const allow = Array.isArray(data.egressAllowlist) ? data.egressAllowlist : null;
      if (allow && !allow.includes(relayHost)) {
        allow.push(relayHost);
        changed = true;
      } else if (!allow && data.egressMode === undefined) {
        // Without egressMode an allowlist is unioned with the inherited team/user list.
        data.egressAllowlist = [relayHost];
        changed = true;
      }
    }
    if (!changed) return { unchanged: 'already starts localcloud' };
  });
}

function writeCopilotSetup(changes) {
  const rel = path.join('.github', 'workflows', 'copilot-setup-steps.yml');
  return changes.edit(rel, (text) => {
    if (text === null) return copilotSetupSteps();
    if (/localcloud/.test(text)) return { unchanged: 'already installs localcloud' };
    return { skip: `exists — add the two localcloud steps from ${SNIPPETS}/copilot by hand` };
  });
}

function relayFor(dir, flags) {
  if (flags.relay && flags.relay !== true) return normalizeRelay(flags.relay);
  try {
    const data = JSON.parse(fs.readFileSync(path.join(dir, 'localcloud.json'), 'utf8'));
    return data.relay ? normalizeRelay(data.relay) : null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- main

/**
 * Compute (and, unless dryRun, apply) every change. Returns a plain result object; never prints.
 * @param {object} flags  dir, relay, agents, all, mcp, setup, skill, 'no-hook', 'no-detect', 'no-claude', 'dry-run'
 */
export function init(flags = {}) {
  const dir = path.resolve(flags.dir && flags.dir !== true ? String(flags.dir) : process.cwd());
  const dryRun = flagOn(flags['dry-run'] ?? flags.dryRun);
  const mcp = flagOn(flags.mcp);
  const setup = flagOn(flags.setup);
  const changes = new Changes(dir, dryRun);
  const selected = selectTargets(dir, flags);
  const has = (id) => selected.has(id);
  const block = agentInstructions();
  const hints = [];

  if (flags.relay && flags.relay !== true) {
    const relay = normalizeRelay(flags.relay);
    editJson(changes, 'localcloud.json', (data) => {
      if (data.relay === relay) return { unchanged: 'relay already saved' };
      data.relay = relay;
    }, 'relay saved');
  }
  const relay = relayFor(dir, flags);
  const relayHost = relay ? new URL(relay).hostname : null;

  changes.edit('AGENTS.md', (t) => applyBlock(t, block, { header: '# Agent instructions\n\n' }));

  if (has('claude')) {
    writeClaudeMd(changes, block);
    if (!flagOn(flags['no-hook'])) editJson(changes, path.join('.claude', 'settings.json'), hookMutator, 'cloud sessions auto-share dev servers');
    if (mcp) editJson(changes, '.mcp.json', mcpServersMutator('mcpServers', mcpEntry()));
  }
  if (has('skill')) changes.edit(path.join('.claude', 'skills', 'localcloud', 'SKILL.md'), (t) => applyBlock(t, `${START}\n${skillBody()}\n${END}`, { header: SKILL_FRONT }));
  if (has('cursor')) {
    changes.edit(path.join('.cursor', 'rules', 'localcloud.mdc'), (t) => applyBlock(t, block, { header: CURSOR_FRONT }));
    if (mcp) editJson(changes, path.join('.cursor', 'mcp.json'), mcpServersMutator('mcpServers', mcpEntry({ type: 'stdio' })));
    if (setup) writeCursorEnvironment(changes, relayHost);
  }
  if (has('copilot')) {
    changes.edit(path.join('.github', 'copilot-instructions.md'), (t) => applyBlock(t, block));
    if (setup) writeCopilotSetup(changes);
    if (mcp) hints.push(`Copilot coding agent: paste the MCP JSON from ${SNIPPETS}/copilot into the repo's Settings → Copilot → MCP servers.`);
  }
  if (has('windsurf')) {
    const rulesDir = isDir(dir, '.devin/rules') && !exists(dir, '.windsurf') ? '.devin/rules' : '.windsurf/rules';
    changes.edit(path.join(rulesDir, 'localcloud.md'), (t) => applyBlock(t, block, { header: WINDSURF_FRONT }));
    if (mcp) hints.push(`Windsurf MCP servers are per user (~/.codeium/windsurf/mcp_config.json): ${SNIPPETS}/windsurf`);
  }
  if (has('cline')) {
    writeCline(changes, block);
    if (mcp) hints.push(`Cline MCP servers are per user (Cline's MCP settings): ${SNIPPETS}/cline`);
  }
  if (has('gemini')) {
    writeGemini(changes, block);
    if (mcp) editJson(changes, path.join('.gemini', 'settings.json'), mcpServersMutator('mcpServers', mcpEntry()));
  }
  if (has('codex') && mcp) upsertCodexToml(changes);
  if (has('vscode') && mcp) editJson(changes, path.join('.vscode', 'mcp.json'), mcpServersMutator('servers', mcpEntry({ type: 'stdio' })));
  if (has('replit')) changes.edit('replit.md', (t) => applyBlock(t, block, { header: '# Project notes\n\n' }));

  return {
    dir,
    dryRun,
    relay,
    agents: Object.fromEntries(selected),
    files: Object.fromEntries(changes.list.map((x) => [x.file, x.action])),
    changes: changes.list,
    hints,
  };
}

export async function runInit(flags = {}) {
  const result = init(flags);
  if (flagOn(flags.json)) {
    process.stdout.write(JSON.stringify(result) + '\n');
    return result;
  }
  const out = (s = '') => process.stdout.write(s + '\n');
  const icon = { created: c.green('+'), updated: c.green('✓'), unchanged: c.dim('='), skipped: c.yellow('!') };
  out(`\n${logo()} init${result.dryRun ? c.yellow('  (dry run — nothing written)') : ''}\n`);
  const width = Math.max(24, ...result.changes.map((x) => x.file.length + 2));
  for (const x of result.changes) out(`  ${icon[x.action] || '•'} ${x.file.padEnd(width)} ${c.dim(x.action + (x.note ? ` — ${x.note}` : ''))}`);
  const others = Object.entries(TARGETS).filter(([id, t]) => !t.always && !result.agents[id]);
  out(`
${c.bold('Agents that read AGENTS.md / CLAUDE.md now know to share their dev servers.')}
Configured for: ${Object.keys(result.agents).join(', ')}${others.length ? c.dim(`  (add more with --agents ${others.map(([id]) => id).join(',')} or --all)`) : ''}
`);
  for (const h of result.hints) out(`  ${c.yellow('→')} ${h}`);
  if (result.hints.length) out('');
  out(`For hands-free auto-sharing, run this from the environment's setup / startup script:

  ${c.cyan(`${NPX} start`)}

  • Claude Code (cloud)   handled by the SessionStart hook above
  • Codex (cloud)         AGENTS.md tells the agent to share; install in the setup script
  • Cursor (cloud agents) .cursor/environment.json "terminals"  (localcloud init --setup)
  • Copilot coding agent  .github/workflows/copilot-setup-steps.yml  (localcloud init --setup)
  • Devin, Jules, others  ${DOCS}/README.md
${result.relay ? '' : `\n${c.yellow('Tip:')} commit a relay so nobody has to configure anything: ${c.bold('localcloud init --relay https://your-relay')}`}
${c.dim(`Remember: the sandbox must be allowed to reach ${result.relay ? new URL(result.relay).hostname : 'your relay domain'} (network allowlist).`)}
${flagOn(flags.mcp) ? '' : c.dim('Add --mcp to also register the localcloud MCP server for each tool.\n')}`);
  return result;
}
