# Caddy with the Cloudflare DNS plugin, for the wildcard-certificate Caddyfile.
#   docker build -t caddy-cloudflare deploy/caddy
FROM caddy:2-builder AS builder
RUN xcaddy build --with github.com/caddy-dns/cloudflare

FROM caddy:2
COPY --from=builder /usr/bin/caddy /usr/bin/caddy
