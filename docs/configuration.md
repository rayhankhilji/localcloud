# Configuration

localcloud needs exactly one setting: **which relay to use**. There's no hosted default relay yet,
so you set it once, ideally in a file committed to the repo so that every agent session picks it up
automatically.

- [Settings](#settings)
- [Where settings come from](#where-settings-come-from)
- [Project file: `localcloud.json`](#project-file-localcloudjson)
- [User file: `~/.localcloud/config.json`](#user-file-localcloudconfigjson)
- [Environment variables](#environment-variables)
- [Proxy and certificates](#proxy-and-certificates)
- [Watch-mode tuning](#watch-mode-tuning)
- [Per-tunnel options](#per-tunnel-options)
- [Relay configuration](#relay-configuration)
- [Recipes](#recipes)

## Settings

| Key | Flag | Env | Default | |
|---|---|---|---|---|
| `relay` | `--relay` | `LOCALCLOUD_RELAY` | none | Relay base URL, e.g. `https://tunnel.example.com`. A bare hostname gets `https://`. |
| `token` | `--token` | `LOCALCLOUD_TOKEN` | none | Needed only if the relay sets `LOCALCLOUD_RELAY_TOKEN`. |
| `transport` | `--transport` | `LOCALCLOUD_TRANSPORT` | `auto` | `auto`, `ws` or `http` (long-poll). |

## Where settings come from

Each key is resolved separately, and the first source that has it wins:

1. **Flags**: `--relay`, `--token`, `--transport`
2. **Environment**: `LOCALCLOUD_RELAY`, `LOCALCLOUD_TOKEN`, `LOCALCLOUD_TRANSPORT`
3. **Project file**: `localcloud.json` or `.localcloud.json`, looked up from the current directory
   up to the filesystem root. The nearest one wins.
4. **User file**: `~/.localcloud/config.json` (or `$LOCALCLOUD_HOME/config.json`)
5. **Built-in default**: none at the moment

`localcloud config` shows the effective values and where the relay came from.

The background daemon is started with the settings that were in effect at that moment. If a later
`localcloud start` / `url` resolves a different relay, token or transport, or the daemon hit a
fatal error such as a rejected token, the daemon is restarted with the new settings. Its existing
tunnels are dropped and their URLs change.

## Project file: `localcloud.json`

```json
{
  "relay": "https://tunnel.example.com"
}
```

- `npx localcloud-cli init --relay https://tunnel.example.com` writes it for you.
- Commit it. Agents running in that repo then need no configuration and no prompting.
- It may also contain `"transport": "http"` if you know WebSockets never work in your environment.
- It *may* contain `"token"`, but anything committed is readable by everyone who can read the
  repo. For a private relay token, prefer the environment's secrets (`LOCALCLOUD_TOKEN`).

## User file: `~/.localcloud/config.json`

Managed with `localcloud config`:

```sh
localcloud config set relay https://tunnel.example.com
localcloud config set token s3cret
localcloud config unset token
```

This is useful on your own machine, or in a long-lived VM where you don't want to touch the repo.

## Environment variables

| Variable | Purpose |
|---|---|
| `LOCALCLOUD_RELAY`, `LOCALCLOUD_TOKEN`, `LOCALCLOUD_TRANSPORT` | See [Settings](#settings). |
| `LOCALCLOUD_HOME` | Directory for the user config, daemon socket, log, state and `identity` file (default `~/.localcloud`). Each home has its own daemon. The `identity` file (mode 0600) holds a per-machine secret that lets a restarted CLI or daemon reclaim its tunnel names immediately — don't share it. |
| `LOCALCLOUD_IGNORE_PORTS` | Ports that watch mode never shares, e.g. `8081,9000`. |
| `LOCALCLOUD_DEBUG` | Print stack traces on errors. |
| `NO_COLOR` | Disable ANSI colors. |

Most agent platforms let you set environment variables (or secrets) per environment. That's a good
place for `LOCALCLOUD_RELAY` and `LOCALCLOUD_TOKEN` if you don't want them in the repo.

## Proxy and certificates

You normally configure nothing here, because localcloud reads what the sandbox already provides.

| Variable | |
|---|---|
| `HTTPS_PROXY` / `https_proxy` | Proxy for `https://` and `wss://` relays. |
| `HTTP_PROXY` / `http_proxy` | Proxy for `http://` relays. |
| `ALL_PROXY` / `all_proxy` | Fallback for both. |
| `NO_PROXY` / `no_proxy` | Bypass list: `host`, `.suffix`, `*.suffix`, `host:port`, `10.0.0.0/8`, `[::1]`, `*`. |
| `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO` | PEM bundles to trust **in addition to** Node's built-in roots and the system bundle. |

Proxy URLs may include credentials (`http://user:pass@proxy:3128`), which are sent as
`Proxy-Authorization: Basic`. Both `http://` and `https://` proxies are supported.

## Watch-mode tuning

Watch mode (`localcloud start` with no port, `run`, MCP `auto_share`) shares a port when it starts
listening on a loopback or wildcard address, is ≥ 1024, and isn't a known database/debugger port.
The rules are in [how-it-works.md](how-it-works.md#port-detection). To keep a port private, add it
to `LOCALCLOUD_IGNORE_PORTS`, or skip watch mode and list ports explicitly with
`localcloud start <port>`.

## Per-tunnel options

These are given per `share`/`start`/`url` call. They aren't read from config files.

| Option | |
|---|---|
| `--name <name>` | Request a specific subdomain. Normalized to `[a-z0-9-]`, at most 48 chars, and some names are reserved. |
| `--protect` | Private link with an access key. |
| `--auth <user:pass>` | HTTP basic auth at the relay. |
| `--host-header rewrite\|preserve\|<host>` | What `Host` the local server sees (default `rewrite` → `localhost:<port>`). |

## Relay configuration

The relay is configured by flags or environment variables. The complete list is in
[cli.md → `localcloud relay`](cli.md#localcloud-relay), and deployment guides are in
[self-hosting.md](self-hosting.md). The most important variables:

| Env | |
|---|---|
| `LOCALCLOUD_DOMAIN` | Wildcard domain → `https://<id>.<domain>` URLs. Leave it unset for single-domain cookie routing. |
| `LOCALCLOUD_RELAY_TOKEN` | Require clients to send this token. |
| `LOCALCLOUD_PUBLIC_URL` | Public base URL (cookie routing behind a proxy). |
| `PORT`, `HOST` | Listen address (default `0.0.0.0:8080`). |

## Recipes

**One relay for the whole team, zero setup for agents**

```sh
npx localcloud-cli init --relay https://tunnel.example.com
git add localcloud.json AGENTS.md CLAUDE.md .claude/settings.json
git commit -m "Share dev servers with localcloud"
```

Then add `tunnel.example.com` to each agent environment's network allowlist.

**Token-protected relay, token kept out of git**

- Relay: `LOCALCLOUD_RELAY_TOKEN=…`
- Repo: `localcloud.json` with just the relay URL
- Agent environment secrets: `LOCALCLOUD_TOKEN=…`

**WebSockets never work behind your proxy**

`{"relay": "https://tunnel.example.com", "transport": "http"}` skips the 7-second WebSocket
attempt on every new connection. (`auto` mode only tries it once per process anyway.)

**Several isolated daemons on one machine**

`LOCALCLOUD_HOME=/tmp/lc-a localcloud start 3000` and `LOCALCLOUD_HOME=/tmp/lc-b localcloud start 4000`
each get their own daemon, socket and log.
