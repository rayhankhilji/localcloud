# Deploying a localcloud relay

Copy-paste configs for running your own relay. The step-by-step guide, DNS setup, Cloudflare notes
and the full configuration reference are in [docs/self-hosting.md](../docs/self-hosting.md).

| Directory | What |
|---|---|
| [`fly/`](fly/) | Fly.io: one always-on machine, wildcard certificates via `fly certs` |
| [`render/`](render/) | Render Blueprint (Docker web service, cookie routing on `onrender.com`) |
| [`railway/`](railway/) | Railway config-as-code |
| [`docker-compose/`](docker-compose/) | Any VPS: relay + Caddy with on-demand TLS |
| [`caddy/`](caddy/) | Caddy with one wildcard certificate via DNS challenge (Cloudflare) |
| [`nginx/`](nginx/) | nginx reverse proxy (WebSockets, no buffering, long timeouts) |
| [`systemd/`](systemd/) | Bare metal / VM service unit |
| [`kubernetes/`](kubernetes/) | Deployment (1 replica) + Service + Ingress |

The image is built from the repository's [`Dockerfile`](../Dockerfile) and published as
`ghcr.io/rayhankhilji/localcloud`.

**Run exactly one relay instance and keep it running.** Tunnels live in the relay's memory, so
don't scale it horizontally or let the platform scale it to zero.
