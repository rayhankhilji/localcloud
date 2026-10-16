# Any other agent or sandbox

Zed, OpenHands, Aider, Goose, Amp, Codespaces, Gitpod, devcontainers, your own Docker sandbox — the
recipe is the same.

## 1-minute setup

```sh
npx -y localcloud-cli init --relay https://relay.example.com
```

`AGENTS.md` is read by most agents (Zed, OpenHands, Codex, Cursor, Copilot, Jules, Cline, Windsurf, …).
For agents that need a different file, put the same block there — `init` prints it between
`<!-- localcloud:start -->` markers. Aider: `aider --read AGENTS.md`, or `read: AGENTS.md` in
`.aider.conf.yml`.

## Auto-share from any startup script

```sh
npx -y localcloud-cli start      # background daemon; shares every dev server that starts listening
```

or [`integrations/generic/start.sh`](../../integrations/generic/start.sh), which prefers a pre-installed
binary. It's idempotent, so running it on every boot is fine. Needs a relay from `localcloud.json` or
`LOCALCLOUD_RELAY`.

Wrap a single command instead of running a daemon:

```sh
npx -y localcloud-cli run -- npm run dev
```

### Dev containers / Codespaces

[`integrations/devcontainer/devcontainer.json`](../../integrations/devcontainer/devcontainer.json):

```jsonc
{
  "postCreateCommand": "npm install && npm install -g localcloud-cli",
  "postStartCommand": "localcloud start || true",
  "containerEnv": { "LOCALCLOUD_RELAY": "https://relay.example.com" }
}
```

`postStartCommand` runs on every container start; build-time `RUN` steps can't keep processes alive.

### OpenHands

Commit [`.openhands/setup.sh`](../../integrations/openhands/setup.sh) — OpenHands runs it when it starts
working on the repo. MCP servers are added in the UI (**Customize → MCP Servers → Add custom server →
STDIO**: command `npx`, arguments `-y`, `localcloud-cli`, `mcp`) or with `openhands mcp add`.

## MCP clients

### VS Code

`.vscode/mcp.json` (`init --mcp` writes it when `.vscode/` exists, or with `--agents vscode`):

```json
{ "servers": { "localcloud": { "type": "stdio", "command": "npx", "args": ["-y", "localcloud-cli", "mcp"] } } }
```

### Zed

`settings.json` ([`integrations/zed/settings.json`](../../integrations/zed/settings.json)):

```json
{ "context_servers": { "localcloud": { "command": "npx", "args": ["-y", "localcloud-cli", "mcp"], "env": {} } } }
```

### Anything else

Command `npx`, args `["-y", "localcloud-cli", "mcp"]`, stdio transport. The server speaks MCP
2024-11-05 through 2025-11-25 (`initialize`) and 2026-07-28 (`server/discover`, per-request `_meta`).
It's listed in the MCP registry as `io.github.rayhankhilji/localcloud` once published.

## Allowlisting

Allow outbound HTTPS to the relay hostname only. Websocket first, HTTPS long-poll (`POST`) fallback;
`HTTPS_PROXY`, `NO_PROXY`, `NODE_EXTRA_CA_CERTS` / `SSL_CERT_FILE` are honoured.

## Troubleshooting

See the [overview](README.md#troubleshooting-all-platforms).
