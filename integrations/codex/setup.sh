#!/bin/bash
# Codex cloud → Environment → Setup script.
# The setup script has internet access; the agent phase may not, so install localcloud here.
# Processes started here don't carry into the agent phase — AGENTS.md (localcloud init)
# tells the agent to run `localcloud start <port>` itself.
set -e
npm install -g localcloud-cli
# Optional: persist the relay for the agent phase (exports don't carry over; ~/.bashrc does).
# echo 'export LOCALCLOUD_RELAY=https://relay.example.com' >> ~/.bashrc
