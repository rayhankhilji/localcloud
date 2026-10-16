# Windsurf / Devin Desktop (Cascade)

Windsurf's editor is now **Devin Desktop**; its agent is still Cascade. It runs locally, so localcloud
is for sharing your dev server with someone else (or your phone) rather than escaping a sandbox.

## 1-minute setup

```sh
npx -y localcloud-cli init --relay https://relay.example.com --agents windsurf
```

Writes `AGENTS.md` (Cascade loads a root `AGENTS.md` as an always-on rule) and
`.windsurf/rules/localcloud.md` with `trigger: always_on`. If the repo already uses the newer
`.devin/rules/` folder (and no `.windsurf/`), the rule goes there instead. Workspace rule files are
limited to 12,000 characters; ours is ~1,000.

## Auto-share

Run `npx -y localcloud-cli start` once in a terminal; it keeps running in the background and shares
every dev server you start.

## MCP

Add to `~/.codeium/windsurf/mcp_config.json` (or via Cascade's MCP settings)
([`integrations/windsurf/mcp_config.json`](../../integrations/windsurf/mcp_config.json)):

```json
{ "mcpServers": { "localcloud": { "command": "npx", "args": ["-y", "localcloud-cli", "mcp"] } } }
```

This is a per-user file, so `init --mcp` doesn't write it.

## Allowlisting

Local machine — only corporate proxies/firewalls apply. localcloud honours `HTTPS_PROXY`.

## Troubleshooting

- Rule not picked up → check it's under `.windsurf/rules/` (or `.devin/rules/`) with the `trigger` frontmatter.
- `npx -y localcloud-cli doctor` for connectivity.

Source: [Cascade rules & memories](https://docs.devin.ai/desktop/cascade/memories).
