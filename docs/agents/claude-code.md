# Claude Code (cloud sessions, Desktop, CLI)

Cloud sessions (claude.ai/code, the mobile Code tab, `claude --cloud`, routines) run in an
Anthropic-managed VM. localcloud makes their dev servers reachable at a public HTTPS URL.

## 1-minute setup

```sh
npx -y localcloud-cli init --relay https://relay.example.com --mcp
git add AGENTS.md CLAUDE.md .claude/settings.json .mcp.json localcloud.json && git commit -m "Share dev servers with localcloud"
```

Then add the relay's hostname to the environment's allowlist (below). That's it — the next cloud
session starts sharing on its own.

What `init` wrote:

| File | Purpose |
| --- | --- |
| `AGENTS.md` block | Tells the agent to run `npx -y localcloud-cli start <port>` and hand over the https URL. |
| `CLAUDE.md` | `@AGENTS.md` import (or the same block, if you already have a CLAUDE.md). |
| `.claude/settings.json` | SessionStart hook (below). |
| `.mcp.json` | The `localcloud` MCP server (`--mcp`). |
| `localcloud.json` | `{"relay": "https://…"}` so nobody configures anything. |

## Auto-share: the SessionStart hook

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "startup|resume",
        "hooks": [
          { "type": "command", "command": "if [ \"$CLAUDE_CODE_REMOTE\" = \"true\" ]; then npx -y localcloud-cli start || true; fi" }
        ]
      }
    ]
  }
}
```

- Cloud session VMs set `CLAUDE_CODE_REMOTE=true`; locally the hook does nothing.
- `localcloud start` without a port starts the background daemon in watch mode and returns
  immediately; every port that starts listening gets a URL. The hook's output (e.g. "localcloud is
  watching for dev servers") is added to Claude's context.
- `resume` is matched too: a session VM restored after idling starts Claude Code again, and background
  processes may be gone. `start` is idempotent, so re-running it is harmless.
- Hooks load from the repository's `.claude/settings.json` only in **single-repository** sessions.
  For multi-repo sessions, ask Claude to run `npx -y localcloud-cli start`, or use the plugin.

Optional speed-up: pre-install localcloud in the environment's **Setup script** (cached between
sessions; processes started there don't survive the cache, so keep the hook):

```bash
npm install -g localcloud-cli
```

## Skill

`npx -y localcloud-cli init --skill` writes `.claude/skills/localcloud/SKILL.md`, a skill Claude
loads whenever it starts a web server or the user asks for a preview link. The same file is in
[`skills/localcloud/SKILL.md`](../../skills/localcloud/SKILL.md).

## Plugin (MCP + skill + hook in one)

```text
/plugin marketplace add rayhankhilji/localcloud
/plugin install localcloud@localcloud
```

To enable it for everyone working on a repo, commit this to `.claude/settings.json`
(see [`integrations/claude-code/settings.json`](../../integrations/claude-code/settings.json)):

```json
{
  "extraKnownMarketplaces": {
    "localcloud": { "source": { "source": "github", "repo": "rayhankhilji/localcloud" } }
  },
  "enabledPlugins": { "localcloud@localcloud": true }
}
```

Each person still installs the plugin once (Claude Code reports it as "not installed" until then).
`/plugin` isn't available inside cloud sessions, so for cloud use prefer the committed hook + `.mcp.json`.

## MCP

```sh
claude mcp add --scope project localcloud -- npx -y localcloud-cli mcp    # writes .mcp.json
```

Cloud sessions load the repo's `.mcp.json` (single-repo sessions). Servers added with the default
local/user scope live in `~/.claude.json` on your machine and do **not** reach cloud sessions.

Tools: `share_port {port, name?, protect?}`, `get_url {port}`, `list_shared`, `stop_sharing {port}`,
`auto_share {enabled?}`, `status`; resource `localcloud://status`.

## Allowlisting the relay

Environment settings → **Network access**:

- **Trusted** (the default) only allows package registries, GitHub, cloud SDKs etc. — your relay is not on it.
- Choose **Custom**, put the relay hostname (e.g. `relay.example.com`) in **Allowed domains**, one per
  line, and tick **Also include default list of common package managers** so `npx` keeps working.
- Or choose **Full**.

Changes reach running sessions within about a minute. All traffic goes through Anthropic's security
proxy; localcloud reads `HTTPS_PROXY` and the proxy's CA bundle automatically.

## Troubleshooting

- `blocked by the network policy` / 403 → the relay isn't in **Allowed domains**.
- Hook didn't run → it must be in the repo's `.claude/settings.json` (user-level `~/.claude/settings.json`
  hooks don't reach the cloud), and the session must have exactly one repository.
- Bun-based dev servers: Bun has known proxy issues for *package fetching* in cloud sessions; serving
  works fine once dependencies are installed.
- `npx -y localcloud-cli doctor` and `npx -y localcloud-cli logs` for everything else.

Sources: [Cloud environments](https://code.claude.com/docs/en/cloud-environments),
[Plugins reference](https://code.claude.com/docs/en/plugins-reference),
[Skills](https://code.claude.com/docs/en/skills),
[Settings reference](https://code.claude.com/docs/en/settings-reference).
