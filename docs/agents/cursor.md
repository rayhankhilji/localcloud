# Cursor (Agent, cloud agents)

## 1-minute setup

```sh
npx -y localcloud-cli init --relay https://relay.example.com --agents cursor --mcp
```

Writes `AGENTS.md` (Cursor reads it), `.cursor/rules/localcloud.mdc` (an **Always Apply** rule) and
`.cursor/mcp.json`. Commit them.

## Auto-share in cloud agents: `.cursor/environment.json`

Cloud agents boot from a Build; `install` runs when the Build is created, then on every agent start
Cursor runs `start` and the `terminals`. Builds keep disk state only, so the daemon has to be started
from `start` or a terminal ([`integrations/cursor/environment.json`](../../integrations/cursor/environment.json)):

```json
{
  "install": "npm install && npm install -g localcloud-cli",
  "terminals": [
    {
      "name": "localcloud",
      "command": "localcloud start || npx -y localcloud-cli start",
      "description": "Auto-shares every dev server at a public HTTPS URL. Run `localcloud ls` to see the URLs."
    }
  ],
  "egressAllowlist": ["relay.example.com"]
}
```

`npx -y localcloud-cli init --setup --agents cursor` adds the terminal entry (and your relay to
`egressAllowlist`) to an existing `environment.json`. It won't create the file, because an
`environment.json` replaces whatever you configured for the environment in the dashboard.

## MCP

`.cursor/mcp.json` (project) or `~/.cursor/mcp.json` (global):

```json
{
  "mcpServers": {
    "localcloud": { "type": "stdio", "command": "npx", "args": ["-y", "localcloud-cli", "mcp"] }
  }
}
```

Unverified: whether cloud agents start project `mcp.json` servers. Team servers added under
**Dashboard → Plugins & MCPs** are documented to be available to cloud agents. The rules file and the
terminal entry work either way.

## Allowlisting the relay

If your cloud agents use restricted egress, the relay hostname must be allowed:

- per environment: `egressAllowlist` in `environment.json` (unioned with the inherited team/user
  allowlist unless you set `egressMode`), or
- the **Cloud Agent network allowlist** in Cursor's settings.

## Troubleshooting

- Rule not applied → `.cursor/rules/` only loads `.mdc` files with frontmatter; the generated file has
  `alwaysApply: true`.
- `localcloud` not found in the terminal → `install` didn't run on this Build; the command falls back to `npx`.
- 403 / network policy → relay hostname missing from the egress allowlist.

Sources: [Rules](https://cursor.com/docs/context/rules), [Cloud agent setup](https://cursor.com/docs/cloud-agent/setup),
[environment.json schema](https://www.cursor.com/schemas/environment.schema.json), [MCP](https://cursor.com/docs/context/mcp).
