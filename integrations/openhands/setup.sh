#!/bin/bash
# Commit as .openhands/setup.sh — OpenHands runs it when it starts working on the repo.
npm install -g localcloud-cli
localcloud start || true
