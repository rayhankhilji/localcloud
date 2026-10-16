# Security policy

localcloud exposes local servers to the internet, so we take security reports seriously and
appreciate responsible disclosure.

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Report privately through GitHub's private vulnerability reporting:

1. Go to **[Security → Report a vulnerability](https://github.com/rayhankhilji/localcloud/security/advisories/new)**.
2. Describe the issue, its impact, and how to reproduce it (a proof of concept helps a lot).
3. Mention the affected version (`npx localcloud-cli --version`) and component (client, daemon,
   relay, `relay-cloudflare`, MCP server, `init`).

What to expect:

- an acknowledgement within **3 business days**,
- an initial assessment within **7 days**,
- a fix or mitigation plan agreed with you. We aim to release fixes for high-severity issues
  within 30 days, and we'll coordinate the disclosure date with you,
- credit in the advisory and changelog if you want it.

## Supported versions

localcloud is pre-1.0. Security fixes go into the **latest released version** only. Please update
before reporting, if you can.

| Version | Supported |
|---|---|
| latest `0.x` | ✅ |
| older | ❌ |

## Scope

In scope:

- Bypassing `--protect` access keys, `--auth` basic auth, or the relay token
- Taking over or impersonating another user's tunnel name or traffic on a shared relay
- Reading or modifying another tunnel's traffic through the relay
- Crashing or exhausting a relay with small inputs (asymmetric DoS)
- Header-handling flaws that let visitors spoof what the local app sees, beyond what
  [docs/security.md](docs/security.md#headers-and-client-ips) documents
- Ways the daemon or MCP server can be driven by another local user
- `init` writing files outside the target repo or corrupting user content

Out of scope (documented trade-offs, see [docs/security.md](docs/security.md)):

- An unprotected tunnel URL being reachable by anyone who has it
- The relay operator (or a TLS-intercepting egress proxy) being able to see traffic
- Same-origin sharing between tunnels on **cookie-routing** relays
- Volumetric DDoS against a relay
- Abuse of a relay that the operator deliberately runs without a token
- Vulnerabilities in the apps people choose to share

## Running a relay

If you operate a relay, read [docs/security.md](docs/security.md#running-a-public-relay-abuse-and-phishing)
for hardening and abuse handling guidance.
