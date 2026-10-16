# Cline

## 1-minute setup

```sh
npx -y localcloud-cli init --relay https://relay.example.com --agents cline
```

- If `.clinerules` is a **directory** (current Cline) or missing, writes `.clinerules/localcloud.md`
  (no frontmatter = always active).
- If `.clinerules` is a single **file** (older setups), the localcloud block is appended to it.
- If only `.cline/rules/` exists, the rule goes there.

Cline also reads `AGENTS.md`, `.cursorrules` and `.windsurfrules`.

## Auto-share

Cline runs locally (VS Code / JetBrains / CLI). Run `npx -y localcloud-cli start` once; every dev server
is shared. In a remote dev container or Codespace, put it in `postStartCommand` (see [generic](generic.md)).

## MCP

Open Cline's MCP servers panel → configure, and add to `cline_mcp_settings.json`
([`integrations/cline/cline_mcp_settings.json`](../../integrations/cline/cline_mcp_settings.json)):

```json
{ "mcpServers": { "localcloud": { "command": "npx", "args": ["-y", "localcloud-cli", "mcp"] } } }
```

(Per-user settings file; its exact location depends on the editor — unverified, use the panel.)

## Allowlisting

Local machine — corporate proxies only; `HTTPS_PROXY` is honoured.

## Troubleshooting

`npx -y localcloud-cli doctor`. If the rule isn't applied, check Cline's rules panel lists `localcloud.md`.

Source: [Cline rules](https://docs.cline.bot/customization/cline-rules).
