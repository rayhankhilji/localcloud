# localcloud relay on Cloudflare Workers

A protocol-compatible [localcloud](../README.md) relay that runs on **Cloudflare Workers + Durable
Objects**, so you can host your own relay on your Cloudflare account, on your own domain, with no
server to look after. The stock `localcloud` client works with it unchanged, over both of its
transports (WebSocket and HTTPS long-poll).

```text
browser ── https://<id>.example.com ──▶ Worker ──(tunnel id → session, cached)──▶ Session DO ──WebSocket / long-poll──▶ localcloud client ──▶ localhost:3000
                                          │                                        ▲
                                          └────────── Registry DO ("registry") ────┘
```

- **Worker** (`src/index.js`): stateless router. It sends `<id>.<DOMAIN>` (or cookie-routed)
  requests to the Session DO that holds the tunnel, and `/__localcloud/*` API calls to the right
  place. It caches tunnel → session lookups for 15 s per isolate.
- **Session DO** (`src/session.js`): one per client connection (a fresh `newUniqueId()` per
  `/__localcloud/ws` or `/__localcloud/http/session`). It holds the client transport and its
  tunnels, and turns browser requests into `REQ`/`DATA`/`END` streams with the same credit-based
  flow control as the Node relay (2 MiB window, `ACK`s sent only for bytes the browser actually
  pulled). The client WebSocket uses the **Hibernation API**, and tunnel state is persisted, so an
  idle session can be evicted from memory between frames.
- **Registry DO** (`src/registry.js`): a single object named `registry`. It maps tunnel id →
  session, keeps names reserved by their secret for an hour after a disconnect (so URLs survive
  reconnects), and lets requests wait up to 8 s for a reconnecting client. A session that receives
  a request for a tunnel it no longer serves (because a cache entry was stale) asks the registry
  and forwards the request itself.
- **Browser WebSockets** (`src/wsframe.js`): Workers terminate WebSockets, so a raw byte pipe isn't
  possible. The relay acts as the WebSocket *client* towards your dev server. It describes the
  upgrade in `REQ` (the localcloud client writes the actual HTTP request), parses the raw
  `101 Switching Protocols` response, then translates between browser messages and RFC 6455
  frames (masked towards the local server, as the RFC requires). The selected subprotocol, such as
  `vite-hmr`, is passed back to the browser. If the local server refuses the upgrade, its HTTP
  response is relayed as is.

The wire protocol, tunnel names and HTML pages are imported straight from `../src`, so the two
relays can't drift apart. **Deploy from inside a checkout of the localcloud repository.**

## Deploy

