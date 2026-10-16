# Contributing to localcloud

Thanks for helping. Bug reports, docs fixes, compatibility reports ("works / doesn't work on
platform X"), and code are all welcome.

- [Ground rules](#ground-rules)
- [Development setup](#development-setup)
- [Running things locally](#running-things-locally)
- [Project layout](#project-layout)
- [Code style](#code-style)
- [Tests](#tests)
- [Changing the wire protocol](#changing-the-wire-protocol)
- [Pull requests](#pull-requests)
- [Releases](#releases)

## Ground rules

- Be kind. This project follows the [Code of Conduct](CODE_OF_CONDUCT.md).
- **Security issues go through private reporting**, not public issues. See [SECURITY.md](SECURITY.md).
- For anything bigger than a bug fix, such as a new command, a protocol change or a new dependency,
  please open an issue first so we can agree on the approach.

## Development setup

You need Node.js **20 or newer** (CI also tests newer LTS releases) and git.

```sh
git clone https://github.com/rayhankhilji/localcloud
cd localcloud
npm install          # installs the single runtime dependency (ws)
npm test
```

There is no build step. `bin/localcloud.js` runs the source directly:

```sh
node bin/localcloud.js --help
npm link             # optional: puts `localcloud` on your PATH, pointing at your checkout
```

## Running things locally

Run a relay and a client on one machine. `localtest.me` and its subdomains resolve to `127.0.0.1`,
which makes subdomain routing work without DNS changes:

```sh
# terminal 1: a relay with http:// subdomain URLs
node bin/localcloud.js relay --port 8080 --domain localtest.me:8080 --http

# terminal 2: something to share
python3 -m http.server 3000

# terminal 3: share it
export LOCALCLOUD_RELAY=http://localhost:8080
node bin/localcloud.js 3000
# open the printed http://<name>.localtest.me:8080
```

Useful variations:

- `--transport http` exercises the long-poll fallback.
- Leave out `--domain` to test cookie routing (`/__localcloud/t/<id>` URLs).
- `LOCALCLOUD_HOME=$(mktemp -d)` gives you an isolated daemon that won't touch your real
  `~/.localcloud`.
- `LOCALCLOUD_DEBUG=1` prints stack traces.
- `localcloud doctor` against your local relay is a quick smoke test.

To test proxy support, run any HTTP proxy that supports `CONNECT` (for example
[`mitmproxy`](https://mitmproxy.org/) to also test TLS interception with
`NODE_EXTRA_CA_CERTS=~/.mitmproxy/mitmproxy-ca-cert.pem`) and set `HTTPS_PROXY`.

## Project layout

```text
bin/localcloud.js        CLI entry point (Node version check → src/cli.js)
src/
  cli.js                 argument parsing, commands, help text
  config.js              settings resolution (flags → env → localcloud.json → ~/.localcloud)
  daemon.js              background daemon + its unix-socket JSON API
  watch.js               listening-port detection (/proc/net/tcp*, lsof)
  init.js                `localcloud init` (AGENTS.md, CLAUDE.md, hooks, MCP configs, rules files)
  mcp.js                 stdio MCP server
  net.js                 HTTPS_PROXY / NO_PROXY / CONNECT / CA bundle handling
  protocol.js            frame + batch encoding, header helpers
  flow.js                per-stream flow control
  names.js               tunnel name generation and validation
  ui.js                  terminal colors, banner, request log lines
  client/
    client.js            relay connection, reconnects, tunnel bookkeeping
    transports.js        WebSocket and HTTPS long-poll client transports
    forward.js           replays requests against the local server, header rewriting
  relay/
    server.js            the relay: transports, sessions, routing, access control
    pages.js             waiting / error / landing HTML pages
test/                    node:test suites
docs/                    user and contributor documentation
deploy/                  relay deployment configs (Fly, Render, Railway, compose + Caddy, k8s, nginx, systemd)
relay-cloudflare/        relay implementation for Cloudflare Workers
examples/                sample apps (Vite, Next.js, Express)
integrations/            ready-made per-tool configs (Claude Code, Codex, Cursor, Copilot, Devin, …)
site/                    landing page (GitHub Pages)
Dockerfile               relay container image
```

How the pieces fit together is explained in [docs/how-it-works.md](docs/how-it-works.md), and the
wire format in [docs/protocol.md](docs/protocol.md).

## Code style

- **Plain modern JavaScript, ES modules.** No TypeScript, no transpiler, no bundler, no build step.
  JSDoc types are welcome where they help.
- **Minimal dependencies.** The runtime depends only on `ws`. A new runtime dependency needs a
  strong reason: localcloud runs through `npx` in sandboxes on every session, so install size and
  supply-chain surface matter. Dev dependencies should be rare too, and the test suite uses
  `node:test`.
- Use Node built-ins with the `node:` prefix (`import fs from 'node:fs'`).
- Keep the code working on Node 20. Avoid APIs newer than that, or feature-detect them.
- Formatting: 2-space indent, single quotes, semicolons, trailing commas, a line width of about
  160. Prettier with those settings matches the existing code.
- Errors shown to users should say **what to do next**, not just what failed. See `friendly()` in
  `src/cli.js`.
- Never print secrets (tokens, access keys, basic-auth passwords) to logs.
- Keep the terminal output stable. Agents and scripts parse it, and `--json` shapes are a public
  interface ([docs/cli.md](docs/cli.md#json-output)).

## Tests

```sh
npm test                                  # all suites (node --test, run serially)
node --test test/some-file.test.js        # one file
```

- Tests use `node:test` and `node:assert`, and spin up real relays and clients on ephemeral ports.
  Prefer end-to-end tests that go over a real socket to heavy mocking.
- Tests must not need internet access, and must clean up servers, daemons and temp directories
  (use `LOCALCLOUD_HOME` pointing at a temp directory).
- A bug fix should come with a test that fails without it.

## Changing the wire protocol

[docs/protocol.md](docs/protocol.md) is the spec, and other implementations (such as
`relay-cloudflare/`) depend on it.

- Backwards-compatible additions (new optional JSON fields, new frame types that old peers ignore)
  are fine. Update `docs/protocol.md` in the same PR.
- Incompatible changes require bumping `PROTOCOL_VERSION` in `src/protocol.js` and a migration
  plan, because old clients would be rejected by new relays. Open an issue first.

## Pull requests

- Keep each PR focused on one change. Small PRs get reviewed faster.
- Update the docs when behavior, flags or output change: `README.md`, `docs/cli.md`,
  `src/cli.js` help text.
- Add a line to the `Unreleased` section of [CHANGELOG.md](CHANGELOG.md) for anything user-visible.
- Make sure `npm test` passes.
- Fill in the PR template, including which platforms or agents you tested on.

## Releases

Maintainers handle releases: bump `version` in `package.json`, move `Unreleased` in the changelog
to the new version, tag `vX.Y.Z`, and publish to npm. The relay image is built from the root
`Dockerfile`.
