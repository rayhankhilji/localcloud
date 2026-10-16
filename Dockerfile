# syntax=docker/dockerfile:1
#
# localcloud relay — the public server that localcloud clients connect out to.
#
#   docker build -t localcloud-relay .
#   docker run -p 8080:8080 -e LOCALCLOUD_DOMAIN=tunnel.example.com localcloud-relay
#
# Prebuilt multi-arch image: ghcr.io/rayhankhilji/localcloud
# Configuration is environment-only; see docs/self-hosting.md for every variable.
# The relay keeps all state in memory: run exactly ONE container per relay.

FROM node:22-alpine

ENV NODE_ENV=production \
    PORT=8080 \
    HOST=0.0.0.0

WORKDIR /app

# Dependencies first so they cache across source changes.
COPY package.json package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts --no-audit --no-fund \
 && npm cache clean --force

COPY bin ./bin
COPY src ./src

# The node image ships an unprivileged "node" user (uid/gid 1000).
USER node

EXPOSE 8080

# Plain HTTP by default; switches to HTTPS when the relay terminates TLS itself
# (LOCALCLOUD_TLS_CERT/KEY). Uses node so no curl/wget is needed in the image.
HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const s=!!process.env.LOCALCLOUD_TLS_CERT;require(s?'https':'http').get({host:'127.0.0.1',port:process.env.PORT||8080,path:'/__localcloud/health',rejectUnauthorized:false,timeout:4000},r=>process.exit(r.statusCode===200?0:1)).on('error',()=>process.exit(1)).on('timeout',()=>process.exit(1))"

# The relay handles SIGTERM itself (closes tunnels cleanly), so node can be PID 1.
STOPSIGNAL SIGTERM
CMD ["node", "bin/localcloud.js", "relay"]
