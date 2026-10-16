# CLI reference

```text
localcloud <command> [options]
npx localcloud-cli <command> [options]     # no install needed
```

The npm package is `localcloud-cli` and the binary is `localcloud`. It needs Node.js 18.18 or newer.
In agent instructions use `npx -y localcloud-cli …`, because `-y` skips npx's install prompt.

- [Commands](#commands): [share](#localcloud-porturl-share) · [start](#localcloud-start) ·
  [url](#localcloud-url) · [ls](#localcloud-ls) · [stop](#localcloud-stop) · [run](#localcloud-run) ·
  [logs](#localcloud-logs) · [doctor](#localcloud-doctor) · [init](#localcloud-init) ·
  [mcp](#localcloud-mcp) · [relay](#localcloud-relay) · [config](#localcloud-config)
- [Global options](#global-options)
- [Targets](#targets)
- [Environment variables](#environment-variables)
- [Configuration precedence](#configuration-precedence)
- [Exit codes](#exit-codes)
- [JSON output](#json-output)
- [Files](#files)

## Commands

| Command | Aliases | Needs a relay | Uses the daemon |
|---|---|:-:|:-:|
| `localcloud <target>...` | `share` | ✓ | |
| `localcloud start [target...]` | `up` | ✓ | ✓ |
| `localcloud url <target>` | | ✓ | ✓ |
| `localcloud ls` | `list`, `status` | | ✓ |
| `localcloud stop [target...]` | `down` | | ✓ |
| `localcloud run -- <command>` | | ✓ | |
| `localcloud logs [-f]` | | | ✓ |
| `localcloud doctor` | | ✓ | |
| `localcloud init` | | | |
| `localcloud mcp` | | ✓ (for sharing) | ✓ |
| `localcloud relay` | | | |
| `localcloud config` | | | |
| `localcloud help`, `-h`, `--help` | | | |
| `localcloud -v`, `--version` | | | |

If the first word isn't a known command, it is treated as a target, so `localcloud 3000` means
`localcloud share 3000`. `localcloud -- npm run dev` (no command, only `--`) means `localcloud run -- npm run dev`.
Running `localcloud` with no arguments prints help.

### `localcloud <port|url>...` (share)

Shares one or more targets **in the foreground** and streams a log line for every request. Ctrl+C
(or SIGTERM) closes the tunnels and releases their names.

```sh
localcloud 3000
localcloud 3000 8080                  # several at once
localcloud https://localhost:8443     # local HTTPS server
localcloud 5173 --name my-app --protect
```

Output:

```text
  ☁  localcloud  · via websocket

  ➜  Public   https://sunny-otter-x7k2.relay.example.com
  ➜  Local    http://localhost:5173

  Requests will show up below. Ctrl+C to stop.

  14:34:03  GET    200    12ms  /
  14:34:04  GET    WS      3ms  /?token=Hh8sRZ1m
```

For a protected tunnel the Public line shows the URL with its access key, followed by
`Private: the link carries an access key — share it only with people you trust`. If nothing is
listening on the port yet, you'll see
`⚠ nothing is listening on port N yet — visitors will see a waiting page until your server starts.`

While running it reports connection problems on stderr (`… can't reach <relay> yet: … (retrying)`,
`⚠ connection lost — reconnecting (your URL stays the same)…`, `✓ reconnected`). If the relay hands
out a different URL after a reconnect, it prints `URL changed: <url>`.

| Option | |
|---|---|
| `--name <name>` / `-n` | Request a specific tunnel name. Only allowed with a single target. |
| `--protect` | Private link (see [security](security.md#protected-links---protect)). |
| `--auth <user:pass>` | HTTP basic auth checked by the relay. |
| `--host-header <mode>` | `rewrite` (default), `preserve`, or a literal host. See [header rewriting](how-it-works.md#header-rewriting). |
| `--quiet` / `-q` | Don't print request lines. |
| `--json` | Print one JSON line once the tunnels are up, then nothing else. |

The foreground client retries an unreachable relay forever. It only exits by itself on a fatal
handshake error, such as a wrong token or a protocol mismatch (exit 1).

### `localcloud start`

Shares targets **in the background** and exits as soon as the URLs exist. This is the command
agents should use.

```sh
localcloud start 3000                 # → http://localhost:3000 → https://…
localcloud start 3000 5173 --protect
localcloud start                      # no target: turn on auto-sharing (watch mode)
localcloud start 3000 --watch         # share 3000 *and* turn on auto-sharing
localcloud start --no-watch           # just make sure the daemon is running
```

- It starts the [daemon](how-it-works.md#background-mode-the-daemon) if needed. If a daemon is
  already running with a **different relay, token, transport or localcloud version**, or it stopped
  after a fatal error, it is restarted, which drops its existing tunnels. The CLI prints
  `(restarted the background daemon with the new settings)`.
- Each target is shared through the daemon. The daemon waits up to 25 s for the relay. A target that
  fails is reported as `✖ <target>: <reason>` and doesn't affect the others.
- **Watch mode** auto-shares new listening ports as described in
  [port detection](how-it-works.md#port-detection). It is enabled when no target is given (unless
  `--no-watch`) or with `--watch`. Once on, it stays on until the daemon stops. It needs Linux or
  macOS.
- Sharing a target that is already shared and online returns the existing URL. Passing a different
  `--name` or `--protect` re-registers it.

Options: `--name`, `--protect`, `--auth`, `--host-header`, `--watch`, `--no-watch`, `--json`,
plus the [global options](#global-options).

Exit status is `1` only if **every** requested target failed and watch mode is off.

### `localcloud url`

```sh
localcloud url 3000           # https://sunny-otter-x7k2.relay.example.com
localcloud url 3000 --json
```

Prints **only** the public URL for one target, sharing it through the daemon first if needed. For a
protected tunnel it prints the access URL. Takes the same sharing options as `start`. This is the
easiest command to use in scripts: `URL=$(npx -y localcloud-cli url 3000)`.

### `localcloud ls`

Lists the daemon's tunnels and connection state.

```text
☁  localcloud  https://relay.example.com  connected via websocket  · auto-sharing new dev servers
http://localhost:3000 → https://sunny-otter-x7k2.relay.example.com
http://localhost:5173 → https://my-app.relay.example.com  (reconnecting)
```

If no daemon is running it says so: `Nothing is shared. Start with localcloud start <port> …`.

### `localcloud stop`

```sh
localcloud stop 3000      # stop sharing one target (the daemon keeps running)
localcloud stop           # stop everything and shut the daemon down
```

Stopping a tunnel releases its name on the relay immediately. Stopping a target that isn't shared
prints `✖ nothing is shared for 3000` and exits 1. If no daemon is running it prints
`localcloud is not running.` and exits 0.

### `localcloud run`

```sh
localcloud run -- npm run dev
localcloud run --name my-app -- pnpm dev --port 4000
```

Runs the command with inherited stdio and shares **every port that starts listening after
localcloud starts**, whichever process opened it. The localcloud banner goes to stderr. `--name`
applies to the first detected port only. Signals (SIGINT/SIGTERM) are forwarded to the child. When
the child exits, localcloud closes the tunnels and exits with the child's code. If the command
can't be started, it exits 127.

`run` works in the foreground and doesn't use the daemon. It needs automatic port detection (Linux
or macOS). On other platforms run the server yourself and use `localcloud <port>`. With `--json`,
one tunnel object per detected port is written to stdout, interleaved with the child's output.

### `localcloud logs`

Prints the last 60 lines of the daemon log (`~/.localcloud/daemon.log`). `-f` / `--follow` keeps
streaming new lines. The log records connections, transport fallbacks, tunnel URLs, detected
ports, and failed requests.

### `localcloud doctor`

Checks everything between the sandbox and the relay, step by step:

```text
☁  localcloud doctor

  • node v22.22.0 on linux, localcloud 0.1.0
  • relay https://relay.example.com (from /work/app/localcloud.json)
  • egress proxy 127.0.0.1:3128 (from HTTPS_PROXY)
  • extra CA certificates loaded (TLS-intercepting proxies are fine)
  ✓ relay reachable in 84ms (relay v0.1.0, subdomain routing)
  ✓ websocket transport works (fastest)
  ✓ https long-poll transport works (fallback)
  • background daemon running (pid 4242), 2 tunnel(s)
```

It fails (exit 1) when no relay is configured or `GET /__localcloud/health` doesn't return a
localcloud health document. A WebSocket failure is only informational, because long-polling will be
used instead. Please paste the doctor output into bug reports.

### `localcloud init`

Teaches every coding agent that works on the repo to use localcloud. It only writes files and never
contacts the relay. It is idempotent: content goes between `<!-- localcloud:start -->` /
`<!-- localcloud:end -->` markers or into keyed JSON/TOML entries, so running it again updates in
place and leaves your own content alone.

```sh
npx localcloud-cli init --relay https://relay.example.com
npx localcloud-cli init --mcp --setup
npx localcloud-cli init --agents cursor,copilot --dry-run
```

Always written:

| File | What |
|---|---|
| `AGENTS.md` | A "Previewing dev servers (localcloud)" block. Read by Codex, Cursor, Copilot, Jules, Devin, Gemini and others. |
| `CLAUDE.md` | Created as `@AGENTS.md`, left alone if it already imports `AGENTS.md`, otherwise the block is appended. |
| `.claude/settings.json` | A `SessionStart` hook (matcher `startup\|resume`) running `if [ "$CLAUDE_CODE_REMOTE" = "true" ]; then npx -y localcloud-cli start \|\| true; fi`. |
| `localcloud.json` | Only with `--relay`: `{"relay": "<normalized url>"}`. |

When a tool is already configured in the repo (or you pass `--agents`/`--all`), init also writes
its rules file. These are Claude Code skill (`.claude/skills/localcloud/SKILL.md`), Cursor
(`.cursor/rules/localcloud.mdc`), Copilot (`.github/copilot-instructions.md`), Windsurf/Devin
Desktop, Cline, Gemini CLI (`GEMINI.md`) and Replit (`replit.md`). With `--mcp` it also registers
the MCP server for each tool that reads a repo-level config: `.mcp.json`, `.cursor/mcp.json`,
`.gemini/settings.json`, `.codex/config.toml` and `.vscode/mcp.json`.

| Option | |
|---|---|
| `--relay <url>` | Save the relay to `localcloud.json`. Its hostname is also used for `egressAllowlist` with `--setup`. |
| `--dir <path>` | Repo to configure (default: the current directory). |
| `--agents <list>` | Comma-separated targets: `agents, claude, skill, cursor, copilot, windsurf, cline, gemini, codex, vscode, replit, all` (aliases: `claude-code`, `github`, `devin`, `openai`, `vs-code`, …). |
| `--all` | Configure every known tool. |
| `--no-detect` | Don't auto-detect tools; only defaults plus `--agents`. |
| `--no-claude` | Skip `CLAUDE.md` and the Claude Code hook. |
| `--no-hook` | Skip only the Claude Code SessionStart hook. |
| `--skill` | Also write the Claude Code skill. |
| `--mcp` | Register the MCP server for the selected tools. |
| `--setup` | Add a `localcloud start` terminal (and the relay host in `egressAllowlist`) to an **existing** `.cursor/environment.json`, and create `.github/workflows/copilot-setup-steps.yml` if none exists. |
| `--dry-run` | Show what would change without writing anything. |
| `--json` | Print the result object (see [JSON output](#json-output)). |

### `localcloud mcp`

Runs a stdio [MCP](https://modelcontextprotocol.io) server that uses newline-delimited JSON-RPC 2.0
on stdin/stdout. Sharing goes through the same background daemon as `start`, so tunnels outlive the
MCP session.

| Tool | Arguments | Does |
|---|---|---|
| `share_port` | `port` (required), `name?`, `protect?` | Shares a port and returns its URL. Idempotent. |
| `get_url` | `port` | Looks up the URL of an already shared port. |
| `list_shared` | none | Lists shared ports, URLs and the connection state. |
| `stop_sharing` | `port` | Stops sharing a port. |
| `auto_share` | `enabled?` (default `true`) | Turns watch mode on or off. |

It also exposes a `localcloud://status` resource (JSON). Example config:

```json
{
  "mcpServers": {
    "localcloud": {
      "command": "npx",
      "args": ["-y", "localcloud-cli", "mcp"],
      "env": { "LOCALCLOUD_RELAY": "https://relay.example.com" }
    }
  }
}
```

`--relay` and `--token` passed to `localcloud mcp` apply to all tool calls.

### `localcloud relay`

Runs a relay server. See [self-hosting](self-hosting.md) for deployment guides.

```sh
localcloud relay --domain tunnel.example.com --port 8080
localcloud relay --http --domain localtest.me:8080      # local development, http:// URLs
```

| Option | Env | Default | |
|---|---|---|---|
| `--port <n>` / `-p` | `PORT` | `8080` | Listen port. |
| `--host <addr>` | `HOST` | `0.0.0.0` | Listen address. |
| `--domain <domain>` | `LOCALCLOUD_DOMAIN` | none | Wildcard domain for `https://<id>.<domain>` URLs. May include a port. A leading `*.` is stripped. |
| `--routing <mode>` | `LOCALCLOUD_ROUTING` | `auto` | `subdomain` (needs a domain), `cookie`, or `auto` (subdomain if a domain is set, otherwise cookie). |
| `--public-url <url>` | `LOCALCLOUD_PUBLIC_URL` | from request | Base URL for cookie-routing tunnel URLs, instead of the request's `Host`. |
| `--token <secret>` | `LOCALCLOUD_RELAY_TOKEN` | none | Require clients to present this token. |
| `--insecure`, `--http` | `LOCALCLOUD_INSECURE=1` | off | Subdomain tunnel URLs use `http://`. |
| `--tls-cert <file>`, `--tls-key <file>` | `LOCALCLOUD_TLS_CERT`, `LOCALCLOUD_TLS_KEY` | none | Terminate TLS in the relay itself. |
| | `LOCALCLOUD_MAX_SESSIONS_PER_IP` | `200` | Concurrent client connections per IP. |
| | `LOCALCLOUD_MAX_TUNNELS` | `10000` | Tunnels on the whole relay, reserved ones included. |
| | `LOCALCLOUD_MAX_HEADER_SIZE` | `32768` | Max request header bytes. |

On `relay`, `--token` sets the **relay's** required token. That is a different meaning from
`--token` on the client commands. Startup output:

```text
☁  localcloud relay 0.1.0 listening on 0.0.0.0:8080
  routing: subdomain (*.tunnel.example.com)
  clients: token required
```

The relay logs one line per event to stdout and shuts down cleanly on SIGINT/SIGTERM.

### `localcloud config`

```sh
localcloud config                          # show the effective settings and where they come from
localcloud config --json
localcloud config set relay https://relay.example.com
localcloud config set token s3cret
localcloud config set transport http
localcloud config unset token
```

`set` and `unset` edit the **user** config file (`~/.localcloud/config.json`). Only the keys
`relay`, `token` and `transport` can be set. Relay values are normalized: `https://` is added if no
scheme is given, and trailing slashes are removed. `config` shows the token only as `(set)`.

```text
relay          https://relay.example.com
relaySource    /home/me/app/localcloud.json
token          —
transport      auto
userConfig     /home/me/.localcloud/config.json
projectConfig  /home/me/app/localcloud.json
```

## Global options

| Option | Env | |
|---|---|---|
| `--relay <url>` | `LOCALCLOUD_RELAY` | Relay base URL. A bare host gets `https://`. |
| `--token <token>` | `LOCALCLOUD_TOKEN` | Token for relays started with `LOCALCLOUD_RELAY_TOKEN`. |
| `--transport <mode>` | `LOCALCLOUD_TRANSPORT` | `auto` (WebSocket, falling back to long-poll), `ws`, or `http` (long-poll only). |
| `--json` | | Machine-readable output. |
| `-h`, `--help` | | Help. |
| `-v`, `--version` | | Print the version. |

Option syntax: `--key value`, `--key=value`, short aliases (`-n` name, `-p` port, `-q` quiet,
`-f` follow, `-h`, `-v`). Boolean flags accept `--flag=false`. Everything after `--` is passed
through untouched (used by `run`).

## Targets

| Form | Meaning |
|---|---|
| `3000`, `:3000` | `http://localhost:3000`. localcloud tries `127.0.0.1`, then `::1`. |
| `localhost:3000`, `127.0.0.1:3000`, `[::1]:3000`, `0.0.0.0:3000` | Same as `3000`. |
| `http://localhost:3000` | Same as `3000`. |
| `https://localhost:8443` | Local HTTPS server. Its certificate is **not** verified, so self-signed is fine. |
| `192.168.1.20:8080`, `http://my-container:80` | Any host the machine can reach. The Host header is rewritten to that host. |

## Environment variables

**Client**

| Variable | |
|---|---|
| `LOCALCLOUD_RELAY` | Relay URL. |
| `LOCALCLOUD_TOKEN` | Relay token. |
| `LOCALCLOUD_TRANSPORT` | `auto` / `ws` / `http`. |
| `LOCALCLOUD_HOME` | State directory (default `~/.localcloud`). |
| `LOCALCLOUD_IGNORE_PORTS` | Comma/space separated ports that watch mode must never share. |
| `LOCALCLOUD_DEBUG` | Print stack traces for errors. |
| `HTTPS_PROXY`, `https_proxy`, `HTTP_PROXY`, `http_proxy`, `ALL_PROXY`, `all_proxy` | Egress proxy (`http://[user:pass@]host:port` or `https://…`). |
| `NO_PROXY`, `no_proxy` | Hosts that bypass the proxy. |
| `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO` | Extra CA bundles to trust, added to Node's roots and the system bundle. |
| `NO_COLOR`, `TERM=dumb` | Disable colors. Colors are also off when stdout isn't a TTY. |
| `CLAUDE_CODE_REMOTE` | Set by Claude Code on the web. The `init` hook only runs `start` when it is `true`. |

**Relay**: see the table under [`localcloud relay`](#localcloud-relay).

## Configuration precedence

For `relay`, `token` and `transport`, the first match wins:

1. Command-line flag (`--relay`, `--token`, `--transport`)
2. Environment variable (`LOCALCLOUD_RELAY`, `LOCALCLOUD_TOKEN`, `LOCALCLOUD_TRANSPORT`)
3. Project file: `localcloud.json` or `.localcloud.json`, in the current directory or the nearest
   parent that has one
4. User file: `~/.localcloud/config.json` (or `$LOCALCLOUD_HOME/config.json`)
5. Built-in default relay. There is none at the moment.

Details are in [configuration.md](configuration.md).

## Exit codes

| Code | When |
|---|---|
| `0` | Success, including `stop` when nothing is running. |
| `1` | Runtime error: relay unreachable when the daemon needs it, a fatal handshake error, `doctor` found a problem, `stop <target>` for something not shared, every `start` target failed, or `init` couldn't parse an agent list. |
| `2` | Usage error: unknown usage, missing port, no relay configured, `--name` with several targets, `run` without a command or on an unsupported platform. |
| `127` | `run` couldn't start the command. |
| *child's code* | `run` exits with the wrapped command's exit code (1 if it was killed by a signal). |

## JSON output

All JSON is printed as a single line on stdout.

**Tunnel object** (used everywhere):

```json
{
  "key": "3000",
  "port": 3000,
  "target": "3000",
  "id": "sunny-otter-x7k2",
  "url": "https://sunny-otter-x7k2.relay.example.com",
  "accessUrl": "https://sunny-otter-x7k2.relay.example.com/?__lc_access=…",
  "online": true,
  "name": null,
  "protect": true
}
```

`accessUrl` is present only for protected tunnels, and **it** is the link to share. `name` is the
requested `--name` (or `null`). `id` is the name the relay actually assigned.

| Command | Shape |
|---|---|
| `localcloud <target> --json` | `{"relay": "…", "transport": "ws"\|"http", "tunnels": [Tunnel…]}` |
| `start --json` | `{"relay": "…", "watch": bool, "tunnels": [Tunnel…], "errors": ["<target>: <reason>"…]}`. With no targets, `tunnels` lists every tunnel the daemon has. |
| `url --json` | `Tunnel` |
| `ls --json` (daemon running) | `{"running": true, "pid": n, "version": "0.1.0", "configId": "…", "relay": "…", "connected": bool, "transport": "ws"\|"http"\|null, "error": string\|null, "fatal": string\|null, "tunnels": [Tunnel…], "watch": bool, "watchSupported": bool}`. `fatal` is set after an unrecoverable error such as a rejected token. |
| `ls --json` (not running) | `{"running": false, "tunnels": []}` |
| `stop --json` | `{"ok": true}` (stopping everything, or when nothing was running) |
| `run --json` | One `Tunnel` per detected port. |
| `config --json` | `{"relay": string\|null, "relaySource": string\|null, "token": "(set)"\|null, "transport": "auto", "userConfig": "…", "projectConfig": string\|null}` |
| `init --json` | `{"dir", "dryRun", "relay", "agents": {id: reason}, "files": {path: "created"\|"updated"\|"unchanged"\|"skipped"}, "changes": [{file, action, note?}], "hints": [string]}` |

## Files

| Path | |
|---|---|
| `~/.localcloud/config.json` | User config (`localcloud config set`). |
| `~/.localcloud/daemon.sock` | Daemon control socket, mode `0600`. On Windows it is a named pipe `\\.\pipe\localcloud-<hash>`. |
| `~/.localcloud/daemon.log` | Daemon log (`localcloud logs`). |
| `~/.localcloud/tunnels.json` | Current tunnels, rewritten on every change and removed on shutdown. Handy for tooling. |
| `./localcloud.json` | Project config (commit it). |
