---
layout: default
title: Getting started
---

# Getting started

Realmwatch runs from a single Linux box. This guide walks through cloning,
installing, first run, daemons, systemd, and the daily update timer.

> **Target**: Python 3.12, Node (for esbuild), Linux with `make`, `curl`,
> `jq`, and `column` available. Tested on Ubuntu 24.04 LTS.

---

## 1. Clone and install

```bash
git clone https://github.com/jphein/realmwatch.git
cd realmwatch

make install
```

`make install` runs:

```bash
pip install -r requirements.txt
npm install
```

Python deps: stdlib `http.server`, `psutil`, `openai` (Azure AI),
`notion-client`, `httpx`, `python-dotenv`.

JS deps: `esbuild` (build-time), `winbox` (runtime window manager).

---

## 2. Build the frontend bundle

```bash
make build
```

This runs `esbuild` over `src/main.js` and writes the minified IIFE bundle
to `realm-map.js`. The output is committed — but the build is fast and
deterministic, so always run it after editing `src/`.

For dev work, `npm run watch` runs esbuild in watch mode (non-minified, auto-rebuild).

---

## 3. Configure environment

Copy `.env.example` to `.env`:

```bash
cp .env.example .env
$EDITOR .env
```

| Variable | Required for | Default |
|---|---|---|
| `HA_TOKEN` | Home Assistant bridge | — |
| `HA_URL` | — | `https://10.0.6.108:8123` (your homelab IP) |
| `NOTION_TOKEN` | Quest + codex sync | — |
| `NOTION_DATABASE_ID` | Quest sync | — |
| `AZURE_AI_API_KEY` | Chat + oracle | — |
| `AZURE_AI_ENDPOINT` | Chat + oracle | — |
| `AZURE_SPEECH_KEY` / `_REGION` | Oracle TTS | — |
| `REALM_PORT` | — | `80` |
| `REALM_DOMAIN` | — | — |

All optional unless you want the matching feature. The server starts fine
with an empty `.env` — it just won't bridge to HA or sync from Notion.

For secret hygiene, the author keeps tokens in a password vault and
populates `.env` at install time:

```bash
echo "HA_TOKEN=$(bw get password 'Home Assistant LLT')" >> .env
```

`.env` is in `.gitignore`. Never commit it.

---

## 4. First run

```bash
make dev
```

This runs `python3 map_server.py` in the foreground. Watch the log:

```
[plugin_loader] discovered 47 plugins
[plugin_loader] dep-sort complete
[plugin_loader] loading: collectd, wifi, events, ha, latency, …
[plugin_loader] all plugins loaded in 1.42s
[map_server] listening on http://0.0.0.0:80
```

Open the map:

```bash
xdg-open http://localhost/realm-map.html
```

Panels should render. The SSE stream should connect (look for `EventSource`
in browser devtools). Click a node to open its detail panel.

> **Port 80** — On Linux, binding to `:80` needs `CAP_NET_BIND_SERVICE`.
> One-time setup with `scripts/enable-port80.sh` grants the capability to
> the Python interpreter. Or run on another port: `REALM_PORT=8080 make dev`.

---

## 5. Install the `realm` CLI

```bash
make cli-install
make cli-doctor      # verify PATH, completion, jq/curl/column, server reach
```

`cli-install` symlinks `scripts/realm` and every `scripts/cli/realm-*.sh`
into `~/.local/bin/`, installs bash + zsh completion, and stamps a
`.realm-version` file. No sudo. Most modern distros put `~/.local/bin/` on
`$PATH` already.

Open a new shell, then:

```bash
realm                # command index
realm status         # GET /status, colored table view
realm watch          # tail SSE events live
realm tags list      # show tag counts
realm topology       # node + connection summary
```

[Full CLI reference →]({{ '/cli.html' | relative_url }})

---

## 6. Sanity checks

```bash
make health                                              # color-coded service check
curl -s http://localhost/status   | python3 -m json.tool
curl -s http://localhost/debug    | python3 -m json.tool   # tables + endpoints
curl -s http://localhost/topology | python3 -m json.tool
realm health
```

