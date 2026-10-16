// `localcloud init` — wires localcloud into a repo so every coding agent that
// works on it knows how to share its dev servers, with zero prompting.

import fs from 'node:fs';
import path from 'node:path';
import { normalizeRelay } from './config.js';
import { c, logo } from './ui.js';

export const NPX = 'npx -y localcloud-cli';
const START = '<!-- localcloud:start -->';
const END = '<!-- localcloud:end -->';

export function agentInstructions(cmd = NPX) {
  return `${START}
## Previewing dev servers (localcloud)

This project may be worked on by a cloud coding agent, where \`localhost\` is not reachable by the user.
Whenever you start a dev server (or any web server) that the user should see, share it:

\`\`\`sh
${cmd} start <port>      # prints a public https URL and returns immediately
\`\`\`

- Give the user the printed **https URL** instead of a \`localhost\` link.
- \`${cmd} url <port>\` prints just the URL; \`${cmd} ls\` lists everything shared; \`${cmd} stop <port>\` stops sharing.
- \`${cmd} start\` with no port auto-shares every dev server that starts listening.
- Keep the server bound to localhost and its usual port — no host/allowedHosts config changes are needed.
- If sharing fails, run \`${cmd} doctor\` and report what it says.
${END}`;
}

/** Insert or replace the localcloud block inside a markdown file. */
export function upsertBlock(file, block, { create = true, header = '' } = {}) {
  let text = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : null;
  if (text === null && !create) return 'skipped';
  if (text === null) {
    fs.writeFileSync(file, `${header}${block}\n`);
    return 'created';
  }
  const start = text.indexOf(START);
  const end = text.indexOf(END);
  if (start >= 0 && end > start) {
    const next = text.slice(0, start) + block + text.slice(end + END.length);
    if (next === text) return 'unchanged';
    fs.writeFileSync(file, next);
    return 'updated';
  }
  fs.writeFileSync(file, `${text.replace(/\s*$/, '')}\n\n${block}\n`);
  return 'updated';
}

const HOOK_COMMAND = `if [ "$CLAUDE_CODE_REMOTE" = "true" ]; then ${NPX} start || true; fi`;

/** Add a SessionStart hook so Claude Code cloud sessions auto-share dev servers. */
export function upsertClaudeHook(dir) {
  const file = path.join(dir, '.claude', 'settings.json');
  const existed = fs.existsSync(file);
  let data = {};
  if (existed) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return 'skipped (settings.json is not valid JSON)';
    }
  }
  data.hooks ||= {};
  data.hooks.SessionStart ||= [];
  const exists = JSON.stringify(data.hooks.SessionStart).includes('localcloud-cli start');
  if (exists) return 'unchanged';
  data.hooks.SessionStart.push({ matcher: 'startup', hooks: [{ type: 'command', command: HOOK_COMMAND }] });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return existed ? 'updated' : 'created';
}

export function upsertMcpJson(dir) {
  const file = path.join(dir, '.mcp.json');
  let data = {};
  if (fs.existsSync(file)) {
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {
      return 'skipped (.mcp.json is not valid JSON)';
    }
  }
  data.mcpServers ||= {};
  if (data.mcpServers.localcloud) return 'unchanged';
  data.mcpServers.localcloud = { command: 'npx', args: ['-y', 'localcloud-cli', 'mcp'] };
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
  return 'updated';
}

export async function runInit(flags = {}) {
  const dir = path.resolve(flags.dir || process.cwd());
  const results = [];
  const note = (file, result) => results.push([path.relative(dir, file) || file, result]);

  if (flags.relay) {
    const file = path.join(dir, 'localcloud.json');
    let data = {};
    try {
      data = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch {}
    data.relay = normalizeRelay(flags.relay);
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n');
    note(file, 'relay saved');
  }

  const block = agentInstructions();
  note(path.join(dir, 'AGENTS.md'), upsertBlock(path.join(dir, 'AGENTS.md'), block, { header: '# Agent instructions\n\n' }));

  const claudeMd = path.join(dir, 'CLAUDE.md');
  const claudeText = fs.existsSync(claudeMd) ? fs.readFileSync(claudeMd, 'utf8') : null;
  if (claudeText !== null && /^@AGENTS\.md\s*$/m.test(claudeText)) note(claudeMd, 'already imports AGENTS.md');
  else if (claudeText === null) {
    fs.writeFileSync(claudeMd, '@AGENTS.md\n');
    note(claudeMd, 'created (imports AGENTS.md)');
  } else note(claudeMd, upsertBlock(claudeMd, block));

  if (!flags['no-hook']) note(path.join(dir, '.claude', 'settings.json'), `${upsertClaudeHook(dir)} — cloud sessions auto-share dev servers`);
  if (flags.mcp) note(path.join(dir, '.mcp.json'), upsertMcpJson(dir));

  if (flags.json) {
    process.stdout.write(JSON.stringify({ dir, files: Object.fromEntries(results) }) + '\n');
    return;
  }
  const out = (s = '') => process.stdout.write(s + '\n');
  out(`\n${logo()} init\n`);
  for (const [file, result] of results) out(`  ${c.green('✓')} ${file.padEnd(24)} ${c.dim(result)}`);
  out(`
${c.bold('Agents that read AGENTS.md / CLAUDE.md now know to share their dev servers.')}
For hands-free auto-sharing, add this to the environment's setup / startup script:

  ${c.cyan(`${NPX} start`)}

  • Claude Code (web)   handled by the SessionStart hook above
  • Codex (cloud)       Environment → Setup script
  • Cursor (bg agents)  .cursor/environment.json → "start"
  • Devin               Machine setup → startup commands
  • Anything else       run it once in the sandbox; it keeps running in the background
${flags.relay ? '' : `\n${c.yellow('Tip:')} commit a relay so nobody has to configure anything: ${c.bold('localcloud init --relay https://your-relay')}`}
${c.dim('Remember: the sandbox must be allowed to reach your relay domain (network allowlist).')}
`);
}
