<!-- Thanks for contributing to localcloud! Please read CONTRIBUTING.md if you haven't yet. -->

## What and why

<!-- What does this PR change, and what problem does it solve? Link the issue: "Fixes #123". -->

## How it was tested

<!-- Commands you ran, and which environments you tried. -->

- [ ] `npm test` passes
- [ ] Tested manually (describe below)

Environments tried (check all that apply):

- [ ] Local machine (macOS / Linux / Windows)
- [ ] Behind an HTTPS proxy / TLS-intercepting proxy
- [ ] Long-poll transport (`--transport http`)
- [ ] A cloud agent sandbox (which one?)

## Checklist

- [ ] Docs updated where behavior, flags or output changed (`README.md`, `docs/`, `src/cli.js` help text)
- [ ] `CHANGELOG.md` has an entry under **Unreleased** for user-visible changes
- [ ] No new runtime dependencies (or the PR explains why one is needed)
- [ ] Wire protocol unchanged, or `docs/protocol.md` updated (and `PROTOCOL_VERSION` bumped if incompatible)
- [ ] `--json` output shapes unchanged, or the change is called out above
