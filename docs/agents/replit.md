# Replit Agent

Replit already gives your app's webview a public `*.replit.dev` URL, so you often don't need
localcloud there. It's useful when you want the same workflow and URL shape across every agent you use,
a stable `--name`, private `--protect` links, or a port Replit doesn't expose.

## 1-minute setup

```sh
npx -y localcloud-cli init --relay https://relay.example.com --agents replit
```

Writes the localcloud block into `replit.md` (Replit Agent reads it from the project root) and
`AGENTS.md`.

## Auto-share

In `.replit` ([`integrations/replit/replit-snippet.toml`](../../integrations/replit/replit-snippet.toml)):

```toml
run = "npx -y localcloud-cli run -- npm run dev"
```

`localcloud run` starts your dev server and shares whatever port it opens, printing the URL in the console.
Alternatively `onBoot = "npx -y localcloud-cli start"` starts the background daemon when the Repl boots
(unverified that background processes survive `onBoot`).

## MCP

Not applicable.

## Allowlisting

Replit workspaces have outbound internet access; nothing to configure.

## Troubleshooting

`npx -y localcloud-cli doctor` in the Shell tab.

Sources: [Configuring a Repl](https://docs.replit.com/replit-workspace/configuring-repl),
[replit.md](https://docs.replit.com/core-concepts/agent/replit-dot-md).
