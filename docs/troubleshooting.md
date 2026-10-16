# Troubleshooting

**Start with `npx localcloud-cli doctor`.** It checks the relay setting, the proxy, the CA bundle,
relay reachability, both transports and the daemon, and usually names the problem. For anything in
the background, `npx localcloud-cli logs` shows the daemon's log.

- [No relay configured](#localcloud-needs-a-relay-to-connect-to)
- [Proxy 403 / blocked by the network policy](#proxy-403--blocked-by-the-network-policy)
- [TLS / certificate errors](#tls--certificate-errors)
- [WebSocket blocked → long-poll](#websocket-blocked--long-poll)
- [Relay token errors](#relay-token-errors)
- ["Blocked request. This host is not allowed" (Vite) and other host errors](#blocked-request-this-host-is-not-allowed-vite-and-other-host-errors)
- [HMR / hot reload doesn't connect](#hmr--hot-reload-doesnt-connect)
- [The page says "Nothing is answering on port N yet"](#the-page-says-nothing-is-answering-on-port-n-yet)
- [Ports aren't auto-detected](#ports-arent-auto-detected)
- [IPv6 / server bound to a specific address](#ipv6--server-bound-to-a-specific-address)
- [`the name "x" is already taken`](#the-name-x-is-already-taken)
- [The URL changed](#the-url-changed)
- [Redirects go to localhost, or absolute links are wrong](#redirects-go-to-localhost-or-absolute-links-are-wrong)
- [Cookie-routing relays: wrong app, or the relay landing page shows up](#cookie-routing-relays-wrong-app-or-the-relay-landing-page-shows-up)
- [Daemon problems](#daemon-problems)
- [Still stuck?](#still-stuck)

## "localcloud needs a relay to connect to"

There's no built-in public relay, so tell localcloud which one to use:

```sh
npx localcloud-cli 3000 --relay https://tunnel.example.com         # once
export LOCALCLOUD_RELAY=https://tunnel.example.com                 # per shell/environment
npx localcloud-cli init --relay https://tunnel.example.com         # per repo (commit localcloud.json)
npx localcloud-cli config set relay https://tunnel.example.com     # per machine
```

If you don't have a relay yet, see [self-hosting.md](self-hosting.md).

## Proxy 403 / blocked by the network policy

```text
✖ proxy refused CONNECT to tunnel.example.com:443: HTTP 403 (blocked by the network policy?)
```

The sandbox's egress proxy refused the connection to your relay. **Add the relay's hostname to the
environment's allowlist.** Only the client → relay connection needs to be allowed, because visitors'
browsers talk to the relay directly. Allow the exact relay host you configured (e.g.
`tunnel.example.com`). Adding `*.tunnel.example.com` is harmless but not required for the client.

`npx` itself also needs the npm registry (`registry.npmjs.org`). Most platforms allow it by
default. If yours doesn't, allow it, or install localcloud during setup (`npm i -g localcloud-cli`).

Where to change it (menus change often, so check the [agent guides](agents/README.md)):

| Platform | Where |
|---|---|
| Claude Code on the web | Environment settings → **Network access**: choose a level that allows custom domains and add the relay host. See [agents/claude-code.md](agents/claude-code.md). |
| OpenAI Codex (cloud) | Environment settings → **Agent internet access**: turn it on, add the relay host to the domain allowlist, and allow **all HTTP methods** (or at least `POST`). The long-poll transport uses `POST`. See [agents/codex.md](agents/codex.md). |
| Cursor background agents | `.cursor/environment.json` `egressAllowlist` (or the team/user network settings). `localcloud init --setup --relay …` adds it. See [agents/cursor.md](agents/cursor.md). |
| Devin | Usually unrestricted. If your org restricts egress, allow the relay host there. See [agents/devin.md](agents/devin.md). |
| GitHub Copilot coding agent | Repository settings → Copilot → coding agent → firewall **custom allowlist**. |
| Corporate proxy / CI | Ask whoever runs the proxy to allow `CONNECT` to the relay host on port 443. |

A `407` means the proxy wants credentials. Put them in the proxy URL:
`HTTPS_PROXY=http://user:pass@proxy:3128`.

If the relay should **not** go through the proxy (for example a relay on the same private network),
add it to `NO_PROXY`.

## TLS / certificate errors

`self signed certificate in certificate chain`, `unable to get local issuer certificate`, or
`UNABLE_TO_VERIFY_LEAF_SIGNATURE` mean that a TLS-intercepting proxy is re-signing traffic with a
CA Node doesn't know about. localcloud automatically trusts `NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`,
`REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO` and the system bundle. If doctor says
`using Node.js default CAs`, none of these exist. Point one of them at the proxy's CA:

```sh
export NODE_EXTRA_CA_CERTS=/path/to/proxy-ca.pem
npx localcloud-cli doctor
```

Never work around this by disabling TLS verification.

If the error mentions the **relay's own** certificate (for example an expired one, or a wildcard
that doesn't cover the name), fix the relay's TLS setup. See [self-hosting.md](self-hosting.md).

## WebSocket blocked → long-poll

```text
  • websocket transport unavailable: websocket upgrade rejected: HTTP 403 — localcloud will use long-polling
  ✓ https long-poll transport works (fallback)
```

This is fine. Many proxies refuse WebSocket upgrades, and localcloud falls back to HTTPS
long-polling automatically. Everything works over long-polling, including your app's own WebSockets
and HMR, with somewhat higher latency. The banner says `via https long-poll`.

To skip the WebSocket attempt entirely, set `--transport http` or `"transport": "http"` in
`localcloud.json`. If **both** transports fail, the relay is unreachable. See the sections above.

If `--transport ws` hangs with `relay did not answer the handshake`, the proxy "accepted" the
upgrade but isn't passing frames. `auto` mode detects this and switches to long-polling.

**Method-restricted egress (e.g. Codex "GET/HEAD/OPTIONS only").** The long-poll fallback sends
`POST` requests, so it can't work when the sandbox only allows read-only HTTP methods. WebSocket
upgrades are `GET` requests and may still pass. Allow all HTTP methods for the relay domain if your
platform offers that setting.

## Relay token errors

```text
✖ this relay requires a valid LOCALCLOUD_TOKEN
```

Set the token: `--token`, `LOCALCLOUD_TOKEN`, or `localcloud config set token …`. This error is
fatal and isn't retried. The next `localcloud start` notices the failed daemon (or the changed
token) and restarts it automatically.

`protocol mismatch (client vX, relay vY)` means the client and relay are too far apart in version.
Update both.

## "Blocked request. This host is not allowed" (Vite) and other host errors

These errors include Vite's `allowedHosts` error, webpack-dev-server's `Invalid Host header`,
Angular's host check, and Next.js cross-origin dev warnings or Server Actions origin errors.

By default localcloud rewrites `Host` to `localhost:<port>` and maps `Origin`/`Referer` back to the
local origin, so these checks pass **without** config changes. If you still see them:

- Make sure you aren't passing `--host-header preserve` or a custom host.
- Remove workarounds you may have added earlier, such as `server.hmr.host`, a hard-coded
  `allowedHosts` that excludes `localhost`, or `--host 0.0.0.0` together with a public-host check.
  None of them are needed.
- If your app needs to know its public URL (OAuth callbacks, absolute links), read the
  `X-Localcloud-Url` request header (e.g. `https://sunny-otter-x7k2.tunnel.example.com`) and
  `X-Forwarded-Proto`. Use `--host-header preserve` only if the app must see the public `Host`.

## HMR / hot reload doesn't connect

The tunnel forwards WebSocket upgrades, so HMR works when the browser connects back to **the page's
own origin**, which is every major dev server's default. Problems come from overrides:

- **Vite:** remove `server.hmr.clientPort`, `server.hmr.host` and `server.hmr.protocol`, or set
  `clientPort: 443` if you must keep the others.
- **webpack-dev-server / CRA:** remove `WDS_SOCKET_HOST` / `WDS_SOCKET_PORT`, or set
  `client.webSocketURL: 'auto://0.0.0.0:0/ws'`.
- **Next.js:** works out of the box (`/_next/webpack-hmr`).
- On a **protected** tunnel the WebSocket needs the access cookie. Open the link with the key once
  and HMR connects normally.
- With the long-poll transport, HMR works but updates arrive a little slower.

The browser devtools console usually shows which URL the HMR client is trying.

## The page says "Nothing is answering on port N yet"

The tunnel is up, but nothing accepted the connection on that port:

- The server hasn't finished booting. The page reloads by itself when it does.
- The server is on a different port. Check its output, then run `localcloud start <right port>`.
- The server is bound to a specific non-loopback interface. See [IPv6 / bound address](#ipv6--server-bound-to-a-specific-address).
- The server crashed. Check its logs.

"This tunnel is reconnecting" is different. It means the localcloud **client** is offline (the
sandbox is asleep, or the network dropped). It also reloads by itself once the client is back.

## Ports aren't auto-detected

Watch mode (`localcloud start` without a port, `run`, MCP `auto_share`) skips a port when:

- it's **below 1024**,
- it's a database/debugger port: 5432, 3306, 6379, 27017, 9229, 9222, 11211, 2375, 2376 or 5037,
- it's listed in `LOCALCLOUD_IGNORE_PORTS`,
- it's bound to one specific non-loopback IP (only `0.0.0.0`, `::`, `127.0.0.1` and `::1` count),
- it was **already listening when watching started** and isn't a common dev port (3000, 5173, 8080, …;
  the full list is in [how-it-works.md](how-it-works.md#port-detection)), or
- the platform isn't Linux or macOS (`watchSupported: false` in `localcloud ls --json`). On macOS
  detection needs `lsof`.

In all of these cases, share explicitly: `npx -y localcloud-cli start <port>`.

## IPv6 / server bound to a specific address

localcloud connects to `127.0.0.1` first and then `::1`, and remembers which one works. That covers
servers that only listen on `localhost` resolved to IPv6, which recent Node versions do. If your
server listens only on a specific address, such as a container or LAN IP, give the full target:

```sh
localcloud http://172.17.0.3:3000
```

## `the name "x" is already taken`

Someone else holds that name on the relay, **or** an earlier localcloud process of yours exited
without closing it (it crashed, was `kill -9`ed, or the sandbox was torn down). The relay then
reserves the name for up to **1 hour** so its owner can reconnect, and a new process has a new
secret, so it can't reclaim the name. Pick another name, wait, or restart the relay if it's yours.
A clean `localcloud stop` or Ctrl+C releases the name immediately.

## The URL changed

URLs survive reconnects within the same client process. They change when:

- the client process restarted without `--name` (for example a new sandbox, or a restarted daemon),
- the relay restarted and someone else took the name first, or
- for protected links: the relay restarted, which generates a new access key.

Use `--name` for a stable, memorable URL, and `localcloud url <port>` to look up the current one.

## Redirects go to localhost, or absolute links are wrong

`Location`, `Content-Location` and `Access-Control-Allow-Origin` headers that point at the local
origin are rewritten automatically. URLs **inside HTML or JSON bodies** aren't rewritten. If your
app builds absolute URLs from configuration (`APP_URL`, `NEXTAUTH_URL`, `SITE_URL`…), set that to the
public URL, or derive it from `X-Localcloud-Url` per request.

## Cookie-routing relays: wrong app, or the relay landing page shows up

Relays without a wildcard domain route by cookie: the tunnel link
(`…/__localcloud/t/<id>`) sets a cookie, and then `/` serves that tunnel. A browser can therefore
view **one tunnel per relay at a time**. Opening another tunnel's link switches it. To get back to
the relay's landing page, visit `/__localcloud/exit`. For several tunnels side by side, run the relay
with a wildcard domain ([self-hosting.md](self-hosting.md)).

## Daemon problems

```sh
npx localcloud-cli ls          # is it running? connected? which transport?
npx localcloud-cli logs -f     # live log (~/.localcloud/daemon.log)
npx localcloud-cli stop        # shut it down; the next `start` starts a fresh one
```

- `the localcloud daemon didn't start — see …/daemon.log`: read that log. Common causes are an
  unwritable `$HOME` (set `LOCALCLOUD_HOME` to a writable directory) and a missing Node.js
  binary on `PATH`.
- `start` keeps restarting the daemon: each `start` that resolves a different relay, token or
  transport restarts it. Make sure every caller (your shell, the SessionStart hook, the MCP server)
  sees the same settings. Usually that means committing `localcloud.json` instead of passing
  `--relay` in only some places.
- The daemon is tied to the sandbox. When the sandbox is suspended or destroyed, so is the tunnel.
- Set `LOCALCLOUD_DEBUG=1` to see stack traces from the CLI.

## Still stuck?

Open an issue using the [bug report template](https://github.com/rayhankhilji/localcloud/issues/new/choose).
Include the output of `npx localcloud-cli doctor`, your agent platform, and `localcloud logs` if
the daemon is involved. Remove tokens and private hostnames first.
