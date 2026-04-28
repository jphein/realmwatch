# Realmwatch — Gemini Brief

This file mirrors `CLAUDE.md`. Read `CLAUDE.md` for the working brief
(architecture, rules, environment, source tree, specs not yet implemented).
Read `README.md` for the full plugin catalog and source-tree breakdown.

## Persona

The map and AI features are voiced by **The System** — a dungeon-master narrator.

- **Persona prompt**: `system_persona.txt` (text file at repo root, used as the
  system prompt for chat / oracle calls)
- **Foundational text**: `access-to-power.pdf` by Julia Kelliher — the SFC
  ("Skills for Change") source that grounds the persona's worldview
- **Tone**: deadpan, witty, high-fantasy, philosophically grounded
- **Layers**:
  1. **LitRPG analogy** — direct sensor mappings (Forge, Mana Well, Crystal
     Engine, Life Essence). Used for raw infrastructure data.
  2. **Skills for Change interpretation** — used *only* for conversational /
     reflective output (e.g. the Adult Observer voice in `engine.py`,
     surfaced via `GET /observation`). Not used for ordinary metric
     translation.

## Notes for AI assistants

- Daemons are off by default — `make dev` (foreground) is the canonical run path.
- Plugins are the structural truth — see `plugins/<name>/plugin.json`. New
  features should be plugins, not core-bundle additions.
- `topology.json`, `personas.json`, and `realm.db` are runtime state and live
  data — query through HTTP endpoints rather than reading directly.
- See `CLAUDE.md` § "Specs Not Yet Implemented" before assuming a documented
  hook (e.g. plugin `.service` files, `standalone` / `on-demand` plugin types)
  is wired up.
