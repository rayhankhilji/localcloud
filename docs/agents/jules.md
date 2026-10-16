# Jules (Google)

## 1-minute setup

```sh
npx -y localcloud-cli init --relay https://relay.example.com
```

Commit `AGENTS.md` and `localcloud.json`. Jules uses `AGENTS.md` for project hints.

## Setup script

In Jules, open the repo under **codebases** → **Configuration** → **Initial Setup** and add
([`integrations/jules/setup.sh`](../../integrations/jules/setup.sh)):

```bash
npm install -g localcloud-cli
```

Click **Run and Snapshot**; later tasks start from that snapshot.

### Auto-share

A snapshot stores the filesystem, not running processes, so the agent starts sharing itself per the
`AGENTS.md` block. Ask "share the dev server and give me the URL" if it doesn't.

## MCP

Not applicable (no repo-level MCP config documented for Jules).

## Allowlisting the relay

Jules' docs don't describe a network allowlist for task VMs (unverified). If `localcloud doctor`
reports the relay as unreachable, Jules' VM can't reach it and there's nothing to configure on the repo side.

## Troubleshooting

- `localcloud: command not found` → the snapshot predates the setup script; re-run **Run and Snapshot**.
- Use `npx -y localcloud-cli doctor` for connectivity.

Source: [Jules environment setup](https://jules.google/docs/environment/).
