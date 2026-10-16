# localcloud with coding agents

Cloud coding agents run your dev server inside a sandbox the user's browser can't reach, so a
`http://localhost:5173` link is useless. localcloud gives any local port a public HTTPS URL, from
inside locked-down sandboxes (egress proxies, TLS interception, websocket-hostile networks).

There are three ways an agent can use it — set up as many as you like:

1. **Instructions** — a rules file tells the agent to run `npx -y localcloud-cli start <port>` and
   hand over the printed URL. Works with every agent that reads a rules/instructions file.
2. **Auto-share** — the environment's startup script runs `npx -y localcloud-cli start` (no port),
   which starts a background daemon that shares every dev server the moment it starts listening.
3. **MCP** — `npx -y localcloud-cli mcp` exposes `share_port`, `get_url`, `list_shared`,
   `stop_sharing` and `auto_share` as tools.

## One command

```sh
npx -y localcloud-cli init --relay https://relay.example.com
```

That writes the `AGENTS.md` block, `CLAUDE.md`, the Claude Code SessionStart hook and
`localcloud.json` (so nobody has to configure a relay). Tool-specific files are written only for
tools already configured in the repo; force them with `--agents cursor,copilot,…` or `--all`.

| Flag | Effect |
| --- | --- |
| `--relay <url>` | Save the relay to `localcloud.json` (commit it). |
| `--agents a,b` | Also configure these tools even if not detected: `skill`, `cursor`, `copilot`, `windsurf`, `cline`, `gemini`, `codex`, `vscode`, `replit`. |
| `--all` | Configure every tool. |
| `--mcp` | Also register the MCP server for each selected tool (`.mcp.json`, `.cursor/mcp.json`, `.vscode/mcp.json`, `.gemini/settings.json`, `.codex/config.toml`). |
| `--setup` | Also add localcloud to `.cursor/environment.json` (if it exists) and create `.github/workflows/copilot-setup-steps.yml` (if missing). |
| `--skill` | Also write the Claude Code skill `.claude/skills/localcloud/SKILL.md`. |
| `--no-hook` | Don't add the Claude Code SessionStart hook. |
| `--no-detect` | Only write the defaults plus what `--agents` names. |
| `--dry-run` | Show what would change; write nothing. |
| `--json` | Machine-readable result. |

Re-running is safe: everything localcloud writes sits between `<!-- localcloud:start -->` /
`<!-- localcloud:end -->` markers or under a `localcloud` key, and is updated in place. Files that
aren't plain JSON (e.g. JSON with comments) are left alone and reported as `skipped`.

## Platform matrix

| Platform | Instructions file | Setup / startup script | MCP config | Network allowlist |
| --- | --- | --- | --- | --- |
| [Claude Code](claude-code.md) | `CLAUDE.md` (imports `AGENTS.md`), skills in `.claude/skills/` | Cloud environment **Setup script**; repo `.claude/settings.json` **SessionStart** hook | `.mcp.json` | Environment → **Network access** → **Custom** → **Allowed domains** |
| [OpenAI Codex](codex.md) | `AGENTS.md` | Environment **Setup script** / **Maintenance script** | `~/.codex/config.toml` or `.codex/config.toml` `[mcp_servers.localcloud]` | Environment → agent **Internet access** → domain allowlist (+ HTTP methods) |
| [Cursor](cursor.md) | `AGENTS.md`, `.cursor/rules/*.mdc` | `.cursor/environment.json` `install` / `start` / `terminals` | `.cursor/mcp.json` | `egressAllowlist` in `environment.json`, or the Cloud Agent network allowlist |
| [GitHub Copilot coding agent](copilot.md) | `.github/copilot-instructions.md`, `AGENTS.md` | `.github/workflows/copilot-setup-steps.yml` | Repo **Settings → Copilot → MCP servers** (JSON) | Repo **Settings → Copilot → Internet access → Custom allowlist** |
| [Devin](devin.md) | Knowledge, `AGENTS.md` (see guide) | Environment blueprint `initialize` / `maintenance` | Devin MCP settings (see guide) | Not documented (unverified) |
| [Jules](jules.md) | `AGENTS.md` | Repo **Configuration → Initial Setup** | — | Not documented (unverified) |
| [Windsurf / Devin Desktop](windsurf.md) | `.windsurf/rules/*.md` (`.devin/rules/` preferred in new versions), `AGENTS.md` | — (local IDE) | `~/.codeium/windsurf/mcp_config.json` | — |
| [Cline](cline.md) | `.clinerules/` (dir or file), `AGENTS.md` | — (local IDE) | Cline MCP settings (`cline_mcp_settings.json`) | — |
| [Gemini CLI](gemini-cli.md) | `GEMINI.md` (`@./AGENTS.md` import) or `context.fileName` | — | `.gemini/settings.json` `mcpServers` | Depends on sandbox |
| [Replit Agent](replit.md) | `replit.md` | `.replit` `run` / `onBoot` | — | — |
| [Anything else](generic.md) | `AGENTS.md` (Zed, OpenHands, Aider via `--read`, …) | `devcontainer.json` `postStartCommand`, Dockerfile, any startup hook | `.vscode/mcp.json`, Zed `context_servers`, … | Your sandbox's egress policy |

## What the sandbox must be allowed to reach

Only **the relay's own hostname** (e.g. `relay.example.com`), over HTTPS on port 443:

- The client opens a websocket to the relay and falls back to HTTPS long-polling (plain `POST` requests)
  when websockets are blocked. If your platform restricts HTTP methods, allow `POST`.
- Public URLs like `https://my-app.relay.example.com` are fetched by the *user's browser*, not by the
  sandbox, so the wildcard doesn't need to be on the sandbox allowlist.
- `npx -y localcloud-cli` also needs `registry.npmjs.org` (on every platform's default package
  allowlist) unless localcloud is pre-installed in the setup script.
- `HTTPS_PROXY` / `NO_PROXY` and extra CA bundles (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, the system
  store) are picked up automatically, so TLS-intercepting egress proxies work.

## Troubleshooting (all platforms)

| Symptom | Fix |
| --- | --- |
| `localcloud needs a relay` | Commit `localcloud.json` (`localcloud init --relay …`) or set `LOCALCLOUD_RELAY` in the environment's variables. |
| `blocked by the network policy`, HTTP 403/407 | Add the relay hostname to the platform's network allowlist (table above). |
| `ENOTFOUND` / `EAI_AGAIN` | Typo in the relay URL, or DNS is blocked entirely (network access off). |
| URL shows "waiting for your server" | Nothing listens on that port yet; start the dev server. |
| Agent still prints localhost links | Make sure its instructions file was written (`localcloud init --dry-run` shows what's missing) and that the agent actually loads that file. |
| Anything else | `npx -y localcloud-cli doctor` checks the proxy, websocket and long-poll paths; `npx -y localcloud-cli logs` shows the daemon log. |

Snippets for every platform: [`integrations/`](../../integrations/README.md). Runnable demos:
[`examples/`](../../examples/).
