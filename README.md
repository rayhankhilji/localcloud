<div align="center">

# ☁ localcloud

**Share `localhost` from anywhere, including the cloud sandbox your coding agent runs in.**

One command gives you a public HTTPS URL for a dev server. It works through the locked-down,
TLS-intercepting egress proxies that Claude Code on the web, Codex, Cursor background agents,
Devin and similar tools put in front of their sandboxes.

[![npm](https://img.shields.io/npm/v/localcloud-cli?color=6d5dfc&label=npm)](https://www.npmjs.com/package/localcloud-cli)
[![CI](https://github.com/rayhankhilji/localcloud/actions/workflows/ci.yml/badge.svg)](https://github.com/rayhankhilji/localcloud/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/node/v/localcloud-cli?color=3c873a)](package.json)

```sh
npx localcloud-cli 3000
```

</div>

---

Your agent just ran `npm run dev` and said *"open http://localhost:5173"*. That link points at a
container in someone else's datacenter, so you can't open it.

**localcloud** turns that port into a URL you can open on your laptop or phone, or send to a teammate.
It was built for the places where ngrok, cloudflared and localtunnel break: sandboxes where every
outbound byte goes through an HTTPS proxy, WebSockets may be blocked, a custom CA re-signs every
certificate, and the agent can't keep a foreground process running.

## Contents

- [Quickstart](#quickstart)
- [Why localcloud](#why-localcloud)
- [Set it up for your agent](#set-it-up-for-your-agent)
- [Features](#features)
- [How it works](#how-it-works)
- [Self-hosting in 60 seconds](#self-hosting-in-60-seconds)
- [CLI reference](#cli-reference)
- [FAQ](#faq)
- [Contributing](#contributing) · [License](#license)

## Quickstart

localcloud has a client (this CLI) and a **relay**, the public server that gives out the URLs.
**There is no hosted public relay yet**, so you need a relay URL: run your own
([60 seconds](#self-hosting-in-60-seconds)) or use one your team already runs.

```sh
export LOCALCLOUD_RELAY=https://relay.example.com   # your relay

npx localcloud-cli 3000                 # share port 3000 in the foreground
```

```text
  ☁  localcloud  · via websocket

  ➜  Public   https://sunny-otter-x7k2.relay.example.com
  ➜  Local    http://localhost:3000

  Requests will show up below. Ctrl+C to stop.

  14:34:03  GET    200    12ms  /
  14:34:03  GET    200     4ms  /@vite/client
  14:34:04  GET    WS      3ms  /?token=Hh8sRZ1m
```

Agents can't babysit a foreground process, so they should use **background mode**. `start` hands
the tunnel to a small daemon, prints the URL and exits right away:

```sh
$ npx -y localcloud-cli start 3000
http://localhost:3000 → https://sunny-otter-x7k2.relay.example.com

$ npx -y localcloud-cli start            # no port: auto-share every dev server that starts
✓ localcloud is watching for dev servers — any port that starts listening gets a public URL.
  Run localcloud ls (or localcloud url <port>) to see the URLs.
```

To set the relay once per repo, so that nobody (human or agent) has to configure anything, run:

```sh
npx localcloud-cli init --relay https://relay.example.com
```

This writes `localcloud.json`, adds instructions to `AGENTS.md`/`CLAUDE.md`, and adds a Claude Code
SessionStart hook. Commit the result.

> **Sandbox network policy:** a cloud sandbox can only reach domains its network policy allows.
> Add your relay's domain to the environment's allowlist. `npx localcloud-cli doctor` tells you
> whether it's reachable. See [troubleshooting](docs/troubleshooting.md#proxy-403--blocked-by-the-network-policy).

## Why localcloud

ngrok and cloudflared are excellent on a laptop. localcloud is for when your code isn't running on
your laptop.

| | **localcloud** | ngrok | cloudflared quick tunnels | localtunnel | VS Code port forwarding |
|---|:-:|:-:|:-:|:-:|:-:|
| Works through an `HTTPS_PROXY`-only egress proxy | ✅ automatic (CONNECT + `NO_PROXY`) | ⚙️ needs `proxy_url` config | ❌ needs outbound port 7844 | ❌ raw TCP to random ports | ➖ |
| Trusts a TLS-intercepting proxy's CA | ✅ auto-loads `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, system bundles | ⚙️ needs `root_cas` config | ⚙️ | ❌ | ➖ |
| Keeps working when WebSockets are blocked | ✅ falls back to HTTPS long-polling | ❌ | ❌ | ❌ | ➖ |
| Background mode that returns the URL immediately | ✅ `localcloud start` | ⚙️ `&` + local API | ❌ URL is in the logs | ❌ | ➖ |
| Auto-shares new dev servers | ✅ | ❌ | ❌ | ❌ | ✅ |
| Vite / Next.js / Angular host checks pass with no config | ✅ Host/Origin rewritten by default | ⚙️ `--host-header=rewrite` | ⚙️ `--http-host-header` | ⚙️ `--local-host` | ➖ |
| No account or sign-up | ✅ | ❌ authtoken | ✅ | ✅ | ❌ GitHub/Microsoft sign-in |
| No interstitial page for visitors | ✅ | ❌ on the free plan | ✅ | ❌ tunnel password page | ➖ |
| Self-hostable server | ✅ one Node process or Docker | ❌ | ❌ | ✅ | ❌ |
| Open-source client | ✅ MIT | ❌ | ✅ | ✅ | ❌ |
| Hosted public service you can use today | ❌ **not yet**, bring a relay | ✅ | ✅ | ✅ | ✅ |
| Built-in MCP server and agent instructions | ✅ | ➖ | ➖ | ➖ | ➖ |

✅ yes · ⚙️ possible with extra flags or config · ❌ no · ➖ not applicable or varies.
This table reflects our understanding of each tool when we wrote it, and the other tools change
often. If something here is wrong, please [open a PR](CONTRIBUTING.md).

The honest trade-off: localcloud doesn't have a free hosted relay or a global edge network, and it
doesn't add features like request inspection or replay. It is small, it is MIT-licensed, and it gets
through sandbox networks that block the other tools.

## Set it up for your agent

The universal recipe is the same everywhere:

1. **Allow your relay's domain** in the sandbox's network settings.
2. **Make the relay discoverable**: commit `localcloud.json` (`npx localcloud-cli init --relay …`)
   or set `LOCALCLOUD_RELAY` in the environment.
3. **Tell the agent**: `init` writes an `AGENTS.md`/`CLAUDE.md` block telling agents to run
   `npx -y localcloud-cli start <port>` and give you the printed URL.

<details open>
<summary><b>Claude Code on the web</b></summary>

```sh
npx localcloud-cli init --relay https://relay.example.com
git add localcloud.json AGENTS.md CLAUDE.md .claude/settings.json && git commit -m "Add localcloud"
```

`init` adds a SessionStart hook. In cloud sessions (`CLAUDE_CODE_REMOTE=true`) it runs
`npx -y localcloud-cli start`, so every dev server is shared automatically. Then add the relay
domain to the environment's allowed domains under **Network access**.
→ [docs/agents/claude-code.md](docs/agents/claude-code.md)
</details>

<details>
<summary><b>OpenAI Codex (cloud)</b></summary>

Codex reads `AGENTS.md`, so `npx localcloud-cli init --relay …` is enough to teach it. Turn on
agent internet access for the environment, allow the relay domain, and allow `POST` requests
(the long-poll fallback uses them). The agent should run `npx -y localcloud-cli start <port>` itself,
because background processes started by the setup script don't carry over into the agent's session.
→ [docs/agents/codex.md](docs/agents/codex.md)
</details>

<details>
<summary><b>Cursor background agents</b></summary>

```json
// .cursor/environment.json
{
  "install": "npm install",
  "terminals": [{ "name": "localcloud", "command": "npx -y localcloud-cli start || true" }]
}
```

`npx localcloud-cli init --setup` adds this entry to an existing `environment.json` for you, along
with the relay host in `egressAllowlist`.

→ [docs/agents/cursor.md](docs/agents/cursor.md)
</details>

<details>
<summary><b>Devin</b></summary>

Add `npx -y localcloud-cli start` to the machine's startup commands and set `LOCALCLOUD_RELAY`
(or commit `localcloud.json`). Devin follows the `AGENTS.md` block that `init` writes.
→ [docs/agents/devin.md](docs/agents/devin.md)
</details>

<details>
<summary><b>MCP-capable agents</b></summary>

```sh
npx localcloud-cli init --mcp     # writes .mcp.json
```

```json
{ "mcpServers": { "localcloud": { "command": "npx", "args": ["-y", "localcloud-cli", "mcp"] } } }
```

Tools: `share_port`, `get_url`, `list_shared`, `stop_sharing`, `auto_share`. Resource:
`localcloud://status`. Set the relay with `localcloud.json` or an `env` entry
(`"env": {"LOCALCLOUD_RELAY": "https://…"}`).
</details>

<details>
<summary><b>Anything else</b> (Jules, Copilot coding agent, Replit, Codespaces, CI, a VPS…)</summary>

```sh
export LOCALCLOUD_RELAY=https://relay.example.com
npx -y localcloud-cli start            # keeps running in the background
npx -y localcloud-cli ls               # see the URLs
```

If the platform has an egress firewall, allow the relay domain.
→ [docs/agents/README.md](docs/agents/README.md)
</details>

## Features

- **Gets through agent sandboxes.** Honors `HTTPS_PROXY` / `HTTP_PROXY` / `ALL_PROXY` / `NO_PROXY`
  (with proxy auth), and trusts extra CAs from `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
  `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO` and the system bundle.
- **Two transports, picked automatically.** It uses a WebSocket when it can. If the proxy blocks
  upgrades, it switches to plain **HTTPS long-polling**, which works anywhere a normal `POST` does.
- **Background mode for agents.** `start` returns as soon as the URL exists. A small daemon keeps
  the tunnels alive, and `ls`, `url`, `stop` and `logs` manage it.
- **Auto-detects dev servers.** It watches for new listening ports (Linux and macOS) and shares
  them. Databases and debuggers (Postgres, MySQL, Redis, Mongo, the Node inspector…) are never
  shared automatically.
- **`localcloud run -- npm run dev`.** Starts your server and shares whatever port it opens.
- **Dev servers just work.** Host, Origin and Referer are rewritten to `localhost` by default, so
  Vite `allowedHosts`, webpack-dev-server, Angular and Next.js origin checks pass with no config.
  `Location` redirects and cookie domains are rewritten on the way back.
- **WebSockets and HMR.** Upgrades are tunneled as raw byte streams, so Vite, Next.js and
  webpack hot reload work over either transport.
- **Stable URLs.** If the connection drops, the client reconnects with backoff and gets the same
  URL back. Requests that arrive during a short drop wait up to 8 s instead of failing.
- **Friendly waiting pages.** If nothing is listening yet, or the sandbox is reconnecting, visitors
  see a page that reloads by itself once the server is back.
- **Private links.** `--protect` adds an unguessable access key to the URL, and `--auth user:pass`
  adds HTTP basic auth. See [docs/security.md](docs/security.md).
- **Teaches your agents.** `init` writes `AGENTS.md`/`CLAUDE.md` instructions and a Claude Code
  SessionStart hook. It also writes rules for the tools it detects in the repo (Cursor, Copilot,
  Windsurf, Cline, Gemini CLI, Replit…). `--mcp` registers the MCP server and `--setup` wires up
  Cursor and Copilot environment files.
- **`doctor`.** Checks the proxy, CA, relay health, the WebSocket and long-poll transports, and the daemon.
- **Self-hostable relay.** It's one Node process with one dependency (`ws`). Run it with Docker, on
  Fly/Render/Railway, or on any VPS. No database is needed.
- **Pick your subdomain.** `--name my-app` gives you `https://my-app.relay.example.com`.
- **Machine-readable output.** Every command that prints a URL supports `--json`.

## How it works

```text
 browser ──HTTPS──▶  relay (public)  ◀══ outbound WebSocket ══ localcloud client ──▶ localhost:3000
 *.relay.example.com                    or HTTPS long-poll      (inside the sandbox,
                                        through the egress      behind HTTPS_PROXY)
                                        proxy
```

1. The client opens **one outbound connection** to the relay. It tries a WebSocket first and falls
   back to HTTPS long-polling. Nothing inbound is needed, so it works anywhere `curl https://…` works.
2. It asks for a tunnel. The relay assigns a name like `sunny-otter-x7k2` (or your `--name`) and
   returns the URL.
3. A browser request to that URL is framed and multiplexed over the connection. The client replays
   it against the local server with rewritten headers, then streams the response back, with
   per-stream flow control in both directions.
4. If the connection drops, the client reconnects and reclaims the same name using a per-process
   secret, and the relay holds incoming requests for a few seconds while it does.

Deep dives: [how it works](docs/how-it-works.md) · [wire protocol](docs/protocol.md) ·
[security model](docs/security.md)

## Self-hosting in 60 seconds

The relay is the same npm package: `npx localcloud-cli relay`.

**Docker, with wildcard subdomains** (`https://<name>.tunnel.example.com`). You need a wildcard DNS
record and TLS in front of the relay, for example Caddy (see [`deploy/`](deploy/)):

```sh
docker run -d --name localcloud-relay --restart unless-stopped -p 8080:8080 \
  -e LOCALCLOUD_DOMAIN=tunnel.example.com \
  -e LOCALCLOUD_RELAY_TOKEN=change-me \
  ghcr.io/rayhankhilji/localcloud
```

**Single domain, no wildcard DNS** (for example the free `*.fly.dev` / `*.onrender.com` HTTPS
hostname). Leave out `LOCALCLOUD_DOMAIN` and the relay uses cookie routing, with URLs like
`https://my-relay.fly.dev/__localcloud/t/sunny-otter-x7k2`.

Then point clients at it:

```sh
npx localcloud-cli config set relay https://tunnel.example.com
npx localcloud-cli config set token change-me      # only if you set LOCALCLOUD_RELAY_TOKEN
npx localcloud-cli doctor
```

The full guide covers Fly.io, Render, Railway, docker-compose + Caddy, Kubernetes, nginx, systemd,
TLS, on-demand certificates and the Cloudflare Workers relay in [`relay-cloudflare/`](relay-cloudflare/):
→ **[docs/self-hosting.md](docs/self-hosting.md)**

## CLI reference

```text
localcloud <port|url>...          Share in the foreground (Ctrl+C to stop)
localcloud start [port...]        Share in the background, print the URL(s), exit
                                  (no port: auto-share every dev server that starts)
localcloud url <port>             Print just the public URL (shares it if needed)
localcloud ls                     List what's shared
localcloud stop [port...]         Stop sharing a port, or stop everything
localcloud run -- <command>       Run a dev server and share whatever port it opens
localcloud logs [-f]              Show the background daemon's log
localcloud doctor                 Check connectivity (proxy, websocket, long-poll)
localcloud init [--relay <url>]   Teach your coding agents to use localcloud in this repo
localcloud mcp                    Run as an MCP server
localcloud relay                  Run your own relay server
localcloud config [set|unset <key> <value>]
```

| Option | |
|---|---|
| `--relay <url>` | Relay to use (env `LOCALCLOUD_RELAY`, `localcloud.json`, or `localcloud config set relay`) |
| `--token <token>` | Relay access token (env `LOCALCLOUD_TOKEN`) |
| `--name <name>` | Pick the subdomain: `--name my-app` → `https://my-app.<relay domain>` |
| `--protect` | Private link: visitors need the access key in the URL |
| `--auth <user:pass>` | Require HTTP basic auth |
| `--host-header <mode>` | `rewrite` (default; dev server sees `localhost`) · `preserve` · `<custom host>` |
| `--transport <mode>` | `auto` (default) · `ws` · `http` |
| `--json` | Machine-readable output |

Targets can be a port (`3000`), `host:port`, or a URL such as `https://localhost:8443`.
Settings are read from flags first, then env vars, then `localcloud.json` (searched upward from the
current directory), then `~/.localcloud/config.json`.
Everything else is covered in the **[full CLI reference](docs/cli.md)** and
**[configuration](docs/configuration.md)**.

## FAQ

<details>
<summary><b>Is my dev server now public on the internet?</b></summary>

Yes. Anyone with the URL can open it. Generated names are random (about 4 billion combinations),
but treat a plain URL as public. If the app holds anything sensitive, use `--protect` (the link
carries a 144-bit access key and visitors without it get a "this preview is private" page) or
`--auth user:pass`. The tunnel exists only while the client runs, so `localcloud stop` ends it.
Read [docs/security.md](docs/security.md).
</details>

<details>
<summary><b>Who can see my traffic?</b></summary>

The relay terminates TLS, so whoever operates it can see the requests passing through. That's why
localcloud is built to be self-hosted. Run your own relay and nobody else is in the path.
</details>

<details>
<summary><b>How do I stop random people from using my relay?</b></summary>

Set `LOCALCLOUD_RELAY_TOKEN` on the relay. Clients then need `--token`, `LOCALCLOUD_TOKEN`, or
`localcloud config set token …`.
</details>

<details>
<summary><b>Does hot reload (HMR) work?</b></summary>

Yes. WebSocket upgrades are tunneled byte for byte, including over the long-poll fallback (with
somewhat higher latency). If your HMR client is hard-coded to `localhost` or a specific port
(`server.hmr.clientPort`, `WDS_SOCKET_PORT`, …), remove that override so it connects to the page's
own host. See [troubleshooting](docs/troubleshooting.md#hmr--hot-reload-doesnt-connect).
</details>

<details>
<summary><b>Why not just use ngrok?</b></summary>

On your laptop, use whatever you like. In an agent sandbox, ngrok needs an account token, extra
config to use the sandbox proxy and trust its CA, and a foreground process. Its free plan also shows
visitors a warning page. localcloud works with no flags in those environments and is designed
around how agents work (`start` returns immediately, `init` writes instructions, MCP tools). See
[the comparison](#why-localcloud).
</details>

<details>
<summary><b>"proxy refused CONNECT … HTTP 403": what do I allowlist?</b></summary>

The relay's hostname. For subdomain routing, allow the wildcard too (e.g. `*.tunnel.example.com`)
if your platform distinguishes the two. Only the client's connection to the relay needs to be
allowed; browsers reach the relay directly. `npx` also needs the npm registry
(`registry.npmjs.org`), which most sandboxes already allow. Per-platform steps are in
[troubleshooting](docs/troubleshooting.md#proxy-403--blocked-by-the-network-policy).
</details>

<details>
<summary><b>Which frameworks work?</b></summary>

Anything that speaks HTTP/1.1 on a TCP port: Vite (React, Vue, Svelte, Solid, Astro…), Next.js,
Nuxt, Remix, SvelteKit, Angular, webpack-dev-server, Storybook, Express, Rails, Django, Flask,
FastAPI, Phoenix, Go, static servers. Host-header checks are handled by default. Local HTTPS dev
servers work too (`localcloud https://localhost:8443`).
</details>

<details>
<summary><b>Does the URL stay the same?</b></summary>

It does across network drops and sandbox naps, as long as the same client process is running.
A new process gets a new random name unless you pass `--name`. If a process with a `--name`
crashes without shutting down cleanly, the relay reserves that name for up to an hour.
</details>

<details>
<summary><b>Windows?</b></summary>

Sharing, background mode (the daemon listens on a named pipe) and the relay are supported on
Windows. Automatic port detection (`start` with no port, `run`) is Linux/macOS only, so pass the
port explicitly on Windows.
</details>

## Contributing

Issues and PRs are welcome. localcloud is plain ESM JavaScript with no build step and a single
runtime dependency.

```sh
git clone https://github.com/rayhankhilji/localcloud && cd localcloud
npm install && npm test
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for the project layout and guidelines, and
[SECURITY.md](SECURITY.md) to report vulnerabilities privately. Everyone taking part is expected to
follow the [Code of Conduct](CODE_OF_CONDUCT.md).

## License

[MIT](LICENSE) © 2026 localcloud contributors