You need a Cloudflare account and a domain whose DNS is on Cloudflare. A dedicated domain works
best (see [Which domain?](#which-domain)).

```bash
git clone https://github.com/rayhankhilji/localcloud && cd localcloud/relay-cloudflare
npm i
npx wrangler login
```

1. **Configure `wrangler.toml`.** Replace every `example.com` with your domain: the two `routes`
   (`example.com/*` and `*.example.com/*`, with `zone_name` set to your zone) and
   `DOMAIN = "example.com"`.
2. **DNS.** In the Cloudflare dashboard, open your zone, go to DNS, and add two **proxied**
   (orange cloud) records. The Worker answers before any origin is contacted, so the target doesn't
   matter. The usual placeholder is `AAAA 100::`:

   | Type | Name | Content | Proxy |
   |---|---|---|---|
   | AAAA | `@` | `100::` | Proxied |
   | AAAA | `*` | `100::` | Proxied |

   SSL/TLS: Universal SSL covers `example.com` and `*.example.com` once the zone is active.
3. **Optional: require a token.** This stops strangers from using your relay:
   ```bash
   npx wrangler secret put RELAY_TOKEN
   ```
   Clients then pass `--token …` or set `LOCALCLOUD_TOKEN`.
4. **Deploy:**
   ```bash
   npx wrangler deploy
   ```
5. **Use it:**
   ```bash
   curl https://example.com/__localcloud/health     # {"ok":true,"service":"localcloud",...}
   npx -y localcloud-cli 3000 --relay https://example.com
   # or: npx -y localcloud-cli doctor --relay https://example.com
   ```

### Which domain?

Use the **zone apex** (`example.com`) as `DOMAIN`, so tunnels live at `<id>.example.com`.
Cloudflare's free Universal SSL certificate covers only one level of wildcard. A deeper
`DOMAIN = "tunnels.example.com"` would make tunnels `<id>.tunnels.example.com`, which needs an
advanced or custom certificate (a paid add-on at the time of writing). Tunnels also share cookies
and site reputation with the parent domain, so don't use the domain your main product lives on.

### No domain? workers.dev with cookie routing

`*.workers.dev` has no per-tunnel wildcard, but the relay supports the Node relay's **cookie
routing**. Remove the `routes`, set `workers_dev = true` and `DOMAIN = ""`, then deploy. Tunnel
URLs look like `https://localcloud-relay.<account>.workers.dev/__localcloud/t/<id>`. Each browser
can view one tunnel at a time (`/__localcloud/exit` switches back).

## Configuration

| `[vars]` | Default | Meaning |
|---|---|---|
| `DOMAIN` | `example.com` | Tunnels are served at `<id>.DOMAIN`. Empty means cookie routing. |
| `ROUTING` | `auto` | `subdomain` when `DOMAIN` is set, otherwise `cookie`. Can be forced. |
| `INSECURE` | `false` | `true` makes tunnel URLs use `http://`. Only for local development. |
| `PUBLIC_URL` | (request origin) | Public base URL. Only used for cookie routing. |
| `STREAM_STALL_MS` | `60000` | A streaming response whose bytes nobody reads for this long is aborted (see limitations). `0` disables this. |
| `RELAY_TOKEN` (secret) | none | When set, clients must present it in `HELLO`. |

## Local development and tests

`wrangler dev` runs everything in workerd/miniflare locally, with no Cloudflare account needed.
The `dev` environment in `wrangler.toml` has no routes on purpose: with routes configured,
`wrangler dev` rewrites the `Host` header to the route's zone, which breaks subdomain routing.

```bash
npx wrangler dev --env dev            # http://localhost:8787, DOMAIN=localhost:8787, INSECURE=true
npx localcloud-cli 3000 --relay http://127.0.0.1:8787
curl --noproxy '*' http://<id>.localhost:8787/     # curl resolves *.localhost to 127.0.0.1
```

`npm run test:e2e` starts `wrangler dev` on port 8799 and a local HTTP + WebSocket server. It then
drives the real client from `../src/client` over both transports and checks the following:

- GET with cookies and multiple `Set-Cookie` headers
- 5 MB POST, checked by hash
- 5 MB full-duplex mirror
- 8 MB download
- streaming arrival timing
- browser abort reaching the local server
- slow-reader backpressure
- gzip passthrough, 204, and `Location` rewrite
- browser WebSocket echo (text, >64 KiB unicode, 300 KiB binary, subprotocol, server ping, close codes in both directions)
- refused upgrade
- 404, health, protected tunnels, basic auth, and name reservation
- reconnect with a stale cache
- same-instance takeover
- `/http/close`
- the offline/reconnecting page

## Limitations compared to the Node relay

- **Browser WebSockets are re-framed, not piped.** Only `Upgrade: websocket` is supported. Other
  upgrade protocols are forwarded as plain HTTP. Extensions are stripped (no `permessage-deflate`),
  which every WebSocket server and client accepts. The browser-to-local direction has no
  backpressure, because the Workers WebSocket API can't pause a socket. Messages are buffered in
  DO memory.
- **Message size limits.** Cloudflare caps the size of a single WebSocket message, for browser
  WebSockets and for the client transport alike. Check the current Workers/Durable Objects limits
  page. The relay sends `DATA` in 64 KiB frames, and the Node client's frames are normally ≤ 64 KiB.
  A single browser WebSocket *message* above the platform cap fails.
- **Detecting that a browser hung up depends on the runtime.** When the platform cancels the
  response stream, the relay aborts the local request right away. Local workerd never signals this
  across the Worker → Durable Object hop. As a fallback, a response whose queued bytes go unread for
  `STREAM_STALL_MS` (60 s by default) is aborted. A reader that pauses longer than that while data
  is pending (for example a paused media download) is cut off too. Idle streams with nothing queued,
  such as SSE, are never affected.
- **Header details.** Workers lowercase header names and join repeated request headers with `, `
  (except `Set-Cookie`, which is kept separate in both directions). `Transfer-Encoding` isn't
  visible, so `REQ.chunked` is inferred from a body without `Content-Length`. The visitor IP comes
  from `CF-Connecting-IP`.
- **Request bodies** are limited by your Cloudflare plan's request size limit. Long-poll `up`
  batches are capped at 64 MiB, as on the Node relay.
- **One registry object.** Lookups are cached per isolate and stale entries are re-routed. A single
  Durable Object still caps the rate of cache misses and tunnel opens. That's plenty for a personal
  or team relay, but it isn't built for thousands of tunnels.
- **Deploys disconnect clients.** Updating the Worker resets its Durable Objects. Clients reconnect
  automatically and keep their URLs, because the registry is persistent.
- **Not implemented:** `/__localcloud/ask` (Cloudflare handles TLS) and a relay-wide tunnel cap
  (`relay_full`). A per-connection cap of 25 tunnels is enforced.
- **Long-poll is supported but costly** in requests. Each poll and each upload is a Worker request
  plus a Durable Object request (see below). The client prefers WebSocket automatically and only
  falls back when a proxy blocks it.

## Costs

Don't treat this as a quote. Prices and free allowances change, so check the
[Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/) and
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/)
pages. The billable units, at the time of writing:

- **Workers Free** has a daily request allowance. **SQLite-backed Durable Objects**, which this
  relay uses (`new_sqlite_classes`), are available on the Free plan with daily limits. A personal
  relay with light traffic can plausibly stay within the free tier. The Workers Paid plan has a
  monthly minimum and includes larger allowances.
- **Each browser request** costs one Worker request and one Durable Object request, plus a registry
  request on a cache miss. A page load with 50 assets is roughly 100+ requests. Vite and Next.js dev
  servers serve many small modules, so that adds up quickly.
- **WebSocket transport:** a connected client sends a heartbeat every 15 s. Incoming WebSocket
  messages to a Durable Object are billed at a discounted request ratio. The Hibernation API avoids
  duration charges while the object is idle, but the heartbeat and any in-flight request (streaming
  responses, open browser WebSockets) keep it awake, so expect partial savings only.
- **Long-poll transport:** an idle client makes about one `down` poll every 15 s plus one `up` post
  per heartbeat. Each is a Worker request plus a Durable Object request, roughly 20k+ requests per
  idle client per day. That can use up a free daily allowance with only a few idle clients.
- **Storage** is tiny: a few small records per tunnel and session.
