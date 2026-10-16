# localcloud wire protocol (v1)

This is the specification for the protocol between a localcloud **client** (the process inside the
sandbox) and a **relay** (the public server). It is written so that you can build a compatible
client or relay in another language or runtime. The reference implementation is
[`src/protocol.js`](../src/protocol.js), [`src/client/`](../src/client/) and
[`src/relay/server.js`](../src/relay/server.js).

The key words MUST, SHOULD and MAY are used as in RFC 2119.

- [Overview](#overview)
- [Frames](#frames)
- [Frame types](#frame-types)
- [Session handshake](#session-handshake)
- [Tunnels](#tunnels)
- [Streams](#streams)
- [Flow control](#flow-control)
- [Keepalive](#keepalive)
- [Transport: WebSocket](#transport-websocket)
- [Transport: HTTPS long-poll](#transport-https-long-poll)
- [Relay HTTP endpoints](#relay-http-endpoints)
- [Public routing and access control](#public-routing-and-access-control)
- [Limits and timers](#limits-and-timers)
- [Versioning](#versioning)

## Overview

```text
client ── transport (WebSocket or HTTPS long-poll) ──▶ relay
         └─ frames ─ session (HELLO/WELCOME) ─ tunnels (OPEN/OPENED) ─ streams (REQ/RES/DATA/END/ABORT/ACK)
```

- One **session** per transport connection. A session carries any number of **tunnels**, and each
  tunnel carries any number of concurrent **streams**, one per proxied HTTP request or upgrade.
- The **relay** opens every stream. Stream ids are scoped to the session.
- All multi-byte integers are **unsigned big-endian**.

## Frames

Every message is a binary frame:

```text
 0       1               5
 +-------+---------------+---------------------------+
 | type  | stream id     | payload ...               |
 | u8    | u32 BE        | (rest of the frame)       |
 +-------+---------------+---------------------------+
```

- `stream id` is `0` for session-level frames.
- For **control frames** the payload is UTF-8 JSON. An empty payload is equivalent to `{}`.
- For `DATA` the payload is raw bytes. For `ACK` it is a `u32`. `END`, `PING` and `PONG` have an
  empty payload.
- A frame shorter than 5 bytes is invalid. A relay MUST close a session that sends an undecodable
  frame.

## Frame types

| Type | Name | Direction | Stream | Payload |
|---:|---|---|---|---|
| 1 | `HELLO` | client → relay | 0 | JSON `{v, token?, client?}` |
| 2 | `WELCOME` | relay → client | 0 | JSON `{ok, error?, version?, routing?, transport?}` |
| 3 | `OPEN` | client → relay | 0 | JSON `{reqId, secret, name?, port?, protect?, basicAuth?}` |
| 4 | `OPENED` | relay → client | 0 | JSON `{reqId, ok, id?, url?, accessUrl?, error?, code?}` |
| 5 | `CLOSE_TUNNEL` | client → relay | 0 | JSON `{id}` |
| 10 | `REQ` | relay → client | n | JSON request description (below) |
| 11 | `RES` | client → relay | n | JSON `{status, statusText?, headers}` |
| 12 | `DATA` | both | n | raw bytes |
| 13 | `END` | both | n | empty: sender has finished sending on this stream |
| 14 | `ABORT` | both | n | JSON `{code?, message?}` |
| 15 | `ACK` | both | n | `u32` BE: bytes consumed |
| 20 | `PING` | both | 0 | empty |
| 21 | `PONG` | both | 0 | empty |
| 22 | `NOTICE` | relay → client | 0 | JSON `{message}`: informational text for the user |

Receivers MUST ignore frames of unknown type, and frames for unknown stream ids.

## Session handshake

The first frame on a new transport MUST be `HELLO`. A relay MUST close the transport if any other
frame arrives before a successful handshake. The reference relay also closes transports that haven't
completed the handshake within 30 s.

```json
{ "v": 1, "token": "optional relay token",
  "client": { "version": "0.1.0", "platform": "linux", "hostname": "sandbox-123", "agent": "claude-code-web" } }
```

- `v`: the protocol version, currently `1`. The relay compares it numerically.
- `token`: required only if the relay was started with `LOCALCLOUD_RELAY_TOKEN`. The relay compares
  it in constant time.
- `client`: free-form metadata. The reference client sends `agent` as one of `claude-code-web`,
  `claude-code`, `codex`, `cursor`, `devin`, `replit`, `codespaces`, `gitpod` or `unknown`.

The relay answers with `WELCOME`:

```json
{ "ok": true, "version": "0.1.0", "routing": "subdomain", "transport": "ws" }
```

On failure the relay sends `{"ok": false, "error": "…"}`, flushes it, and closes the transport. Current errors are a protocol mismatch and an invalid token. Clients SHOULD treat
`ok: false` as fatal and not retry automatically. The reference client gives up after 10 s
without a `WELCOME`.

## Tunnels

### OPEN

```json
{ "reqId": 1, "secret": "≥16 chars, random", "name": "my-app", "port": 3000,
  "protect": false, "basicAuth": "user:pass" }
```

- `reqId`: a client-chosen integer that is echoed in `OPENED`. Several `OPEN`s may be in flight.
- `secret`: **at least 16 characters**. It proves ownership of a name. The reference client uses
  24 random bytes, base64url-encoded, generated once per process, and uses the same secret for
  every tunnel and every reconnect.
- `name`: optional requested id. The relay normalizes it: lowercase; runs of characters outside
  `[a-z0-9-]` become `-`; leading and trailing `-` are trimmed; it is cut to 48 characters. It is
  rejected if the result is empty or reserved (`www api app admin relay mail status docs dashboard
  localcloud _acme-challenge`). On reconnect, clients SHOULD send their previously assigned id as
  `name`.
- `port`: informational. The relay uses it in "nothing is answering on port N" pages.
- `protect`: if `true`, the relay generates an access key (18 random bytes, base64url). If the
  tunnel already exists and already has a key, that key is kept.
- `basicAuth`: `"user:pass"`. It is ignored unless it contains `:`.

Semantics:

- If `name` is absent, the relay generates an unused name (`adjective-noun-xxxx`).
- If a tunnel with that id exists and its stored secret **differs**, the relay replies
  `{ok:false, code:"name_taken"}`.
- Otherwise the relay creates the tunnel or takes it over. If the tunnel was attached to another
  session that used the same secret, it moves to this session. `protect` and `basicAuth` are
  replaced by the new values.
- A session may hold at most 25 tunnels. A relay may also cap its total number of tunnels
  (reserved ones included). When it is full, it replies `{ok:false, code:"relay_full"}` for new names.

### OPENED

```json
{ "reqId": 1, "ok": true, "id": "sunny-otter-x7k2",
  "url": "https://sunny-otter-x7k2.relay.example.com",
  "accessUrl": "https://sunny-otter-x7k2.relay.example.com/?__lc_access=…" }
```

`accessUrl` is present only for protected tunnels. Errors look like
`{"reqId":1,"ok":false,"error":"the name \"x\" is already taken","code":"name_taken"}`.
Other errors include `invalid secret`, `too many tunnels on one connection`,
`"<name>" can't be used as a name`, and `this relay is at capacity, try again later`
(`code: "relay_full"`).

If an auto-named tunnel gets `name_taken` on reconnect (for example because the relay restarted and
someone else took the name), the reference client drops the name and sends `OPEN` again without one.

### CLOSE_TUNNEL

`{"id": "sunny-otter-x7k2"}` removes the tunnel and its reservation immediately. There is no reply.

### Disconnects

When a session's transport closes, the relay aborts all of its streams. Its tunnels are not
deleted. They are marked offline and **reserved for 1 hour**, during which only the same `secret`
can claim them again.

## Streams

The relay opens a stream by allocating a new stream id (incrementing from 1 within the session)
and sending `REQ`.

### REQ

```json
{
  "tunnel": "sunny-otter-x7k2",
  "method": "GET",
  "url": "/path?query",
  "headers": [["Accept", "text/html"], ["Cookie", "a=1"]],
  "remote": "203.0.113.7",
  "proto": "https",
  "origin": "https://sunny-otter-x7k2.relay.example.com",
  "upgrade": false,
  "chunked": false
}
```

- `headers` is an **ordered list of `[name, value]` pairs**. It preserves case and duplicates.
- Before sending, the relay MUST remove hop-by-hop headers (`Connection`, `Keep-Alive`,
  `Proxy-Connection`, `Proxy-Authenticate`, `Proxy-Authorization`, `TE`, `Trailer`, `Trailers`,
  `Transfer-Encoding`, `Upgrade`, and any header named in `Connection`). When `upgrade` is true,
  `Connection` and `Upgrade` are kept. The reference relay also strips `X-Forwarded-*`,
  `Forwarded`, `X-Real-IP`, `Fly-*`, `CF-*`, `X-Localcloud-Probe`, its own `__lc_*` cookies, and
  `Authorization` when the tunnel uses basic auth.
- `chunked` is `true` when the browser sent the request body with `Transfer-Encoding: chunked`.
  The length is unknown and the body ends with `END`. Clients MAY use it to decide how to frame the
  body towards the local server. It is always `false` for upgrades.
- `remote` is the visitor's IP. `proto` is the public scheme. `origin` is the public origin the
  browser used. Clients use `origin` for header rewriting.
- If the client has no tunnel with that id, it MUST reply `ABORT {code:"ENOTUNNEL"}`.

### Plain HTTP requests (`upgrade: false`)

```text
relay → client   REQ
relay → client   DATA*  (request body)
relay → client   END
client → relay   RES {status, statusText, headers:[[name,value],…]}
client → relay   DATA*  (response body)
client → relay   END
```

- Request body `DATA` may arrive before the client has connected to the local server. Clients MUST
  buffer it.
- `RES.headers` uses the same pair format. Hop-by-hop headers MUST NOT be included. The relay
  merges repeated names into arrays (needed for `Set-Cookie`) and adds `x-accel-buffering: no`.
- The client MUST send `RES` before any response `DATA`. The relay ignores a second `RES`.
- Bodies are transferred raw. `Content-Length` and `Content-Encoding` pass through unchanged, and
  chunked framing is the HTTP layer's job on each side.

### Upgrades (`upgrade: true`)

After `REQ`, the stream becomes a **raw bidirectional byte pipe**:

- The relay sends any bytes it already read after the request head as `DATA`, then everything the
  browser sends.
- The client opens a TCP/TLS connection to the local server and writes an HTTP/1.1 request head
  itself (`METHOD url HTTP/1.1`, its rewritten headers, a blank line). It then pipes bytes both
  ways. The local server's `101 Switching Protocols` response travels to the browser as ordinary
  `DATA`. The client never sends `RES` on an upgrade stream.
- If the relay receives `ABORT` before any `DATA`, it answers the browser with
  `502 Bad Gateway`.

### END and ABORT

- `END` is a half-close. The sender has finished sending, and the other direction may still be
  open. For plain requests the stream is complete when the client sends `END` for the response.
- `ABORT {code, message}` cancels the stream in both directions. Typical codes are `ECONNREFUSED`,
  `ECONNRESET`, `ETIMEDOUT` and `ENOTUNNEL`. The relay maps `ETIMEDOUT` to 504 and everything else
  to 502 if it hasn't sent headers yet. Otherwise it destroys the browser connection. The relay
  sends `ABORT {code:"ECONNRESET", message:"browser went away"}` when the visitor disconnects.

## Flow control

Each stream has an independent credit window **per direction**:

- A sender MUST NOT have more than **2 MiB** (2,097,152 bytes) of `DATA` payload unacknowledged.
  The reference implementation pauses its source at or above the window and resumes once in-flight
  data drops below 1 MiB.
- A receiver sends `ACK n` after it has **delivered** `n` payload bytes to its destination (the
  local server or the browser socket). It MAY coalesce ACKs. The reference implementation sends at
  most one per event-loop turn per stream. The value is clamped to `0xFFFFFFFF`.
- `ACK` with a payload shorter than 4 bytes is treated as `0`.

Upgrade streams use the same flow control. Bytes the relay injects as `DATA` before the pump
starts (the upgrade "head") count against the window.

## Keepalive

- Either side may send `PING` (stream 0), and the receiver MUST reply `PONG`.
- The reference client sends `PING` every 15 s and closes the transport after 45 s without
  receiving any frame.
- The reference relay closes a session after about 67.5 s without receiving any frame, checked
  every 10 s. Over WebSocket it also uses protocol-level pings every 20 s.

## Transport: WebSocket

- Endpoint: `GET /__localcloud/ws` (exact path; a query string is allowed) with a standard
  WebSocket upgrade, on any relay host that does
  **not** route to a tunnel (in subdomain mode, use the apex/relay host).
- Each **binary** WebSocket message carries exactly one frame. Text messages are ignored.
- Per-message deflate SHOULD be disabled. Messages up to 64 MiB are accepted.
- The reference client sends `User-Agent: localcloud/<version> (node <v>; <platform>)`.

## Transport: HTTPS long-poll

This transport only needs ordinary `POST` requests. All endpoints respond with
`Cache-Control: no-store`.

### Batches

The bodies of `/http/up` and `/http/down` are **batches**:

```text
[ length u32 BE ][ frame ][ length u32 BE ][ frame ] ...
```

An empty body is an empty batch. A batch whose last length runs past the end of the body is
invalid. Senders SHOULD keep batches near 4 MiB: the reference implementation adds frames until
the next one would exceed 4 MiB, and always includes at least one frame.

### `POST /__localcloud/http/session`

Request body: empty. Response `200` (or `429` with `Retry-After` when the caller's IP already has
too many open sessions):

```json
{ "sid": "<32 base64url chars>", "hold": 15000 }
```

`hold` is how long (ms) the relay holds an idle `down` request. A session is created on the relay
at this point, and the client then performs the normal `HELLO` handshake over `up`/`down`.

### `POST /__localcloud/http/down?sid=<sid>&ack=<seq>`

This is the downstream channel, relay → client.

- `ack` is the highest batch sequence number the client has fully received (`0` initially).
- The client SHOULD keep exactly one `down` request outstanding. A newer request supersedes the old
  one, which is answered with an empty `200` and `x-lc-seq: 0`.
- The relay responds `200`, `Content-Type: application/octet-stream`, with header
  **`x-lc-seq: <n>`**:
  - `n > 0`: a new batch of frames, or a **retransmission** of batch `n` if the request's `ack`
    was lower than `n`. Clients MUST ignore a batch whose sequence number is `≤` the last one they
    processed.
  - `n = 0`: an empty body. Nothing arrived within `hold` ms. The client polls again.
- `410 Gone`: the session doesn't exist or has closed. The client MUST start over with a new
  session. The reference client also treats `404` as gone.
- Clients SHOULD use a request timeout comfortably above `hold`. The reference client uses
  `hold + 15 s`.

### `POST /__localcloud/http/up?sid=<sid>&seq=<n>`

This is the upstream channel, client → relay. The body is a batch, `Content-Type:
application/octet-stream`.

- `seq` starts at 1 and increases by exactly 1 per batch. The client sends batches **one at a
  time**, in order, and retries the same `seq` on network errors.
- Responses:
  - `204`: accepted. A duplicate (`seq ≤` last accepted) also returns `204` and is discarded.
  - `409`: a sequence gap. The session is unusable, so start over.
  - `400`: a malformed batch.
  - `410`: an unknown or closed session.
  - `413`: the body is larger than 64 MiB.

### `POST /__localcloud/http/close?sid=<sid>`

The client is going away. The relay closes the session immediately and responds `204`, or `410` if
the session is unknown. This is optional, because idle sessions also time out.

### Liveness

The relay closes a long-poll session if no `down` request is outstanding and none has been seen for
45 s. The reference client gives up on a transport after 7 consecutive failures of either loop,
with backoff `min(250·2^n, 4000)` ms, and then reconnects with a new session.

## Relay HTTP endpoints

All relay endpoints live under `/__localcloud/` on a host that doesn't route to a tunnel.

| Method & path | Purpose |
|---|---|
| `GET /__localcloud/health` | `200 {"ok":true,"service":"localcloud","version":"0.1.0","protocol":1,"routing":"subdomain"\|"cookie","tunnels":<count>}`. Clients use `service` to tell a relay from another server. |
| `GET /__localcloud/ws` | WebSocket transport. |
| `POST /__localcloud/http/session`, `/http/down`, `/http/up`, `/http/close` | Long-poll transport. |
| `GET /__localcloud/t/<id>[?__lc_access=<key>]` | Cookie-routing entry point. Sets `__lc_t=<id>` (and the access cookie if the key is valid) and redirects to `/`. `404` page if the tunnel doesn't exist. |
| `GET /__localcloud/exit` | Clears the `__lc_t` routing cookie and redirects to `/`. |
| `GET /__localcloud/ask?domain=<host>` | For Caddy on-demand TLS: `200` if `host` is the relay domain or a **live** tunnel's hostname, otherwise `404`. |
| `GET /` | Landing page with usage instructions. |
| `GET /robots.txt` | `Disallow: /`. |

## Public routing and access control

These rules aren't needed for client compatibility, but a compatible relay should follow them so
that URLs behave the same.

- **Subdomain routing**: the request's `Host`, lowercased, without the port unless the configured
  domain includes one. If it is exactly `<label>.<domain>` with a single label, `<label>` is the
  tunnel id. Tunnel URLs are `https://<id>.<domain>` (`http://` in insecure mode).
- **Cookie routing**: requests outside `/__localcloud/` that carry `__lc_t=<id>` route to that
  tunnel. A routing cookie for an unknown tunnel is cleared with a redirect to `/`. Tunnel URLs are
  `<relay base URL>/__localcloud/t/<id>`.
- **Protected tunnels**: a request with `?__lc_access=<key>` matching the tunnel key is redirected
  to the same URL without the parameter, and sets
  `__lc_a_<id with non-[a-z0-9] → _>=<key>; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000`
  (plus `Secure` on HTTPS). Requests without a valid cookie get `401` and the "private" page.
  `accessUrl` is `<url>/?__lc_access=<key>` for subdomain routing and `<url>?__lc_access=<key>`
  for cookie routing.
- **Basic auth**: the relay compares the decoded `Authorization: Basic` credentials with
  `basicAuth` in constant time and sends `401` with
  `WWW-Authenticate: Basic realm="localcloud", charset="UTF-8"` on mismatch.
- **Offline tunnels**: the relay waits up to 8 s for the owner to reconnect, then sends `503`.
  Requests with `x-localcloud-probe` are not held. They get `503` immediately if the tunnel is
  offline.
- Upgrade requests to unknown tunnels get `404`, unauthorized ones get `401`, and upgrades that time
  out waiting for a reconnect get `503`.
- Request heads larger than the relay's header limit get `431`.

## Limits and timers

| Constant | Value | Where |
|---|---|---|
| Flow-control window | 2 MiB per stream per direction (resume below 1 MiB) | both |
| Max WebSocket message | 64 MiB | both |
| Max long-poll `up` body | 64 MiB | relay |
| Long-poll batch target | 4 MiB | both |
| `down` hold | 15 s | relay |
| Long-poll session idle | 45 s | relay |
| Session idle (no frames) | ~67.5 s | relay |
| Client PING interval / dead after | 15 s / 45 s | client |
| WebSocket ping | 20 s | relay |
| Wait for reconnect per request | 8 s | relay |
| Offline name reservation | 1 h | relay |
| Tunnels per session | 25 | relay |
| Tunnels per relay (incl. reserved) | 10,000 (`LOCALCLOUD_MAX_TUNNELS`) | relay |
| Client sessions per IP | 200 (`LOCALCLOUD_MAX_SESSIONS_PER_IP`), then `429` | relay |
| Max request header size | 32 KiB (`LOCALCLOUD_MAX_HEADER_SIZE`), then `431` | relay |
| Handshake deadline | 30 s | relay |
| Minimum `secret` length | 16 chars | relay |
| Client WS connect timeout (auto mode) / handshake timeout | 7 s / 10 s | client |

## Versioning

`PROTOCOL_VERSION` is `1`. Incompatible changes increment it, and a relay rejects a `HELLO` whose
`v` doesn't match. These changes are backwards-compatible and don't increment it: new optional JSON
fields, and new frame types that receivers may ignore. Implementations MUST ignore unknown JSON
fields.
