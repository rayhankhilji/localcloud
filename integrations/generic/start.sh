#!/bin/sh
# Drop into any agent's setup/startup script. Safe to run repeatedly.
#   LOCALCLOUD_RELAY must be set, or a localcloud.json committed in the repo.
command -v localcloud >/dev/null 2>&1 || npm install -g localcloud-cli >/dev/null 2>&1 || true
if command -v localcloud >/dev/null 2>&1; then localcloud start || true; else npx -y localcloud-cli start || true; fi
