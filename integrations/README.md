# Integration snippets

Copy-paste config for every coding agent. Most of it is generated for you by

```sh
npx -y localcloud-cli init --relay https://your-relay --mcp      # add --all to configure every tool, --dry-run to preview
```

Per-platform guides (what each file does, network allowlists, troubleshooting) live in
[`docs/agents/`](../docs/agents/README.md).

| Folder | What's inside |
| --- | --- |
| [`claude-code/`](claude-code/) | Claude Code plugin (`.claude-plugin/plugin.json` + skill + MCP + hook), `settings.json` hook, `.mcp.json`, cloud setup script |
| [`codex/`](codex/) | `config.toml` MCP entry, cloud setup + maintenance scripts |
| [`cursor/`](cursor/) | `environment.json` (cloud agents), `rules/localcloud.mdc`, `mcp.json` |
| [`copilot/`](copilot/) | `copilot-setup-steps.yml`, MCP configuration JSON for repository settings |
| [`devin/`](devin/) | blueprint snippet (initialize / maintenance / knowledge) |
| [`gemini-cli/`](gemini-cli/) | `.gemini/settings.json`, `GEMINI.md` |
| [`vscode/`](vscode/) | `.vscode/mcp.json` |
| [`windsurf/`](windsurf/) | `.windsurf/rules/localcloud.md`, `mcp_config.json` |
| [`cline/`](cline/) | `.clinerules/localcloud.md`, `cline_mcp_settings.json` |
| [`replit/`](replit/) | `.replit` run command, `replit.md` |
| [`jules/`](jules/) | Initial Setup script |
| [`zed/`](zed/) | `context_servers` settings |
| [`openhands/`](openhands/) | `.openhands/setup.sh` |
| [`devcontainer/`](devcontainer/) | `devcontainer.json` with `postStartCommand`, Dockerfile snippet |
| [`generic/`](generic/) | `start.sh` for any other sandbox's startup script |

Every snippet uses the same three entry points:

- `npx -y localcloud-cli start [port]` — share in the background, print the URL, return immediately.
- `npx -y localcloud-cli mcp` — stdio MCP server.
- A relay, from `localcloud.json` (`{"relay": "https://…"}`), `LOCALCLOUD_RELAY`, or `--relay`.
