# Wave Terminal plugin — Tide Singers

Adaptive TUI monitors for use as [Wave Terminal](https://www.waveterm.dev/) blocks, plus a one-shot installer that spawns them with sensible titles.

## Two flavours of verb

### Hardcoded launchers (`plugins/wave/tuis/` + `plugins/wave/blocks/*-launcher.py`)

| Verb | Source | Notes |
|------|--------|-------|
| `bandwidth` | `realm collectd show --json`, reads `gatekeeper.interfaces.br-lan.38.{rx,tx}_bps` | rich-based, 2s poll over a 30s collectd window |
| `palace` | POST `http://familiar:8085/mcp` (`mempalace_status`); auth via `PALACE_API_KEY` | rich-based |
| `daemon` | `ssh jp@familiar journalctl -fu palace-daemon` | rich-based, long-lived reconnect loop |
| `backfill` | `python3 blocks/kg-extract-poll.py` → wave-block `render_backfill` | progress bar + ETA + multi-worker sparklines |
| `sysmon` | `bash blocks/familiar-sysmon.sh` (ssh → `sysmon-collect.py` on familiar) | wave-block custom mode |
| `kgops` | `bash blocks/familiar-kgops.sh` (ssh → `kgops-collect.py` on familiar) | wave-block custom mode |
| `benchmark` | `python3 blocks/benchmark-poll.py` → wave-block `slate` mode | SME memory-system benchmark slate + live progress |

### Manifest-discovered

Any plugin can register a wave TUI by adding a `wave` block to its `plugin.json`. The wave plugin's dispatcher calls `blocks/discover.py` at startup and merges the discovered verbs into the dispatch table — **no launcher file needed**.

Currently shipping manifests:

| Plugin | Verb | Cmd | Interval |
|--------|------|-----|----------|
| `latency` | `latency` | `realm latency show` | 30s |
| `firewall` | `firewall` | `realm firewall show` | 60s |
| `wifi` | `wifi` | `realm wifi aps` | 60s |
| `ha` | `energy` | `realm ha energy` | 30s |
| `system-updates` | `updates` | `realm system-updates list` | 120s |
| `herald` | `herald` | `realm herald status` | 30s |
| `maintenance` | `maintenance` | `realm maintenance active` | 60s |

## Adding a wave verb to your plugin

Drop a `wave` block at the top level of your plugin's `plugin.json`:

```json
{
  "name": "myplugin",
  ...,
  "wave": {
    "verb":     "myplugin",
    "title":    "My Plugin Block Title",
    "summary":  "Short description for `realm wave list`",
    "cmd":      "realm myplugin show",
    "mode":     "custom",
    "interval": 30
  }
}
```

Fields:

- **`verb`** — the subcommand name (`realm wave <verb>`). Must be unique across all plugins; collisions with hardcoded verbs are ignored with a warning.
- **`title`** — title shown in the Wave block frame.
- **`summary`** — one-line description for `realm wave list`.
- **`cmd`** — shell command that emits a single-line JSON object every poll. `realm <something> show` is the typical pattern; any command works.
- **`mode`** — `custom` (auto-detect numeric/string fields → metric rows with sparklines) or `backfill` (progress bar + ETA + multi-worker template; expects `parse_backfill_status`-shaped JSON).
- **`interval`** — poll cadence in seconds.

A plugin with multiple wave TUIs can declare an array of these blocks:

```json
"wave": [
  { "verb": "myplugin-foo", ... },
  { "verb": "myplugin-bar", ... }
]
```

## Renderer (`blocks/wave-block.py`)

Pure-stdlib Python 3.10+, ~900 lines, zero deps. Tiered layout (tiny / narrow / medium / wide) that reflows on `SIGWINCH`. Gruvbox palette, half-block progress precision, sparklines from history buffers, EMA-smoothed rate, wave-banner border.

- **`custom` mode** — runs an arbitrary JSON-emitting command at the given interval; auto-detects numeric vs string fields and renders them as paired metric rows.
- **`backfill` mode** — bespoke layout: large progress bar, ETA, rate sparkline, entity-delta bar chart at wide widths.
- **`host` mode** — per-host system snapshot: gold percent bars (RAM/swap/disk), GPU rows, load + temp sparklines, network, identity footer.
- **`slate` mode** — structured benchmark slate: a header completeness bar, one row per benchmark with a status sigil + inline metric chips + a dim blurb, and a compact structural-category strip. Consumes a structured payload (not auto-detected fields) — see "Benchmark slate" below.

The hardcoded launchers in `blocks/*-launcher.py` are tiny `os.execv` shims that hand off to `wave-block.py` with the right flags. The manifest-driven path skips the launcher and execs `wave-block.py` directly from the dispatcher.

## Benchmark slate (`realm wave benchmark`)

A read-only Wave block over the SME memory-system benchmark slate. It shows
the slate (LongMemEval, LoCoMo, BEAM, competitor head-to-head, …) plus the
SME structural categories, each with a status sigil and live metrics.

The data source is a small JSON status file that the SME eval runs write.
`blocks/benchmark-poll.py` resolves it (first hit wins):

1. `$REALM_BENCHMARK_SLATE`
2. `~/.realmwatch/benchmark-slate.json`  ← SME runs write here
3. `blocks/benchmark-slate.example.json` ← shipped read-only fallback

`render_slate` (in `renderer.py`) draws it. Status sigils: `◆ done`,
`◈ partial`, `◐ in_progress`, `○ pending`, `✕ blocked`. The header bar is a
weighted completeness fraction (done=1.0, partial=0.5, in_progress=0.33).

### Schema — `realmwatch-benchmark-slate/v1`

```json
{
  "title": "SME Benchmark Slate",
  "updated": "2026-05-29T23:00:00Z",
  "benchmarks": [
    {
      "id": "longmemeval",
      "label": "LongMemEval",
      "status": "done",
      "blurb": "long-horizon conversational recall",
      "metrics": [
        {"name": "R@5", "value": 0.927, "kind": "fraction"},
        {"name": "oracle-QA ceiling", "value": 0.868, "kind": "fraction"}
      ]
    }
  ],
  "structural": [
    {"id": "cat4", "label": "Cat 4 · B-cubed", "status": "done"}
  ]
}
```

- **`status`** — `done` | `partial` | `in_progress` | `pending` | `blocked`.
- **`metric.kind`** — `fraction` (rendered `×100 %`), `number`, or `pending`
  (value `null` → dim em-dash).
- **`updated`** — ISO-8601; shown in the footer as a freshness stamp. SME
  runs should rewrite it on every status write.

The shipped `benchmark-slate.example.json` doubles as the schema reference
and the "nothing wired yet" default, so a fresh checkout still renders a
sensible slate.

## Installer

`realm wave install` runs `wsh run -c '<verb-cmd>'` for each TUI and titles the block via `wsh setmeta -b <id> 'frame:title=...'`. Single Wave block id is printed per spawn so it's easy to script around. With no argument, it spawns every hardcoded verb plus every discovered manifest verb in turn.

Requires `wsh` on PATH (Wave Terminal's CLI helper). Detection is done at install time; the underlying TUIs don't depend on Wave at all and will run in any terminal.
