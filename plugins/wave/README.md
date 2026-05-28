# Wave Terminal plugin — Tide Singers

Adaptive TUI monitors for use as [Wave Terminal](https://www.waveterm.dev/) blocks, plus a one-shot installer that spawns them with sensible titles.

## Verbs

```
realm wave bandwidth        Live WAN bandwidth (gatekeeper br-lan.38)
realm wave palace           palace-daemon health + drawer count
realm wave daemon           tail palace-daemon journal on familiar
realm wave install [name]   spawn the TUI(s) as Wave blocks via `wsh run`
realm wave list             list available TUIs
```

## TUIs

Each TUI is a self-contained Python script under `tuis/`. They:

- Use `rich.live` for non-flicker rendering.
- Adapt to terminal width and height: header drops fields when narrow, sparklines fill available width, extra context appears when tall.
- Auto-grow history buffers up to `MAX_HISTORY` so resizing wider never shows truncated history.
- Mark themselves stale (red border) if their data source goes quiet.

Sources:

- `bandwidth` — calls `realm collectd show --json`, reads `gatekeeper.interfaces.br-lan.38.{rx,tx}_bps`. Updates ~every 30s (collectd interval); polls at 2s.
- `palace` — POSTs to `http://familiar:8085/mcp` (`mempalace_status`). Auth via `PALACE_API_KEY` from `~/.config/palace-daemon/env` on familiar.
- `daemon` — `ssh jp@familiar journalctl -fu palace-daemon`. Long-lived; reconnects on drop.

## Installer

`realm wave install` runs `wsh run -c '<verb-cmd>'` for each TUI and titles the block via `wsh setmeta -b <id> 'frame:title=...'`. Single Wave block id is printed per spawn so it's easy to script around.

Requires `wsh` on PATH (Wave Terminal's CLI helper). Detection is done at install time; the underlying TUIs don't depend on Wave at all and will run in any terminal.
