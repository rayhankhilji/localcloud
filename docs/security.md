# Security model

localcloud puts a local server on the public internet, so this page states plainly what it protects
against, what it doesn't, and what relay operators need to think about. To report a vulnerability,
see [SECURITY.md](../SECURITY.md).

- [Actors and trust](#actors-and-trust)
- [Public by default](#public-by-default)
- [Tunnel names](#tunnel-names)
- [Protected links (`--protect`)](#protected-links---protect)
- [Basic auth (`--auth`)](#basic-auth---auth)
- [The relay token](#the-relay-token)
- [Name ownership and takeover](#name-ownership-and-takeover)
- [What the relay can see](#what-the-relay-can-see)
- [Browser isolation between tunnels](#browser-isolation-between-tunnels)
- [What gets exposed from the sandbox](#what-gets-exposed-from-the-sandbox)
- [Headers and client IPs](#headers-and-client-ips)
- [Coding agents and prompt injection](#coding-agents-and-prompt-injection)
- [Running a public relay: abuse and phishing](#running-a-public-relay-abuse-and-phishing)
- [Resource limits](#resource-limits)
- [Checklist](#checklist)

## Actors and trust

| Actor | Trusted with |
|---|---|
| **You / your agent** (client) | Decides what to share. Holds the per-process tunnel secret, and the relay token if one is set. |
| **Relay operator** | Sees all tunneled traffic in plaintext (it terminates TLS). Can issue or revoke access. |
| **Visitors** | Get whatever the shared server serves to anyone holding the URL (and key or password). |
| **Egress proxy** (sandbox) | Sees the client ↔ relay connection. A TLS-intercepting proxy can read and modify it. |
| **Other relay users** | Untrusted. They mustn't be able to hijack your tunnel or read your traffic. |

## Public by default

**An unprotected tunnel URL is a public website.** Anyone who has the link can use your app, and
links leak through chat logs, screenshots, browser history, `Referer` headers and link-preview bots.
For an app that has real data, admin panels, debug endpoints, or anything that can run code (a
notebook, a dev tool with a shell), use `--protect` or `--auth` and stop the tunnel when you're done.

Tunnels exist only while the client runs. `localcloud stop` closes them and frees the names right
away.

## Tunnel names

- Generated names (`sunny-otter-x7k2`) come from `crypto.randomInt`: 64 adjectives × 64 nouns × 32⁴
  suffixes = **2³² ≈ 4.3 billion** combinations. That makes guessing a specific live tunnel
  impractical, but a generated name is **not a secret**. Treat it as obscurity, not access control.
- Names chosen with `--name` are as guessable as you make them.
- **Certificate Transparency:** if the relay gets a separate TLS certificate for each tunnel
  hostname (Caddy on-demand TLS via `/__localcloud/ask`), every hostname is published in public CT
  logs within minutes, and scanners watch those logs. A **wildcard certificate** (DNS-01 challenge)
  avoids publishing individual names.
- `GET /__localcloud/health` reveals how many tunnels exist, but not their names.

## Protected links (`--protect`)

- The relay generates an **18-byte (144-bit) random access key** per tunnel and returns an
  `accessUrl` containing `?__lc_access=<key>`.
- When a browser opens that link, the relay checks the key in constant time, sets an `HttpOnly`,
  `SameSite=Lax` cookie (`Secure` on HTTPS, valid for 30 days), and **redirects to the same URL
  without the key**. Your app never sees the key.
- Requests without a valid cookie get `401` and a "This preview is private" page. WebSocket
  upgrades without it get `401`.
- The key survives client reconnects while the tunnel's reservation lasts. A relay restart, or
  sharing again without `--protect`, removes or rotates it.
- The key is a bearer secret, so anyone you forward the link to gets in. The key also stays in the
  browser history of whoever opened it.
- localcloud's own `__lc_*` cookies are removed from requests before they reach your app.

## Basic auth (`--auth`)

- `--auth user:pass` makes the relay require HTTP Basic credentials. The comparison is
  constant-time.
- The `Authorization` header is **stripped** before the request reaches your app, so your app's own
  auth can't be confused by it.
- The credentials travel to the relay in the `OPEN` message and are held in the relay's memory.
  The relay operator can read them. Use a throwaway password.
- Basic auth over plain `http://` (insecure relays) sends the password in cleartext.
- You can combine `--auth` with `--protect`.

## The relay token

- If the relay is started with `LOCALCLOUD_RELAY_TOKEN`, every client must send the same token in
  its `HELLO` (compared in constant time). Otherwise the handshake fails and the client stops
  retrying.
- It's a single shared secret. There are no per-user accounts, scopes or revocation lists, so
  rotating it means updating every client. Keep it in environment secrets rather than a committed
  `localcloud.json`.
- **Without a token, anyone who can reach your relay can create tunnels on your domain.** Set one
  for any relay on the public internet unless you've made a deliberate decision to run a public
  service (see [abuse](#running-a-public-relay-abuse-and-phishing)).

## Name ownership and takeover

- Each client process generates a random 24-byte **secret** and sends it with every `OPEN`. The
  relay binds a tunnel name to the first secret that claimed it.
- A different secret can't claim a name that is live **or reserved**. A reservation lasts 1 hour
  after an unclean disconnect. That stops other users from grabbing your URL during a reconnect.
- After an explicit stop (or once the reservation expires), the name is free and **anyone can claim
  it**. Old links to a stopped tunnel may later point to someone else's tunnel, which matters most
  for custom `--name`s on shared relays.
- The relay keeps all state in memory, so a relay restart clears every reservation.

## What the relay can see

The relay terminates TLS for visitor traffic and relays it to the client over a second TLS
connection. **The relay operator can read and modify everything that passes through**: requests,
responses, cookies, and basic-auth credentials. The same is true of any TLS-intercepting egress
proxy between the sandbox and the relay. That is how the sandbox is designed, and localcloud
doesn't change it.

For confidentiality, run your own relay ([self-hosting.md](self-hosting.md)). There is no
end-to-end encryption between the browser and the local server.

## Browser isolation between tunnels

Browsers isolate sites by origin, and cookies by site, and that matters on a shared relay:

- **Cookie routing** (no wildcard domain) serves **every tunnel from the same origin**. Cookies,
  `localStorage`, IndexedDB, service workers and cached credentials set by one tunnel's app are
  visible to every other tunnel the same browser opens on that relay. Only use cookie routing on a
  relay where everyone who creates tunnels trusts each other, such as a personal or team relay.
- **Subdomain routing** gives each tunnel its own origin, so storage is isolated. Tunnels are still
  **same-site** siblings, though: an app on `a.tunnel.example.com` can set a cookie with
  `Domain=tunnel.example.com` that the browser then sends to `b.tunnel.example.com` (cookie
  tossing), and `SameSite` doesn't protect between them. Operators of public relays should
  **submit the tunnel domain to the [Public Suffix List](https://publicsuffix.org/)**, as the large
  tunnel providers do, so that browsers treat each tunnel as its own site. Use a dedicated domain
  for tunnels, never one that also hosts your main site or SSO cookies.
- localcloud strips `Domain=localhost` (and loopback variants) from `Set-Cookie` so that apps work
  on the public host. It doesn't rewrite other `Domain` attributes.

## What gets exposed from the sandbox

- **Explicit sharing** (`localcloud 3000`, `start 3000`) exposes exactly that target. A target can
  be any host the machine can reach (`http://10.0.0.5:80`), not only localhost, so be careful what
  you point it at.
- **Watch mode** (`start` with no port, `run`, MCP `auto_share`) exposes every new listening port
  that meets the [detection rules](how-it-works.md#port-detection). Well-known database, cache,
  Docker and debugger ports are excluded, and so are ports < 1024 and ports already listening at
  start (unless they're common dev ports). Anything else, such as a database on a non-standard port
  or an admin UI, **would** be shared. Use `LOCALCLOUD_IGNORE_PORTS`, or list ports explicitly, in
  environments that run sensitive services.
- `localcloud run` watches the whole machine, not just the child process.
- HTTPS targets are contacted **without certificate verification**. This is meant for self-signed
  local dev certificates.
- The daemon's control socket (`~/.localcloud/daemon.sock`) is created with mode `0600`, so other
  local users can't drive your daemon. Anything running as your user can.

## Headers and client IPs

- Incoming `X-Forwarded-*`, `Forwarded`, `X-Real-IP`, `Fly-*` and `CF-*` headers from visitors are
  **dropped**. The client then sets `X-Forwarded-For` (the visitor IP as the relay sees it),
  `X-Forwarded-Proto`, `X-Localcloud-Url`, and `X-Forwarded-Host` unless the mode is `rewrite`.
- The relay determines the visitor IP and scheme from `Fly-Client-IP`, `CF-Connecting-IP`,
  `X-Forwarded-For` and `X-Forwarded-Proto` **as sent to the relay**, because it expects to sit
  behind a TLS-terminating proxy. If you expose the relay port directly to the internet, visitors
  can spoof those values. Put the relay behind a proxy that overwrites them (Caddy, nginx, Fly,
  Cloudflare), and don't use `X-Forwarded-For` for security decisions in the tunneled app.

## Coding agents and prompt injection

An agent that can run `localcloud start` or call the MCP `share_port` tool can publish any local
port. Content the agent reads (a web page, an issue, a dependency's README) could try to talk it
into exposing something it shouldn't. To limit the impact:

- Prefer explicit ports over watch mode where services other than the dev server run.
- Use `--protect` by default for anything non-trivial, and say so in your `AGENTS.md`.
- Use a relay token so that tunnels can only be created on infrastructure you control.
- Remember that the sandbox's own isolation is still what protects your other systems. localcloud
  only exposes what is reachable from inside the sandbox.

## Running a public relay: abuse and phishing

Free tunnel services are a favorite tool for phishing and malware delivery, because they offer
instant HTTPS on a reputable-looking domain. If you open a relay to the public (no token), expect
abuse, and expect your domain to end up on blocklists, Safe Browsing warnings included, if you
don't handle it.

What localcloud provides today:

- the relay token, which turns the relay into an invite-only service,
- reserved names (`www`, `api`, `app`, `admin`, `relay`, `mail`, `status`, `docs`, `dashboard`,
  `localcloud`, `_acme-challenge`) so that tunnels can't impersonate obvious infrastructure,
- per-IP connection caps (`LOCALCLOUD_MAX_SESSIONS_PER_IP`) and a global tunnel cap
  (`LOCALCLOUD_MAX_TUNNELS`),
- relay logs of client connections (IP, agent, version) and tunnel creation,
- `robots.txt` that disallows crawling.

What it **doesn't** provide, and what operators of public relays should add:

- **Visitor interstitials.** There is no built-in "you are visiting a tunnel" warning page.
- **Request rate limiting.** Add it in the fronting proxy (nginx `limit_req`, Caddy rate-limit
  modules, Cloudflare rules).
- **Abuse reporting and takedown.** Publish an abuse contact on your landing page and in DNS/WHOIS,
  and be ready to restart the relay or block client IPs. There is no admin API for killing a
  single tunnel yet.
- **Content scanning / blocklists.**
- **Public Suffix List** registration for the tunnel domain, as above.
- **A separate domain.** Never run a public relay on a domain whose reputation you need for email or
  your main product.

For most people the right answer is a **private relay with a token**, shared with the team and its
agents.

## Resource limits

These are relay defaults. They limit damage but don't make a public relay DoS-proof:

| Limit | Value |
|---|---|
| Tunnels per client connection | 25 |
| Tunnels per relay | 10,000 (`LOCALCLOUD_MAX_TUNNELS`) |
| Client connections per IP | 200 (`LOCALCLOUD_MAX_SESSIONS_PER_IP`) |
| Request header size | 32 KiB (`LOCALCLOUD_MAX_HEADER_SIZE`) |
| WebSocket message / long-poll upload | 64 MiB |
| Buffered data per stream per direction | 2 MiB (flow-control window) |
| Unauthenticated handshake deadline | 30 s |

## Checklist

**Sharing:**
- [ ] Is it OK for anyone with the link to use this app? If not, use `--protect` or `--auth`.
- [ ] Watch mode on a machine with other services? Use `LOCALCLOUD_IGNORE_PORTS` or explicit ports.
- [ ] `localcloud stop` when you're done.

**Running a relay:**
- [ ] `LOCALCLOUD_RELAY_TOKEN` set (unless intentionally public).
- [ ] A dedicated domain, with a wildcard certificate (avoids leaking names to CT logs).
- [ ] Behind a TLS proxy that overwrites `X-Forwarded-*`.
- [ ] Subdomain routing if more than one person or team uses it. Public Suffix List entry if it's public.
- [ ] An abuse contact and a plan for handling reports.
