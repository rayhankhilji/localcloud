# Devin

## 1-minute setup

```sh
npx -y localcloud-cli init --relay https://relay.example.com
```

Commit `AGENTS.md` and `localcloud.json`. Unverified: whether Devin (the cloud agent) reads
`AGENTS.md` automatically — add the same text as **Knowledge** to be sure (below).

## Environment blueprint

Devin's machine setup is a declarative blueprint with `initialize` (full builds), `maintenance`
(runs during builds; shown to the agent at session start, not executed) and `knowledge` (reference
text). Merge [`integrations/devin/blueprint.yaml`](../../integrations/devin/blueprint.yaml):

```yaml
initialize:
  - name: Install localcloud
    run: npm install -g localcloud-cli

maintenance:
  - name: Update localcloud
    run: npm install -g localcloud-cli@latest

knowledge:
  - name: Sharing dev servers
    contents: |
      Whenever you start a dev server the user should see, run `localcloud start <port>`
      and give the user the printed https URL instead of a localhost link.
```

Put `LOCALCLOUD_RELAY` in the blueprint's **Secrets** tab or a step `env` if you don't commit
`localcloud.json`.

### Auto-share

Build steps produce a snapshot (disk only), so a daemon started during the build won't be running in
the session. The knowledge entry makes Devin start it; `localcloud start` with no port auto-shares
everything afterwards.

## MCP

Devin supports MCP servers through its MCP settings (unverified UI path). Use command `npx`, args
`-y localcloud-cli mcp`.

## Allowlisting the relay

Not documented on the pages we checked (unverified). If your org restricts egress, allow the relay's
hostname on port 443.

## Troubleshooting

`localcloud doctor` in Devin's shell shows whether the relay is reachable and which transport works.

Sources: [Repo setup](https://docs.devin.ai/onboard-devin/repo-setup),
[Blueprint reference](https://docs.devin.ai/onboard-devin/environment/blueprint-reference).
