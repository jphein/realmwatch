# Codex source-of-truth investigation

**Date:** 2026-05-27
**Author:** nebula (dream team)
**Status:** investigation + applied fix

## Problem

The 2026-05-27 "stale-stats sweep" edited three codex pages to replace stale
"MCP game servers" / "Progression MCP server" / "Quest-forge MCP server"
language with the post-absorption naming (in-tree realmwatch plugins, the
Astral Conduit):

- `docs/codex/xp-system.md`
- `docs/codex/quest-lifecycle.md`
- `docs/codex/node-workstation.md`

Those edits will not survive a clean checkout because `docs/codex/` is
gitignored. The actual source-of-truth must be elsewhere.

## Where do `docs/codex/*.md` come from?

Two systems share the codex content:

1. **HTML codex** — `docs/codex/*.md` rendered to `docs/codex/index.html`
   by `docs/codex/build_codex.py`. The script takes the per-file markdown
   on disk and produces a single static HTML page. It does not generate
   the markdown itself.

2. **Game DB codex** — `~/.realmwatch/game.db` `codex_entries` table.
   Owned by `plugins/codex/` (RPG plugin absorbed from os.realm.watch).
   Schema + **seed rows** live in `plugins/realm-engine/db.py` — that
   file contains `INSERT OR IGNORE INTO codex_entries VALUES (...)`
   statements for every entry, executed when the game DB schema is
   created.

3. **Bidirectional bridge** — `plugins/codex/codex_sync_bridge.py`
   round-trips between (1) and (2). Critically, **both directions skip
   if the target already exists** (lines 130-132 and 176-177): the .md
   importer only inserts new DB rows; the DB exporter only writes new
   .md files. Neither side overwrites the other. So edits made in one
   place do not propagate back to the other.

### Why this layout exists

`docs/codex/` was gitignored because the content was originally generated
from a different repo (os.realm.watch) and treated as build output. After
the May 2026 absorption, the seed data moved into `plugins/realm-engine/db.py`
but the gitignore on `docs/codex/` stayed. The end state: the seed data
in `db.py` IS the source-of-truth for the game-DB half, and through the
bridge it is also the source-of-truth for the .md/.html half. Edits to
`.md` files are operational artifacts — useful for live experiments, but
not persistent.

### Verified by

- `git log --all --oneline -- 'docs/codex/*.md'` returns zero commits.
  Nothing under `docs/codex/*.md` has ever been tracked.
- `grep "xp-system\|quest-lifecycle\|node-workstation" plugins/realm-engine/db.py`
  finds three `INSERT OR IGNORE INTO codex_entries` rows at lines 426,
  427, 434 with the stale "Progression MCP server" / "Quest-forge MCP
  server" / "5 MCP game servers" wording.
- `sqlite3 ~/.realmwatch/game.db "SELECT lore_text, technical_text FROM
  codex_entries WHERE codex_id IN (...);"` shows the same stale wording
  in the live DB. The DB rows were inserted at game.db creation from the
  pre-fix seed in `db.py`.

## Fix applied

The three `INSERT OR IGNORE` rows in
`plugins/realm-engine/db.py` were edited in-place to mirror the corrected
language already present in the `.md` files (lines 426, 427, 434). The
final wording:

- xp-system → `` `progression` plugin (realmwatch). XP stored in players
  table (total_xp) in ~/.realmwatch/game.db.``
- quest-lifecycle → `` `quests` plugin (realmwatch). … Transitions enforced
  in the plugin.``
- node-workstation → "realmwatch map server (with its in-tree MCP server,
  the Astral Conduit)" and "the in-tree FastMCP server (Astral Conduit)
  and game-layer plugins (realm-engine, progression, quests, combat-ward,
  codex)"

## What this does NOT fix

`INSERT OR IGNORE` only inserts when the row doesn't already exist. The
**already-populated** `~/.realmwatch/game.db` on this host still has the
stale text — the fixed seed only affects fresh game.db creations. To
update an existing DB:

```
sqlite3 ~/.realmwatch/game.db <<'SQL'
UPDATE codex_entries
SET technical_text = '`progression` plugin (realmwatch). …'
WHERE codex_id = 'xp-system';
-- (similar for quest-lifecycle, node-workstation)
SQL
```

That's an operator action, not a code change — out of scope for this
investigation. The seed correctness is the durable fix; on the next
fresh install / wipe, the new wording will propagate.

## Follow-up recommendations

1. **De-gitignore the .md files** (or generate them at build time from
   `db.py` so they're always derivable). Right now anyone who clones the
   repo gets a broken `docs/codex/` directory and has to run
   `python -m plugins.codex.codex_sync_bridge --export` to populate it —
   undocumented bootstrap.
2. **Add a one-shot "refresh" mode to the bridge** that overwrites the
   target instead of skipping. With the current skip-if-exists logic the
   `.md` files and game.db can diverge silently forever.
3. **Move codex seed data out of `db.py`** into a YAML/JSON manifest
   under `plugins/codex/seed/` so future edits don't require touching
   a SQL-embedded Python string.

None of those are urgent; the source-of-truth fix in `db.py` is the
load-bearing change for this sweep.
