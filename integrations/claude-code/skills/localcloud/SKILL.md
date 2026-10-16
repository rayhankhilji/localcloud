---
name: localcloud
description: Share a local dev server (localhost:3000, :5173, …) at a public HTTPS URL with localcloud. Use whenever you start a web/dev server the user should open, when the user asks for a preview link, or when a localhost link would be unreachable because you are running in a cloud sandbox.
---

# localcloud — share localhost from a cloud sandbox

You are probably running somewhere the user's browser can't reach (a cloud VM or container).
A `http://localhost:…` link is useless to them. localcloud gives any local port a public HTTPS URL.

## Share a dev server

1. Start the server as usual (`npm run dev`, `python -m http.server 8000`, …). Don't change its host or port.
2. Share the port — this returns immediately and prints the URL:

   ```sh
   npx -y localcloud-cli start 5173
   ```

3. Give the user the printed `https://…` URL. Mention it again whenever you restart the server; the URL stays the same.

Alternatives:

- `npx -y localcloud-cli start` (no port) — auto-share every dev server that starts listening from now on.
- `npx -y localcloud-cli run -- npm run dev` — run a command in the foreground and share whatever port it opens.
- `npx -y localcloud-cli url 5173` — print just the URL (shares it if needed). `--json` gives machine-readable output.
- MCP tools, if the `localcloud` MCP server is connected: `share_port`, `get_url`, `list_shared`, `stop_sharing`, `auto_share`.

## Manage

- `npx -y localcloud-cli ls` — what is shared, and whether the relay connection is up.
- `npx -y localcloud-cli stop 5173` — stop sharing one port; `npx -y localcloud-cli stop` — stop everything.
- `--protect` makes a private link (the URL carries an access key); `--name my-app` picks the subdomain.

## When it fails

- "needs a relay": no relay is configured. Ask the user for their relay URL; then pass `--relay <url>`,
  set `LOCALCLOUD_RELAY`, or commit `{"relay": "https://…"}` as `localcloud.json`. Don't invent a relay.
- "blocked by the network policy" / HTTP 403 / 407: the sandbox's egress allowlist doesn't include the relay's domain.
  Tell the user to add it in their agent environment's network settings.
- Anything else: run `npx -y localcloud-cli doctor` and report its output. `npx -y localcloud-cli logs` shows the background daemon's log.
- The page loads but shows "waiting for your server": nothing is listening on that port yet — start the server.

No framework config is needed: the Host header is rewritten to `localhost`, so Vite/Next/webpack host checks pass,
and HMR websockets work through the tunnel.
