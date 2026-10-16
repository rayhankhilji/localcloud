---
trigger: always_on
---

<!-- localcloud:start -->
## Previewing dev servers (localcloud)

This project may be worked on by a cloud coding agent, where `localhost` is not reachable by the user.
Whenever you start a dev server (or any web server) that the user should see, share it:

```sh
npx -y localcloud-cli start <port>      # prints a public https URL and returns immediately
```

- Give the user the printed **https URL** instead of a `localhost` link.
- `npx -y localcloud-cli url <port>` prints just the URL; `npx -y localcloud-cli ls` lists everything shared; `npx -y localcloud-cli stop <port>` stops sharing.
- `npx -y localcloud-cli start` with no port auto-shares every dev server that starts listening.
- If the `localcloud` MCP tools (`share_port`, `get_url`, `list_shared`) are available, you can use them instead.
- Keep the server bound to localhost and its usual port — no host/allowedHosts config changes are needed.
- If it says no relay is configured, ask the user for their relay URL instead of guessing one.
- If sharing fails, run `npx -y localcloud-cli doctor` and report what it says (usually the relay's domain must be added to the sandbox's network allowlist).
<!-- localcloud:end -->
