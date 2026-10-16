# GitHub Copilot coding agent

## 1-minute setup

```sh
npx -y localcloud-cli init --relay https://relay.example.com --agents copilot --setup
```

Writes the `AGENTS.md` block, a `.github/copilot-instructions.md` block (Copilot reads both) and,
if you don't have one yet, `.github/workflows/copilot-setup-steps.yml`. Commit to the **default
branch** — the setup workflow is only used from there.

## Auto-share: `copilot-setup-steps.yml`

The workflow must contain a single job named `copilot-setup-steps`; only `steps`, `permissions`,
`runs-on`, `services`, `snapshot` and `timeout-minutes` (max 59) are honoured
([`integrations/copilot/copilot-setup-steps.yml`](../../integrations/copilot/copilot-setup-steps.yml)):

```yaml
jobs:
  copilot-setup-steps:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v5
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npm install -g localcloud-cli
      - run: localcloud start || true
```

Unverified: GitHub doesn't document whether background processes started in setup steps keep
running while the agent works. The install step is useful regardless, and the instructions file
makes the agent run `localcloud start <port>` itself. GitHub does document that the agent firewall
doesn't apply to processes started in setup steps.

## MCP

Repository **Settings → Copilot → MCP servers**, paste
([`integrations/copilot/mcp-config.json`](../../integrations/copilot/mcp-config.json)) and
**Save MCP configuration**:

```json
{
  "mcpServers": {
    "localcloud": {
      "type": "local",
      "command": "npx",
      "args": ["-y", "localcloud-cli", "mcp"],
      "tools": ["share_port", "get_url", "list_shared", "stop_sharing", "auto_share"]
    }
  }
}
```

`tools` is required. To pass the relay here instead of `localcloud.json`, add
`"env": {"LOCALCLOUD_RELAY": "$COPILOT_MCP_LOCALCLOUD_RELAY"}` and create that variable/secret in
the repository's `copilot` environment (only names starting with `COPILOT_MCP_` are passed).

For Copilot in VS Code, see [VS Code MCP](generic.md#vs-code).

## Allowlisting the relay

Repository **Settings → Copilot → Internet access → Custom allowlist** → add the relay hostname
(e.g. `relay.example.com`; a domain entry also allows its subdomains) → **Add rule** → **Save changes**.
Repository rules require the organization setting "Allow repository custom rules".

## Troubleshooting

- Setup workflow ignored → it must be on the default branch and the job must be named `copilot-setup-steps`.
  Run it from the Actions tab (`workflow_dispatch`) to test.
- A failing setup step skips the remaining steps; `|| true` keeps `localcloud start` from blocking others.
- Blocked by the firewall → add the relay to the custom allowlist.

Sources: [Customize the agent environment](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-environment),
[Customize the firewall](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/customize-the-agent-firewall),
[Extend with MCP](https://docs.github.com/en/copilot/how-tos/use-copilot-agents/coding-agent/extend-coding-agent-with-mcp),
[Repository instructions](https://docs.github.com/en/copilot/how-tos/configure-custom-instructions/add-repository-instructions).
