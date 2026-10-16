# Snippet: bake localcloud into any agent sandbox image (Codex universal, Cursor build, OpenHands runtime, …).
FROM node:22-bookworm-slim
RUN npm install -g localcloud-cli
ENV LOCALCLOUD_RELAY=https://relay.example.com
# Start it from your entrypoint / startup script, not here (build steps don't keep processes):
#   localcloud start || true