If everything is green, you're done with the basic flow.

---

## 7. Optional: daemons

All daemons are **off by default**. Opt in per-service.

### Foreground (recommended for dev)

```bash
make oracle    # python3 oracle_daemon.py --no-voice
make herald    # python3 realm_herald.py
```

### systemd user units (recommended for unattended)

```bash
cp systemd/*.service ~/.config/systemd/user/
systemctl --user daemon-reload
systemctl --user enable --now realm-map-server
systemctl --user enable --now oracle-daemon    # if you want the oracle
systemctl --user enable --now realm-herald      # if you want the herald
```

Five user units ship in `systemd/`: `realm-map-server`, `oracle-daemon`,
`realm-herald`, `realm-launcher`, `realm-theme-watcher`.

To check / tail / disable:

```bash
systemctl --user status realm-map-server
journalctl --user -u realm-map-server -f
systemctl --user disable --now realm-map-server
```

---

## 8. Optional: daily update timer

```bash
make update-all-install     # ~03:00 daily, no sudo
```

This drops `realm-update-all.service` + `.timer` into
`~/.config/systemd/user/` and enables the timer. Fires daily at
approximately 03:00. Logs to `journalctl --user -u realm-update-all`.

`realm update-all` is a two-stage flow:

1. **Katana** (the host you're running on) — via the system-updates plugin's
   runner. APT, Snap, Flatpak, mise, brew, npm, pip-user, firmware, AI CLI
   tools.
2. **Ubuntu fleet** — via `realm ansible-update`. apt + DKMS verification
   + fwupdmgr refresh. Captures `/var/run/reboot-required.pkgs` so the
   summary lists which packages need a reboot.

Disable with:

```bash
make update-all-uninstall
```

---

## 9. Optional: discover the rest of your homelab

If you have more than one Linux host, the auto-discovery flow is one command:

```bash
realm discover-os
```

This SSHes (concurrently — 20 forks, 3s timeout, ~15s for 50 hosts) to every
reachable node, reads `/etc/os-release`, and writes `os` / `os_version` /
`tags` back to topology. After it runs:

```bash
realm tags list      # see what families are present (debian-family, alpine-family, …)
realm tags get oracle
realm netdata-install   # installs Netdata on every Ubuntu host (idempotent)
```

---

## 10. Where to next

- **[Architecture]({{ '/architecture.html' | relative_url }})** — plugin
  system, SSE broker, discovery engine, web workers, key design decisions.
- **[Plugin catalog]({{ '/plugins.html' | relative_url }})** — every
  plugin, what it does, what it integrates.
- **[CLI reference]({{ '/cli.html' | relative_url }})** — every `realm`
  subcommand and flag.
- **[CONTRIBUTING](https://github.com/jphein/realmwatch/blob/master/CONTRIBUTING.md)**
  — add a plugin, add a CLI verb, submit a PR.
- **[Issue tracker](https://github.com/jphein/realmwatch/issues)** —
  open roadmap.

---

## Troubleshooting

**`make dev` exits with "Permission denied" on port 80.**
Run `scripts/enable-port80.sh` to grant `CAP_NET_BIND_SERVICE`, or set
`REALM_PORT=8080`.

**Browser shows the map but no live data.**
SSE may be blocked by a reverse proxy. Check devtools — the
`/sse` request should stay open. If it 504s after 30s, your proxy is
killing long-lived connections.

**`realm` says command not found.**
`~/.local/bin/` may not be on `$PATH`. Add it to your shell rc, or check
`make cli-doctor` output.

**`realm watch` shows nothing.**
There may genuinely be no events. Trigger one: `realm event post info "test"`.

**Plugins load but a panel is missing.**
Restart `map_server.py`. There's no hot reload.

**`realm.db` is locked.**
WAL mode usually prevents this — but a stuck transaction can wedge it.
Stop the server, check for stale `realm.db-shm` / `realm.db-wal` files,
restart.

If something else is wrong, [open an issue](https://github.com/jphein/realmwatch/issues/new).
