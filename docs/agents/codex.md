# OpenAI Codex (cloud, CLI, IDE)

## 1-minute setup

```sh
npx -y localcloud-cli init --relay https://relay.example.com
git add AGENTS.md localcloud.json && git commit -m "Share dev servers with localcloud"
```

Codex reads `AGENTS.md`, so cloud tasks now run `localcloud start <port>` after starting a dev
server and reply with the https URL.

## Cloud environment

In the Codex environment settings:

1. **Setup script** — pre-install localcloud while the setup phase still has internet access
   ([`integrations/codex/setup.sh`](../../integrations/codex/setup.sh)):

   ```bash
   npm install -g localcloud-cli
   ```

2. **Agent internet access** — it is **Off** by default during the agent phase. Turn it **On**,
   keep the **Common dependencies** preset (or **None**), and add your relay's hostname
   (e.g. `relay.example.com`) as an additional domain.
3. **Allowed HTTP methods** — if restricted to `GET`, `HEAD`, `OPTIONS`, localcloud can only use
   its websocket transport; its HTTPS long-poll fallback needs `POST`. Allow all methods if
   `localcloud doctor` reports the websocket path failing.
4. Optional **Environment variable** `LOCALCLOUD_RELAY=https://…` instead of committing
   `localcloud.json`. (Use a variable, not a *secret* — secrets are removed before the agent phase.)

### Auto-share

The setup script runs in a separate shell before the agent phase, and nothing documents background
processes surviving into the agent phase — so don't rely on `localcloud start` in the setup script.
The `AGENTS.md` block makes the agent start sharing itself; ask "share the dev server" if it doesn't.
(Unverified: if your environment keeps processes alive from the **Maintenance script**, `localcloud
start` there would auto-share — `start` is idempotent, so it's harmless to try.)

## MCP (Codex CLI / IDE extension)

```sh
codex mcp add localcloud -- npx -y localcloud-cli mcp
```

or in `~/.codex/config.toml` (or `.codex/config.toml` in a trusted project —
`npx -y localcloud-cli init --mcp --agents codex` writes it):

```toml
[mcp_servers.localcloud]
command = "npx"
args = ["-y", "localcloud-cli", "mcp"]
```

`startup_timeout_sec` defaults to 10 s; raise it if the first `npx` download is slow.

## Troubleshooting

- `getaddrinfo ENOTFOUND` / connection refused in the agent phase → agent internet access is still Off.
- `blocked by the network policy` / 403 → relay hostname missing from the domain allowlist.
- Long-poll errors on `POST` → allowed HTTP methods are restricted (see above).
- Relay not found in the agent phase but set in the setup script → `export` doesn't carry over; use an
  environment variable or `~/.bashrc`.

Sources: [Codex cloud environments](https://learn.chatgpt.com/docs/environments/cloud-environment),
[Agent internet access](https://learn.chatgpt.com/docs/cloud/internet-access),
[Codex MCP](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).
