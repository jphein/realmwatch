---
layout: default
title: Tide Singers — the Wave plugin
---

# The Tide Singers

*"The Realm speaks in many tongues. The Heralds shout from the battlements,
the Oracle whispers in the dark, the Light Weaver paints the air with
colour. The Tide Singers — these are the quiet ones. They hum the pulse
of the kingdom into a corner of your terminal, and you listen the way
you'd listen to the sea: not for words, but for shape."*

— 🌊 `plugins/wave/` · fantasy name **Tide Singers** · icon **🌊**

---

## What it is

A small, focused plugin that ships **three adaptive terminal monitors**
designed to live as panes inside [Wave Terminal](https://www.waveterm.dev/),
plus a one-shot installer that spawns them as named Wave blocks via
`wsh`. The TUIs themselves are pure Python and don't depend on Wave —
they'll run in any terminal — but the install verb arranges them into a
tidy little dashboard inside a Wave tab so you can see WAN bandwidth,
mempalace health, and the palace-daemon journal at a glance.

Think of it as the Realm's small-screen scrying glass — the monitors
you'd want pinned in a corner while you work, distinct from the full
SVG map at `realm-map.html` and complementary to the AI oracle. Where
the herald *speaks* and the map *shows*, the Tide Singers *hum* — a
quiet running pulse of three things JP looks at constantly.

---

## The three TUIs

Each TUI is a self-contained Python script under `plugins/wave/tuis/`,
built with [rich](https://github.com/Textualize/rich) for non-flicker
live rendering. They share a small set of design rules:

- **Adaptive layout.** Header drops fields right-to-left as width shrinks.
  Sparklines stretch to fill available width. Extra context — long-window
  buckets, per-direction stats columns — appears only when there's
  vertical and horizontal budget for it.
- **Growing memory.** History buffers auto-grow up to a generous cap
  (~2 hours at 2 s refresh), so making the window wider never reveals
  truncated history. Resize, and the past you'd already collected comes
  back into view.
- **Staleness as a first-class state.** If the data source goes quiet
  longer than the TUI considers safe, the border and header turn red.
  No silent dead panes.
- **Pure Python.** No `wsh`, no Wave runtime, no required environment
  beyond the realm's own venv. Wave is the *preferred* host but not the
  only one.

### 🌊 `bandwidth` — the WAN pulse

```
realm wave bandwidth
```

Live WAN bandwidth scraped from gatekeeper's `br-lan.38` interface
(VLAN 38, the WAN trunk) via `realm collectd show --json`. Big colour-
coded numbers in the middle (green / yellow / red by magnitude), a pair
of sparklines underneath, and — when there's room — a long-window
30-second-bucket pair and flanking columns of avg / peak / total
transfer.

```text
╭─ gatekeeper ←→ br-lan.38   WAN trunk · VLAN 38    up 17d 4h   load 0.42   8.8.8.8 8.3ms   temp 47°C ──╮
│                                                                                                       │
│        avg  4.91 Mbps      ↓ rx                ↑ tx       4.05 Mbps  avg                              │
│       peak 88.20 Mbps    24.3 Mbps           1.82 Mbps   88.20 Mbps peak                              │
│      total   3.4 GB                                          412.8 MB total                           │
│                                                                                                       │
│  rx  ▁▂▁▁▂▃▄▅▆▇█▇▆▅▄▃▂▁▂▁▁▂▃▄▅▆▇█▇▅▃▂▁                                                                │
│  tx  ▁▁▂▂▃▃▂▂▁▁▂▃▄▄▃▂▁▁▂▃▂▁▁▂▂▁▁▁▂▁                                                                  │
│      30s buckets · 32m window                                                                         │
│  RX  ▁▁▂▂▃▄▅▆▇▆▅▄▃▂▁▁▂▃▄▅▆▇                                                                          │
│  TX  ▁▁▂▂▃▃▂▂▁▁▂▂▁                                                                                   │
│                                                                                                       │
│                                                            sample 4s ago  ·  fetch 1s ago  ·  refresh 2s │
╰───────────────────────────────────────────────────────────────────────────────────────────────────────╯
```

- **Source**: `realm collectd show --json` → `gatekeeper.interfaces.br-lan.38.{rx,tx}_bps`
- **Polled**: every 2 seconds; collectd itself updates ~every 30 s so adjacent
  samples often repeat (the sparkline shows shape, not sample-rate fidelity).
- **Stale**: after 120 s without a fresh sample — border + header go red.
- **Extras shown when there's room**: gatekeeper uptime, 1-minute load,
  8.8.8.8 ping + drop, CPU temp, conntrack count.

### 🌊 `palace` — the mempalace status

```
realm wave palace
```

Health probe for the **palace-daemon** running on `familiar` — the
machine that backs the realm's MCP-served memory palace. Polls
`http://familiar:8085/mcp` every 5 seconds, calling `tools/list` for
reachability and `mempalace_status` for drawer/wing counts.

```text
╭─ palace-daemon  http://familiar:8085   ● OK ─────────────────────────╮
│                                                                       │
│      drawers   14,827                                                 │
│        wings   18                                                     │
│    mcp tools   22                                                     │
│      last ok   3s ago                                                 │
│      message   familiar                                               │
│                                                                       │
│                                       refresh 5s   ·   ctrl-c to exit │
╰───────────────────────────────────────────────────────────────────────╯
```

Status pill on the top-right encodes a small state machine:

| State | Meaning |
|---|---|
| `● init…` | First sample not yet collected. |
| `● OK` | Daemon reachable, `mempalace_status` returned a populated palace. |
| `● STALE` | Reachable, but the last good sample was a while ago. |
| `● NO PALACE` | Daemon up, but the underlying postgres reports an empty palace. The TUI also runs a *direct* `psql` count over SSH as a reality-check — distinguishing "daemon misconfigured" from "postgres truly empty." |
| `● AUTH FAIL` | HTTP 401 — bad or missing API key. |
| `● DOWN` | Unreachable (network, daemon crashed, port closed). |
| `● ERROR` | The daemon responded, but the response didn't parse. |

The API key is auto-fetched once at startup over SSH from
`~/.config/palace-daemon/env` on familiar (`PALACE_API_KEY=…` line),
cached for the lifetime of the process. Set `PALACE_API_KEY` in your
environment to skip the SSH bounce.

### 🌊 `daemon` — the journal tail

```
realm wave daemon
```

Plain colour-tinted `journalctl -fu palace-daemon` streamed from
familiar over SSH. Banner at the top, log lines as they arrive, and
**automatic reconnect with exponential backoff** when the SSH session
drops — so a flaky network or a daemon restart doesn't kill the pane.

```text
======================================================================
  palace-daemon journal — jp@familiar :: palace-daemon
======================================================================

2026-05-27T11:42:08+0100 palace-daemon[1834]: kg_writethrough: 12 facts/min
2026-05-27T11:42:38+0100 palace-daemon[1834]: hnsw: rebuild skipped (stable)
2026-05-27T11:43:08+0100 palace-daemon[1834]: kg_writethrough: 8 facts/min
2026-05-27T11:43:08+0100 palace-daemon[1834]: ingest: 4 new drawers (wing=ha)

[journal] ssh exited with code 255; reconnecting in 1s
[journal] ssh exited with code 255; reconnecting in 2s

======================================================================
  palace-daemon journal — jp@familiar :: palace-daemon
======================================================================
```

Backoff doubles each failed attempt up to 30 s, then plateaus. Ctrl-C
exits cleanly.

---

## Installing as Wave blocks

Drop `realm wave install` inside a Wave Terminal tab and it spawns
each TUI as its own Wave block, titled appropriately, all of them
landing in the active tab:

```
$ realm wave install
✓ spawned daemon        block:01HF3X7P9KMNB2EVC4Y5Z6W8A1  "daemon journal (familiar)"
✓ spawned palace        block:01HF3X7PA2CKQRT5XYW7B3D9E0  "mempalace status"
✓ spawned bandwidth     block:01HF3X7PB4VLMP6ZAW8Q3C5R7Y  "WAN bandwidth (gatekeeper br-lan.38)"
```

The installer drives Wave's `wsh` CLI:

- `wsh run -c 'realm wave <verb>'` creates a new block with the TUI
  as its command.
- `wsh setmeta -b <id> 'frame:title=…'` writes a friendly title on the
  block frame.

You can spawn just one:

```bash
realm wave install bandwidth     # only the WAN pane
```

Spawn order is `daemon → palace → bandwidth` so the layout falls out
the same way each time — adjust the resulting block sizes once and the
arrangement persists with the Wave tab.

Inside a Wave Terminal block, `WAVETERM_TABID` is exported automatically;
the installer detects its absence and warns that blocks will land in
whichever tab Wave considers active.

### Requirements for the install verb only

- `wsh` on PATH — install Wave Terminal from [waveterm.dev](https://www.waveterm.dev/);
  `wsh` ships with it.
- The TUIs underneath have no Wave dependency, so the bandwidth, palace,
  and daemon scripts run anywhere Python and (for palace/daemon) SSH
  can reach familiar.

---

## Listing the available TUIs

```
$ realm wave list
VERB          DESCRIPTION
bandwidth     Live WAN bandwidth — adaptive sparklines, 30s long-window pair
daemon        tail palace-daemon journal on familiar (auto-reconnect)
palace        palace-daemon health + drawer/wing counts via MCP
```

---

## Environment variables

| Variable | Default | Used by |
|---|---|---|
| `PALACE_DAEMON_URL` | `http://familiar:8085` | `palace` TUI |
| `PALACE_API_KEY` | *(auto-fetched from familiar)* | `palace` TUI |
| `PALACE_DAEMON_HOST` | `jp@familiar` | `palace` + `daemon` TUIs |
| `PALACE_DAEMON_UNIT` | `palace-daemon` | `daemon` TUI |

All are optional in normal use — the defaults match JP's homelab and the
TUIs will pull the API key over SSH on first launch.

---

## Design notes

A few things worth knowing if you're tempted to add a fourth Tide Singer:

- **One screen, one pulse.** Each TUI watches *one* thing and renders
  it with as much resolution as the terminal will allow. Don't bundle
  metrics — spawn another block.
- **Width-first responsive design.** Wave blocks resize routinely.
  Every TUI handles `SHUTDOWN_*` cleanly and `shutil.get_terminal_size()`
  is queried each render — there's no need for SIGWINCH handling because
  rich repaints from scratch every tick.
- **No buffered drift.** Polled TUIs (`bandwidth`, `palace`) call
  `live.update(current_render())` after every sample; never let
  rich's auto-refresh be the source of new data. Otherwise samples
  silently fall behind the wall clock.
- **Reality-checks where it counts.** The palace TUI doesn't trust the
  daemon's "no palace found" response on its own — it runs a `psql`
  drawer count over SSH and shows it next to the daemon's answer. The
  same pattern (independent verification of the thing being monitored)
  is welcome for future TUIs.

A richer pure-stdlib ANSI renderer is in progress — gruvbox palette,
half-block progress bars, wave-shaped banners, and per-terminal
responsive tiers — sketched at
[`familiar.realm.watch/ops/scripts/wave-block.py`](https://github.com/jphein/familiar.realm.watch).
The Tide Singers will consolidate onto it once it's ready, but for now
the rich-based renders above are what `realm wave …` actually launches.

---

## Source

- Plugin manifest: [`plugins/wave/plugin.json`](https://github.com/jphein/realmwatch/blob/master/plugins/wave/plugin.json)
- CLI dispatcher: [`plugins/wave/cli`](https://github.com/jphein/realmwatch/blob/master/plugins/wave/cli) (bash, Method A)
- TUIs:
  - [`plugins/wave/tuis/bandwidth.py`](https://github.com/jphein/realmwatch/blob/master/plugins/wave/tuis/bandwidth.py)
  - [`plugins/wave/tuis/palace_status.py`](https://github.com/jphein/realmwatch/blob/master/plugins/wave/tuis/palace_status.py)
  - [`plugins/wave/tuis/daemon_log.py`](https://github.com/jphein/realmwatch/blob/master/plugins/wave/tuis/daemon_log.py)
- Plugin readme: [`plugins/wave/README.md`](https://github.com/jphein/realmwatch/blob/master/plugins/wave/README.md)

---

[← Back to plugin catalog](plugins.html)
&nbsp;·&nbsp;
[CLI reference](cli.html)
