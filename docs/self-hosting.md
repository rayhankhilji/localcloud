# Self-hosting a relay

The relay is the public half of localcloud. Clients inside agent sandboxes connect **out** to it
(a WebSocket, or HTTPS long-polling when WebSockets are blocked), and it serves their dev servers
at public URLs. It's the same npm package as the CLI (`localcloud relay`), a single Node.js process
with one dependency. It needs very little: 256 MB of RAM is plenty for hundreds of tunnels.

Every config below is copy-paste ready and lives in [`deploy/`](../deploy/):

| Platform | Files | Time | You get |
|---|---|---|---|
| [Fly.io](#flyio) | [`deploy/fly/`](../deploy/fly/) | ~3 min | `https://<app>.fly.dev`, wildcard domain optional |
| [Render](#render) | [`deploy/render/`](../deploy/render/) | ~3 min | `https://<service>.onrender.com`, wildcard domain optional |
| [Railway](#railway) | [`deploy/railway/`](../deploy/railway/) | ~3 min | `https://<service>.up.railway.app`, wildcard domain optional |
| [Any VPS: Docker Compose + Caddy](#any-vps-docker-compose--caddy) | [`deploy/docker-compose/`](../deploy/docker-compose/) | ~5 min | Your domain, automatic HTTPS |
| [Wildcard cert via DNS challenge](#wildcard-certificate-caddy--dns-challenge) | [`deploy/caddy/`](../deploy/caddy/) | ~5 min | Same, with one `*.` certificate |
| [nginx](#nginx) | [`deploy/nginx/`](../deploy/nginx/) | ~10 min | Your existing nginx in front |
| [Bare metal: systemd](#bare-metal-systemd) | [`deploy/systemd/`](../deploy/systemd/) | ~5 min | A plain service, no Docker |
| [Kubernetes](#kubernetes) | [`deploy/kubernetes/`](../deploy/kubernetes/) | ~10 min | Deployment + Service + Ingress |
| [Docker, anywhere](#docker) | [`Dockerfile`](../Dockerfile) | 1 min | `ghcr.io/rayhankhilji/localcloud` |

**Contents**

- [Requirements](#requirements)
- [Choose a routing mode](#choose-a-routing-mode)
- [Domain and DNS](#domain-and-dns)
- [Deploy](#deploy): [Docker](#docker) · [Fly.io](#flyio) · [Render](#render) · [Railway](#railway) ·
  [VPS + Caddy](#any-vps-docker-compose--caddy) · [Caddy + DNS challenge](#wildcard-certificate-caddy--dns-challenge) ·
  [nginx](#nginx) · [systemd](#bare-metal-systemd) · [Kubernetes](#kubernetes) · [Locally](#run-it-locally) ·
  [Other platforms](#other-platforms)
- [Check that it works](#check-that-it-works)
- [Configuration reference](#configuration-reference)
- [Securing the relay](#securing-the-relay)
- [Behind Cloudflare](#behind-cloudflare)
- [Pointing clients at your relay](#pointing-clients-at-your-relay)
- [Running a public hosted relay](#running-a-public-hosted-relay)
- [Operations](#operations)
- [Troubleshooting](#troubleshooting)

## Requirements

- **Node.js 20+**, or Docker. The image is `ghcr.io/rayhankhilji/localcloud` (amd64 + arm64).
- **Public HTTPS.** Let the platform or a reverse proxy (Caddy, nginx, an ingress) terminate TLS
  and forward plain HTTP to the relay on port 8080. The relay can also terminate TLS itself
  (`LOCALCLOUD_TLS_CERT`/`LOCALCLOUD_TLS_KEY`).
- **Long-lived connections.** WebSockets must pass through, and requests must be allowed to stay
  open for at least 30 seconds without buffering. Every config here sets that up.
- **Exactly one instance, always running.** This one is important. The relay keeps every tunnel in
  memory, so:
  - **No horizontal scaling.** With two instances, a browser request lands on an instance that
    doesn't hold the tunnel, and you get random "tunnel not found" errors. Pin replicas to 1 and
    turn autoscaling off.
  - **No scale-to-zero.** A stopped relay drops every connected agent. Free tiers that sleep when
    idle aren't a good fit.

  Restarts are fine: clients reconnect on their own and get the same URLs back (see
  [Operations](#operations)).
- **Optional: a domain** whose DNS you control, for `https://<id>.<domain>` URLs. Without one you
  still get working tunnels via cookie routing (next section).

## Choose a routing mode

| | **Subdomain routing** | **Cookie routing** |
|---|---|---|
| Tunnel URL | `https://sunny-otter-x7k2.tunnel.example.com` | `https://relay.example.com/__localcloud/t/sunny-otter-x7k2` |
| Needs | A domain, wildcard DNS (`*.tunnel.example.com`), a wildcard (or on-demand) certificate | Nothing: works on `*.fly.dev`, `*.onrender.com`, `*.up.railway.app` |
| Several tunnels open in one browser | Yes, each has its own origin | One at a time per browser: the cookie picks the tunnel, and opening another link switches it |
| Isolation between tunnels | Separate origins (separate cookies, storage, service workers) | All tunnels share the relay's origin |
| `--name my-app` | `https://my-app.tunnel.example.com` | `…/__localcloud/t/my-app` |
| Turn on | `LOCALCLOUD_DOMAIN=tunnel.example.com` | Leave `LOCALCLOUD_DOMAIN` unset |

`LOCALCLOUD_ROUTING=auto` (the default) picks subdomain routing when `LOCALCLOUD_DOMAIN` is set, and
cookie routing otherwise. **Use subdomain routing for anything beyond a quick trial.** Cookie routing
is great for getting started in five minutes, and you can add a domain later without changing
anything on the client side except the URLs it prints.

How cookie routing works: `/__localcloud/t/<id>` sets a routing cookie and redirects to `/`, and
from then on that browser's requests to the relay go to that tunnel. `/__localcloud/exit` clears it.
Paths under `/__localcloud/` always belong to the relay.

## Domain and DNS

**Use a domain (or subdomain) dedicated to the relay**, such as `tunnel.example.com` or a separate
registered domain like `mytunnels.dev`. Don't use a name under a domain whose cookies matter: any
tunnel at `x.tunnel.example.com` can set cookies for `tunnel.example.com`, and a tunnel directly
under `example.com` could set cookies for `example.com` and your other sites on it.

With `LOCALCLOUD_DOMAIN=tunnel.example.com`, the relay itself answers at `https://tunnel.example.com`
(landing page, client API, health check) and tunnels at `https://<id>.tunnel.example.com`.
You need two DNS names pointing at the relay:

| Name | Type | Value |
|---|---|---|
| `tunnel.example.com` | `A` / `AAAA` (or `CNAME`) | Your server's IP (or the platform hostname) |
| `*.tunnel.example.com` | `A` / `AAAA` (or `CNAME`) | Same |

Platforms that issue wildcard certificates for you (Fly.io, Render, Railway) also ask for an
`_acme-challenge` `CNAME`. Their dashboards and CLIs print the exact value, see each section below.

Check it from anywhere:

```sh
dig +short tunnel.example.com
dig +short anything-at-all.tunnel.example.com   # must print the same address
```

## Deploy

### Docker

```sh
docker run -d --name localcloud-relay --restart unless-stopped -p 8080:8080 \
  -e LOCALCLOUD_DOMAIN=tunnel.example.com \
  -e LOCALCLOUD_RELAY_TOKEN="$(openssl rand -hex 24)" \
  ghcr.io/rayhankhilji/localcloud:latest
```

Put TLS in front of it (Caddy, nginx, a load balancer), or use one of the complete setups below. To
build the image yourself: `docker build -t localcloud-relay .` from the repository root. The image
runs as the unprivileged `node` user, listens on `$PORT` (default 8080) and has a `HEALTHCHECK` on
`/__localcloud/health`.

Image tags: `latest` and `1.2.3` / `1.2` / `1` for releases, `main` for the newest commit on `main`,
`sha-<commit>` for a specific build. Pin a version in production.

### Fly.io

Fly's proxy handles TLS, WebSockets and long-lived connections well, and it can issue wildcard
certificates. [`deploy/fly/fly.toml`](../deploy/fly/fly.toml) already pins the relay to one
always-on machine (`auto_stop_machines = "off"`, `min_machines_running = 1`), counts concurrency in
connections with high limits, and health-checks `/__localcloud/health`.

1. Install [flyctl](https://fly.io/docs/flyctl/install/) and run `fly auth login`.
2. Create the app, then set `app = "<your-app>"` at the top of `deploy/fly/fly.toml`:

   ```sh
   fly apps create <your-app>
   ```

3. Optional, but recommended: require a token from clients.

   ```sh
   fly secrets set LOCALCLOUD_RELAY_TOKEN="$(openssl rand -hex 24)" -c deploy/fly/fly.toml
   ```

4. Deploy from the repository root. `--ha=false` keeps it to **one** machine (Fly creates two by
   default, which would split tunnels between them):

   ```sh
   fly deploy . -c deploy/fly/fly.toml --ha=false
   ```

5. Check it: `curl https://<your-app>.fly.dev/__localcloud/health`. That's a working relay with
   cookie routing. Clients can use `https://<your-app>.fly.dev` right away.

If `fly status` ever shows more than one machine, run `fly scale count 1 -c deploy/fly/fly.toml`.

**Custom wildcard domain on Fly**

1. Set the domain in `deploy/fly/fly.toml` and deploy again:

   ```toml
   [env]
     LOCALCLOUD_DOMAIN = "tunnel.example.com"
   ```

2. Get the app's IP addresses with `fly ips list`. If there's no IPv4 address, add a shared one:
   `fly ips allocate-v4 --shared`. For IPv6: `fly ips allocate-v6`.
3. Create the DNS records:

   | Name | Type | Value |
   |---|---|---|
   | `tunnel.example.com` | `A` | the app's IPv4 |
   | `tunnel.example.com` | `AAAA` | the app's IPv6 |
   | `*.tunnel.example.com` | `A` | the app's IPv4 |
   | `*.tunnel.example.com` | `AAAA` | the app's IPv6 |
   | `_acme-challenge.tunnel.example.com` | `CNAME` | the target from `fly certs show` (step 5), like `tunnel.example.com.<id>.flydns.net` |

4. Ask Fly for both certificates:

   ```sh
   fly certs add tunnel.example.com -c deploy/fly/fly.toml
   fly certs add "*.tunnel.example.com" -c deploy/fly/fly.toml
   ```

5. `fly certs show "*.tunnel.example.com" -c deploy/fly/fly.toml` prints the exact
   `_acme-challenge` CNAME target. Wildcard certificates can only be issued through that DNS
   challenge, so the CNAME is required. Wait for `fly certs check` to report both as issued.

Fly bills wildcard certificates (a small monthly fee, see their pricing page). If you use
Cloudflare for DNS, either keep these records DNS-only (grey cloud), or read
[Behind Cloudflare](#behind-cloudflare).

### Render

[`deploy/render/render.yaml`](../deploy/render/render.yaml) is a Blueprint for a Docker web service
with one instance and a health check.

1. Fork this repository (or push it to your own GitHub/GitLab).
2. In the Render dashboard: **New → Blueprint**, pick the repository, and set **Blueprint Path** to
   `deploy/render/render.yaml`. Fill in `LOCALCLOUD_RELAY_TOKEN` if you want one, leave
   `LOCALCLOUD_DOMAIN` empty for now, and apply.

   Or by hand: **New → Web Service**, runtime **Docker**, health check path
   `/__localcloud/health`, one instance.
3. When the deploy is live, `curl https://<service>.onrender.com/__localcloud/health`. Cookie
   routing works out of the box on `onrender.com`.

Use a paid instance type: free instances spin down after a stretch without traffic and restart
regularly, and each restart drops every tunnel.

**Custom wildcard domain on Render**

1. Service → **Settings → Custom Domains**: add `tunnel.example.com` and `*.tunnel.example.com`.
2. Create the DNS records Render shows: a `CNAME` for each name pointing at
   `<service>.onrender.com`, plus the verification record(s) Render lists for the wildcard (such as
   an `_acme-challenge` CNAME). Copy them exactly as shown and wait until both domains are verified.
3. **Environment**: set `LOCALCLOUD_DOMAIN=tunnel.example.com`. Render redeploys, and new tunnels get
   `https://<id>.tunnel.example.com` URLs.

### Railway

[`deploy/railway/railway.json`](../deploy/railway/railway.json) builds the Dockerfile, runs one
replica with sleeping turned off, and health-checks the relay.

1. **New Project → Deploy from GitHub repo** and pick your fork.
2. Service → **Settings → Config-as-code**: set the Railway config file path to
   `/deploy/railway/railway.json`.
3. **Variables**: add `LOCALCLOUD_RELAY_TOKEN` if you want one. Railway provides `PORT`, which the
   relay uses.
4. **Settings → Networking → Generate Domain**. You get `https://<service>.up.railway.app` with
   cookie routing.

**Custom wildcard domain on Railway**: in **Networking → Custom Domain**, add `tunnel.example.com`
and `*.tunnel.example.com`, then create the DNS records Railway shows (`CNAME`s to your service, and
for the wildcard an `_acme-challenge` `CNAME`). Once both are verified, set
`LOCALCLOUD_DOMAIN=tunnel.example.com` in **Variables**.

### Any VPS: Docker Compose + Caddy

[`deploy/docker-compose/`](../deploy/docker-compose/) runs the relay plus Caddy, which gets
certificates from Let's Encrypt automatically. It uses Caddy's **on-demand TLS**: the first visit to
a new hostname fetches a certificate for it. Before it does, Caddy asks the relay
(`GET /__localcloud/ask?domain=…`), which only says yes for the relay's own domain and for tunnels
that are connected right now, so nobody can make your server request certificates for random names.
No DNS API access is needed.

1. A VM with a public IP and ports **80 and 443** open (any provider, 512 MB is enough), with
   Docker installed.
2. DNS: `tunnel.example.com` and `*.tunnel.example.com` as `A` (and `AAAA` if you have IPv6) records
   pointing at the VM. If the DNS is on Cloudflare, keep them **DNS only** (grey cloud) for this
   setup.
3. On the VM:

   ```sh
   git clone https://github.com/rayhankhilji/localcloud.git
   cd localcloud/deploy/docker-compose
   cp .env.example .env
   $EDITOR .env          # LOCALCLOUD_DOMAIN, ACME_EMAIL, optional LOCALCLOUD_RELAY_TOKEN
   docker compose up -d
   ```

4. `curl https://tunnel.example.com/__localcloud/health`

The first request to a brand-new tunnel takes a few seconds while its certificate is issued. Later
requests, and reconnects under the same name, use the cached certificate (stored in the
`caddy_data` volume, so keep that volume).

> **Rate limits.** Let's Encrypt allows 50 new certificates per registered domain per week. Every
> new random tunnel name uses one; names reused with `--name` don't. That's plenty for a team. For
> heavier or public use, switch to a single wildcard certificate (next section).

### Wildcard certificate: Caddy + DNS challenge

[`deploy/caddy/`](../deploy/caddy/) gets **one** certificate for `tunnel.example.com` and
`*.tunnel.example.com` through the ACME DNS challenge. There are no per-tunnel certificates and no
rate-limit concerns, and new tunnels are reachable instantly. The challenge needs API access to your
DNS. The files use Cloudflare DNS; other providers have
[caddy-dns modules](https://github.com/caddy-dns) and only the `dns` line changes.

1. Create a Cloudflare API token with **Zone → DNS → Edit** (and **Zone → Zone → Read**) for the
   zone.
2. DNS records as above (`tunnel` and `*.tunnel`).
3. With Docker:

   ```sh
   cd localcloud/deploy/caddy
   cat > .env <<'EOF'
   LOCALCLOUD_DOMAIN=tunnel.example.com
   ACME_EMAIL=you@example.com
   CLOUDFLARE_API_TOKEN=...
   LOCALCLOUD_RELAY_TOKEN=
   EOF
   docker compose up -d --build     # builds Caddy with the Cloudflare plugin (deploy/caddy/Dockerfile)
   ```

   Without Docker: build Caddy with the plugin (`xcaddy build --with github.com/caddy-dns/cloudflare`,
   or `caddy add-package github.com/caddy-dns/cloudflare`), run the relay with
   [systemd](#bare-metal-systemd), copy `deploy/caddy/Caddyfile` to `/etc/caddy/Caddyfile`, and give
   Caddy the environment (`sudo systemctl edit caddy`):

   ```ini
   [Service]
   Environment=LOCALCLOUD_DOMAIN=tunnel.example.com ACME_EMAIL=you@example.com RELAY_UPSTREAM=127.0.0.1:8080
   Environment=CLOUDFLARE_API_TOKEN=...
   ```

### nginx

[`deploy/nginx/localcloud.conf`](../deploy/nginx/localcloud.conf) proxies to a relay on
`127.0.0.1:8080` with everything the relay needs: WebSocket upgrades (`Upgrade`/`Connection`),
`Host` and `X-Forwarded-Proto` passed through, `proxy_buffering off` (long polls and streaming
responses must flow immediately), and one-hour read/send timeouts.

1. Run the relay on the same host ([systemd](#bare-metal-systemd), or Docker with
   `-p 127.0.0.1:8080:8080`).
2. Get a certificate that covers both names. Wildcards need the DNS challenge, for example with
   certbot's Cloudflare plugin:

   ```sh
   sudo certbot certonly --dns-cloudflare --dns-cloudflare-credentials ~/.secrets/cloudflare.ini \
     -d tunnel.example.com -d '*.tunnel.example.com'
   ```

3. Copy the config to `/etc/nginx/conf.d/localcloud.conf`, replace `tunnel.example.com`, then
   `sudo nginx -t && sudo systemctl reload nginx`.

The file defines a `map` and an `upstream`, which must be in the `http {}` context. Files in
`conf.d/` are included there. If you paste it into `sites-available/` instead, that's included in
`http {}` too.

### Bare metal: systemd

[`deploy/systemd/localcloud-relay.service`](../deploy/systemd/localcloud-relay.service) runs the
relay as a hardened service (`DynamicUser`, read-only system, no privileges) on `127.0.0.1:8080`,
behind Caddy or nginx on the same host.

```sh
sudo npm install -g localcloud-cli                 # needs Node.js 20+
sudo cp deploy/systemd/localcloud-relay.service /etc/systemd/system/
sudo mkdir -p /etc/localcloud
sudo cp deploy/systemd/relay.env.example /etc/localcloud/relay.env
sudo $EDITOR /etc/localcloud/relay.env            # LOCALCLOUD_DOMAIN, LOCALCLOUD_RELAY_TOKEN
sudo systemctl daemon-reload
sudo systemctl enable --now localcloud-relay
journalctl -u localcloud-relay -f
```

If node isn't on the system `PATH` (nvm, asdf), change `ExecStart` to absolute paths, for example
`ExecStart=/home/me/.nvm/versions/node/v22.12.0/bin/node /home/me/.nvm/versions/node/v22.12.0/bin/localcloud relay`.

To skip the reverse proxy and terminate TLS in the relay, set `PORT=443`, `HOST=0.0.0.0`,
`LOCALCLOUD_TLS_CERT` and `LOCALCLOUD_TLS_KEY`, and uncomment the `CAP_NET_BIND_SERVICE` lines in
the unit. The certificate is read once at startup, so restart the service after each renewal (for
example a certbot `--deploy-hook "systemctl restart localcloud-relay"`). With `DynamicUser`, give
the service access to a root-only key with `LoadCredential=` instead of loosening file permissions.

### Kubernetes

[`deploy/kubernetes/localcloud-relay.yaml`](../deploy/kubernetes/localcloud-relay.yaml) has a
Deployment (**`replicas: 1`, `strategy: Recreate`**), a Service, an ingress-nginx Ingress for
`tunnel.example.com` and `*.tunnel.example.com`, and a cert-manager `Certificate`.

```sh
kubectl create namespace localcloud
kubectl -n localcloud create secret generic localcloud-relay \
  --from-literal=LOCALCLOUD_RELAY_TOKEN="$(openssl rand -hex 24)"
sed 's/tunnel\.example\.com/tunnel.yourdomain.com/g' deploy/kubernetes/localcloud-relay.yaml \
  | kubectl -n localcloud apply -f -
```

- Never add a HorizontalPodAutoscaler or raise `replicas`. `Recreate` makes sure two pods never run
  side by side during a rollout.
- **Ingress timeouts and buffering.** The relay needs WebSockets passed through, read/send timeouts
  well above 30 seconds and response buffering off. The manifest sets this for ingress-nginx
  (`proxy-read-timeout`/`proxy-send-timeout: 3600`, `proxy-buffering: off`). Traefik and Contour
  pass WebSockets by default. On GKE's load balancer, raise the `BackendConfig` `timeoutSec` (30
  seconds by default) to 3600.
- **Wildcard TLS.** cert-manager can only issue `*.tunnel.example.com` with a **DNS-01** solver.
  The manifest expects a `ClusterIssuer` named `letsencrypt-dns`. Delete the `Certificate` if you
  provide the `localcloud-relay-tls` secret another way.

### Run it locally

To develop against a relay on your own machine, use `--http` (URLs use `http://`) and a domain that
resolves to loopback. `*.localhost` resolves to 127.0.0.1 in browsers and curl:

```sh
npx localcloud-cli relay --port 8099 --domain localhost:8099 --http
LOCALCLOUD_RELAY=http://localhost:8099 npx localcloud-cli start 3000
# → http://<id>.localhost:8099
```

### Other platforms

Anything that meets the [requirements](#requirements) works. What to check:

- **Google Cloud Run**: possible with `--min-instances=1 --max-instances=1`, request timeout 3600 s,
  and CPU always allocated (instance-based billing). Without those, instances get throttled or
  scaled away.
- **Heroku-style dynos**: one dyno, and no idle sleeping.
- **Serverless functions** (Vercel, Netlify, Lambda): no. They can't hold the connections. For a
  serverless relay, see [`relay-cloudflare/`](../relay-cloudflare/) (Cloudflare Workers + Durable
  Objects).

## Check that it works

```sh
curl -s https://tunnel.example.com/__localcloud/health
# {"ok":true,"service":"localcloud","version":"0.1.0","protocol":1,"routing":"subdomain","tunnels":0}

# From any machine (or an agent sandbox):
LOCALCLOUD_RELAY=https://tunnel.example.com npx localcloud-cli doctor
LOCALCLOUD_RELAY=https://tunnel.example.com npx localcloud-cli start 3000
```

`doctor` checks each step between the client and the relay (egress proxy, CA certificates, relay
health, WebSocket, long-poll). If WebSockets fail but long-polling works, tunnels still work, but your proxy isn't
forwarding `Upgrade`. Fix that for lower latency.

## Configuration reference

The relay reads flags or environment variables (flags win). All are optional.

| Env | Flag | Default | Description |
|---|---|---|---|
| `PORT` | `--port`, `-p` | `8080` | Listen port. Most platforms set `PORT` for you. |
| `HOST` | `--host` | `0.0.0.0` | Listen address. Use `127.0.0.1` behind a reverse proxy on the same host. |
| `LOCALCLOUD_DOMAIN` | `--domain` | none | Wildcard domain for `https://<id>.<domain>`. A leading `*.` is stripped. May include a port (`localhost:8099`). |
| `LOCALCLOUD_ROUTING` | `--routing` | `auto` | `subdomain` (needs a domain), `cookie`, or `auto` (subdomain when a domain is set). |
| `LOCALCLOUD_PUBLIC_URL` | `--public-url` | from the request | Public base URL used for cookie-routing URLs, for when the `Host`/`X-Forwarded-Proto` the relay sees aren't the public ones. |
| `LOCALCLOUD_RELAY_TOKEN` | `--token` | none | Require clients to send this token (they set `LOCALCLOUD_TOKEN`). |
| `LOCALCLOUD_INSECURE=1` | `--insecure`, `--http` | off | Subdomain tunnel URLs use `http://`. Local development only. |
| `LOCALCLOUD_TLS_CERT`, `LOCALCLOUD_TLS_KEY` | `--tls-cert`, `--tls-key` | none | PEM files. The relay serves HTTPS itself. |
| `LOCALCLOUD_MAX_SESSIONS_PER_IP` | | `200` | Concurrent client connections per IP. Many agent sandboxes share a few egress IPs, so keep it generous. |
| `LOCALCLOUD_MAX_TUNNELS` | | `10000` | Tunnels on the whole relay, reserved ones included. |
| `LOCALCLOUD_MAX_HEADER_SIZE` | | `32768` | Maximum request header bytes. |

Endpoints the relay serves on its own hostname:

| Path | Purpose |
|---|---|
| `GET /__localcloud/health` | Health check: `{"ok":true, "version", "protocol", "routing", "tunnels"}`. |
| `GET /__localcloud/ask?domain=<host>` | Caddy on-demand TLS check: `200` for the relay domain and live tunnels, `404` otherwise. |
| `/__localcloud/ws`, `/__localcloud/http/*` | Client connections (WebSocket, long-poll). |
| `/__localcloud/t/<id>`, `/__localcloud/exit` | Cookie routing: enter or leave a tunnel. |

## Securing the relay

**Set a relay token.** Without one, anyone who finds your relay can publish anything under your
domain, phishing pages included. With one, only clients that know it can open tunnels. Visitors of
tunnel URLs never need it.

```sh
openssl rand -hex 24                 # → set as LOCALCLOUD_RELAY_TOKEN on the relay
export LOCALCLOUD_TOKEN=<same value> # on clients
```

- Give the token to agents as a **secret** in the agent environment's settings, not in
  `localcloud.json` in a public repo.
- To rotate it, change it on the relay and restart. Connected clients are dropped and must have the
  new value before they can reconnect.
- The token controls who can **create** tunnels. Who can **view** a tunnel is up to its owner:
  `--protect` (secret key in the link) or `--auth user:pass`. See [security.md](security.md).

**Keep the relay port private.** The relay trusts `X-Forwarded-Proto`, `X-Forwarded-For`,
`Fly-Client-IP` and `CF-Connecting-IP`, because it expects to be behind a proxy that sets them.
Expose only the proxy (bind the relay to `127.0.0.1`, or keep it on an internal Docker network like
the compose files do), so clients can't fake their IP to get around `LOCALCLOUD_MAX_SESSIONS_PER_IP`.
Your proxy should set `X-Forwarded-For` to the real client address. Caddy, the nginx config, Fly and
Cloudflare all do.

**Tune the limits** (`LOCALCLOUD_MAX_*`) for your audience. Agents in the same cloud often share
egress IPs, so a low per-IP limit hurts legitimate users first.

More on the threat model, abuse handling and the operator checklist:
[security.md](security.md#running-a-public-relay-abuse-and-phishing).

## Behind Cloudflare

You can run the relay's DNS on Cloudflare in either mode:

- **DNS only (grey cloud)**: Cloudflare just answers DNS, and your relay (or Fly/Render/Railway, or
  Caddy) handles TLS. Nothing else to configure. This is the simplest choice, and the one the
  on-demand Caddy setup needs.
- **Proxied (orange cloud)**: traffic goes through Cloudflare's edge. This works, with these
  points:

1. **Certificates cover one level of wildcard.** Universal SSL (free) covers `example.com` and
   `*.example.com`. So with `LOCALCLOUD_DOMAIN=example.com` (a dedicated zone, tunnels at
   `<id>.example.com`), proxied wildcard tunnels work on any plan. With
   `LOCALCLOUD_DOMAIN=tunnel.example.com`, tunnels at `<id>.tunnel.example.com` are **two** levels
   deep and **not** covered by Universal SSL. You'd need an Advanced Certificate (paid), or keep
   those two records DNS-only, or use a dedicated domain at the apex.
2. **Proxied wildcard records** (`*`) are supported on all plans.
3. **WebSockets** are on by default (dashboard → Network → WebSockets). Keep them on. Without them,
   clients fall back to long-polling, which works but is slower.
4. **SSL/TLS mode: Full (strict).** For the origin certificate, a free Cloudflare Origin CA
   certificate for `example.com` + `*.example.com` works well (use it with the
   [nginx](#nginx) config or `LOCALCLOUD_TLS_CERT`/`KEY`). The [DNS-challenge Caddy](#wildcard-certificate-caddy--dns-challenge)
   setup also works. Caddy's on-demand mode doesn't fit behind the orange cloud.
5. **Turn off caching for the relay hostnames.** Cloudflare caches responses for static file
   extensions (`.js`, `.css`, images) by default, and dev servers often don't send `Cache-Control`.
   Add a Cache Rule "hostname ends with `example.com` → Bypass cache", or reused names
   (`--name my-app`) can serve stale assets.
6. **Don't challenge the CLI.** Bot Fight Mode, "I'm Under Attack" and some WAF rules answer
   non-browser requests with a challenge page, which breaks the client's connection. Turn them off
   for these hostnames, or add a WAF skip rule for paths starting with `/__localcloud/`.
7. **Limits:** Cloudflare returns `524` if a response takes more than 100 seconds to start (non-
   Enterprise plans), and caps request bodies at 100 MB on Free/Pro. The relay's long polls (15 s)
   and WebSocket pings (20 s) stay well within that. Only slow dev-server responses are affected.
8. Client IPs: the relay reads `CF-Connecting-IP`, so per-IP limits apply to real clients.

## Pointing clients at your relay

Clients need only the relay's base URL (and the token, if you set one). Pick whichever fits:

```sh
# Per shell / per environment (also the right place for agent environment settings):
export LOCALCLOUD_RELAY=https://tunnel.example.com
export LOCALCLOUD_TOKEN=...                       # only if the relay requires one

# Per repository, committed, so every agent working on it uses the relay with zero setup:
echo '{ "relay": "https://tunnel.example.com" }' > localcloud.json
npx localcloud-cli init --relay https://tunnel.example.com   # does that and teaches your agents

# Per user:
localcloud config set relay https://tunnel.example.com
localcloud config set token ...

# Per command:
npx localcloud-cli 3000 --relay https://tunnel.example.com
```

Priority: flags, then environment, then `localcloud.json` (searched upward from the current
directory), then `~/.localcloud/config.json`, then the built-in default. `localcloud config` shows
which one won. Details: [configuration.md](configuration.md).

**Allowlist the relay in the agent's sandbox.** Cloud agents (Claude Code on the web, Codex cloud,
Cursor background agents, Devin, …) usually run behind an egress allowlist. Add the relay's
hostname (`tunnel.example.com`, or `<app>.fly.dev` etc.) to the environment's allowed domains, or
the client fails with "blocked by the network policy" / HTTP 403. The tunnel URLs
(`*.tunnel.example.com`) are opened by people's browsers, so they don't need to be allowlisted,
unless you want the agent itself to fetch its own public URL. Per-platform steps:
[docs/agents/](agents/README.md#what-the-sandbox-must-be-allowed-to-reach).

## Running a public hosted relay

To make `npx localcloud-cli 3000` work with **no configuration at all**, for everyone, set the
built-in default in [`src/config.js`](../src/config.js) and publish a new version:

```js
export const DEFAULT_RELAY = 'https://tunnel.example.com';
```

It's the lowest priority, so `LOCALCLOUD_RELAY`, `localcloud.json` and user config still win.
Before you do it, think about what a public relay takes:

- **No token.** A default relay has to accept anyone, so lean on the `LOCALCLOUD_MAX_*` limits and
  monitor usage (the health endpoint reports `tunnels`).
- **Abuse.** Expect phishing and malware hosting attempts. Publish an abuse contact, act on
  reports, and read [security.md](security.md#running-a-public-relay-abuse-and-phishing).
- **Use a dedicated registered domain** and consider adding it to the
  [Public Suffix List](https://publicsuffix.org/), so browsers treat each tunnel as its own site
  (cookie isolation, no cross-tunnel cookies).
- **Use a wildcard certificate** (DNS challenge). On-demand TLS would hit Let's Encrypt rate limits.
- **Capacity.** Plan for one machine: Fly's `shared-cpu-1x`/512 MB is a good start, then scale up,
  not out. Every user also needs your hostname on their sandbox allowlist, so keep it stable.

## Operations

- **Restarts and deploys** drop all connections for a moment. Clients reconnect automatically
  (WebSocket, falling back to long-polling) and re-claim the same tunnel names, so URLs stay valid.
  Browsers see a short "reconnecting" page while a tunnel is offline.
- **There's no state to back up.** The only data worth keeping is Caddy's certificate storage
  (`caddy_data` volume) if you use Caddy.
- **Logs** go to stdout, one line per event (client connected, tunnel opened, …): `docker logs`,
  `fly logs`, `journalctl -u localcloud-relay`.
- **Monitoring:** poll `/__localcloud/health` and alert on non-200. Its `tunnels` count is a cheap
  usage metric.
- **Upgrades:** pin an image tag or npm version, then roll to the new one. Clients and relay must
  speak the same wire protocol version (`protocol` in the health output). When a release bumps it,
  upgrade the relay first. Clients with a mismatched version get a clear "update localcloud" error.

## Troubleshooting

| Symptom | Likely cause |
|---|---|
| Random "tunnel not found" for a tunnel that is connected | More than one relay instance. Scale to exactly 1. |
| Every subdomain gives a DNS error | The `*.` wildcard record is missing. `dig +short x.tunnel.example.com`. |
| Subdomain loads the relay landing page instead of the app | The proxy rewrites `Host`. Pass the original `Host` header through. |
| Certificate error on tunnel URLs only | The certificate doesn't cover `*.tunnel.example.com`, or (Cloudflare proxied) the wildcard is two levels deep. |
| First load of a new tunnel takes a few seconds | Normal with on-demand TLS, the certificate is being issued. |
| `doctor`: WebSocket fails, long-poll OK | The proxy doesn't forward `Upgrade`/`Connection`, or Cloudflare WebSockets are off. |
| Pages hang until timeout, or arrive all at once | Response buffering is on (`proxy_buffering off` in nginx, `proxy-buffering: "off"` on ingress-nginx). |
| Connections drop every 30–60 s | The proxy or load balancer idle/read timeout is too low. Raise it to at least a few minutes. |
| Cookie-routing URLs start with `http://` | The proxy doesn't send `X-Forwarded-Proto`. Fix the proxy or set `LOCALCLOUD_PUBLIC_URL`. |
| Clients: "this relay requires a valid LOCALCLOUD_TOKEN" | Set `LOCALCLOUD_TOKEN` to the relay's `LOCALCLOUD_RELAY_TOKEN`. |
| Clients: "blocked by the network policy", HTTP 403/407 | The relay hostname isn't on the sandbox allowlist. See [above](#pointing-clients-at-your-relay). |

More client-side fixes: [troubleshooting.md](troubleshooting.md).
