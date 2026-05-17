# Security Policy

Realmwatch is a homelab tool that runs unauthenticated on a LAN. The
threat model is "shared local network with trusted humans," not "exposed
to the public internet." Please do not run it on a host with a public IP
without a reverse proxy that adds auth.

## Reporting an issue

If you find something that an unprivileged LAN user could abuse, please
report it privately rather than opening a public issue. Either:

- Open a private security advisory on GitHub:
  <https://github.com/jphein/realmwatch/security/advisories/new>
- Or email JP at the address in the repo's git history.

Include the realmwatch commit hash you tested against (`realm --version`
or `git rev-parse HEAD`), a minimal repro, and your handle if you'd like
credit in the changelog.

## Response

I'll acknowledge within ~7 days. Realistic patch turnaround depends on
severity; nothing here is enterprise-supported, but I do take real issues
seriously. Fixes land on `master` (the only supported branch) with an
advisory note in the CHANGELOG.

## Scope

In scope: anything that lets a LAN user trigger writes or reads they
shouldn't have via the realmwatch HTTP API, the `realm` CLI, or any of
the bundled plugins in `plugins/`.

Out of scope:

- The intentional design where the HTTP API is open on the LAN — that's
  documented behaviour, not a vulnerability. If you want auth, put a
  reverse proxy in front.
- Issues that require root on the realm host already.
- Third-party plugins that don't ship in this repo.
