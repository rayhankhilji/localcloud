#!/bin/bash
# Claude Code cloud environment → "Setup script" field (runs before Claude Code starts; cached).
# Pre-installs localcloud so the SessionStart hook / agent doesn't download it every session.
# Background processes started here do NOT survive the environment cache — the
# SessionStart hook (localcloud init) starts the daemon in every session instead.
npm install -g localcloud-cli
