# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - 2026-10-16

Initial release.

### Added

- **Sharing.** `localcloud <port|url>...` shares local servers in the foreground at public HTTPS
  URLs, with a live request log. Targets can be ports, `host:port` or URLs, including local HTTPS
  servers.
- **Background mode.** `localcloud start [port...]` hands tunnels to a detached daemon and returns
  immediately with the URL. `url`, `ls`, `stop` and `logs [-f]` manage it over a local Unix socket
  (named pipe on Windows).
- **Automatic port detection.** `localcloud start` with no port (or `--watch`) shares every dev
  server that starts listening (Linux and macOS), skipping well-known database and debugger ports.
  `LOCALCLOUD_IGNORE_PORTS` excludes more.
- **`localcloud run -- <command>`** runs a dev server and shares whatever port it opens.
- **Egress-proxy support.** Honors `HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY` and `NO_PROXY` via
  `CONNECT` with proxy auth, and trusts extra CAs from `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
  `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO` and system bundles.
- **Two transports.** WebSocket, with automatic fallback to HTTPS long-polling when upgrades are
  blocked or frames don't flow. `--transport auto|ws|http`.
- **Per-stream flow control** (2 MiB window) in both directions.
- **Header rewriting.** `Host`, `Origin` and `Referer` are rewritten to the local origin by default,
  so Vite, webpack-dev-server, Angular and Next.js host and origin checks pass with no config.
  Redirect and CORS headers and cookie domains are mapped back to the public origin.
  `--host-header rewrite|preserve|<host>`.
- **WebSocket / HMR passthrough** over both transports.
- **Stable URLs** across reconnects, with a 1-hour name reservation and an 8-second request grace
  period while a client reconnects. `--name` picks a subdomain.
- **Private links.** `--protect` (access key → `HttpOnly` cookie) and `--auth user:pass` (HTTP
  basic auth at the relay).
- **Self-refreshing waiting pages** for "nothing listening yet", "reconnecting", "not found" and
  "private".
- **`localcloud doctor`** checks the relay, proxy, CA, both transports and the daemon.
- **`localcloud init`** writes `AGENTS.md`/`CLAUDE.md` instructions, a Claude Code SessionStart hook
  and `localcloud.json`. It detects Cursor, Copilot, Windsurf, Cline, Gemini CLI and Replit rules
  files. `--mcp` registers the MCP server, and `--setup` wires Cursor and Copilot environment files.
- **`localcloud mcp`**: a stdio MCP server with `share_port`, `get_url`, `list_shared`,
  `stop_sharing` and `auto_share` tools and a `localcloud://status` resource.
- **`localcloud relay`**: a self-hostable relay with subdomain or cookie routing, an optional client
  token, optional built-in TLS, per-IP and global limits, and a `/__localcloud/ask` endpoint for
  Caddy on-demand TLS.
- **`localcloud config`** for user-level settings, and project-level `localcloud.json`.
- `--json` output for scripting and agents.
- Docs: [how it works](docs/how-it-works.md), [wire protocol](docs/protocol.md),
  [CLI reference](docs/cli.md), [configuration](docs/configuration.md),
  [troubleshooting](docs/troubleshooting.md), [security](docs/security.md).

[Unreleased]: https://github.com/rayhankhilji/localcloud/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/rayhankhilji/localcloud/releases/tag/v0.1.0
