# Gemini CLI

## 1-minute setup

```sh
npx -y localcloud-cli init --relay https://relay.example.com --agents gemini --mcp
```

- No `GEMINI.md` yet → creates one containing `@./AGENTS.md` (Gemini's import syntax), so both
  files stay in sync.
- Existing `GEMINI.md` → appends the localcloud block (unless it already imports `AGENTS.md`).
- `.gemini/settings.json` already lists `AGENTS.md` in `context.fileName` → nothing to do.
- `--mcp` adds `mcpServers.localcloud` to `.gemini/settings.json` (project settings override user settings).

## MCP

`.gemini/settings.json` ([`integrations/gemini-cli/settings.json`](../../integrations/gemini-cli/settings.json)):

```json
{
  "mcpServers": {
    "localcloud": { "command": "npx", "args": ["-y", "localcloud-cli", "mcp"] }
  },
  "context": { "fileName": ["AGENTS.md", "GEMINI.md"] }
}
```

Avoid underscores in server aliases (Gemini's docs warn about it); `localcloud` is fine. Add
`"trust": true` to skip tool-call confirmations if you want.

## Auto-share

Run `npx -y localcloud-cli start` once in the shell Gemini CLI runs in (or in your container's startup
script when it runs in a cloud sandbox/CI).

## Allowlisting

Depends on where Gemini CLI runs: in its sandbox mode or a CI runner, allow the relay hostname in that
sandbox's network policy.

## Troubleshooting

- Block not loaded → run `/memory show` in Gemini CLI to see which context files were loaded.
- `npx -y localcloud-cli doctor` for connectivity.

Sources: [Gemini CLI configuration](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/configuration.md),
[Memory import processor](https://github.com/google-gemini/gemini-cli/blob/main/docs/reference/memport.md).
