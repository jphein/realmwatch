# Lexicon Fleet Catalog for Realmwatch — Design

**Date:** 2026-05-18
**Status:** spec, awaiting implementation plan
**Triggered by:** `gst308t-office` (10.0.6.104) was physically swapped for a new TRENDnet GS308T on VLAN 37 with the fantasy name `east-tree-trunk`. The change exposed that realmwatch has no stable per-node identity — every reference is by current name, which silently goes stale on rename or replace.

## 1. Goal

Introduce stable per-node identity so renames and hardware swaps preserve history, references, and downstream relationships. Lexicon (the existing project-catalog tool at `~/Projects/lexicon.realm.watch/`) extends to also own *fleet* catalogs. Realmwatch ships a `plugins/lexicon/` plugin that makes the fleet catalog authoritative for identity; `topology.json`, `personas.json`, and `realm-local.json` become consumers/renderers, not identity stores.

The chosen approach is option **A (catalog-authoritative)** — the larger refactor, picked deliberately over the sidecar option for long-term cleanliness.

## 2. Problem statement

Today, three files reference nodes by their current name:

| File | What it stores | Failure mode on rename |
|---|---|---|
| `topology.json` (in realm.db `nodes` table) | id, label, ip, mac, position, role | Lose mapping if id changes; downstream connections by id silently dangle |
| `personas.json` | per-node fantasy voice + display | Persona orphaned |
| `realm-local.json` `herald_node_templates` | per-node speech templates | Templates orphaned silently — herald falls back to defaults without warning |

Additionally, only **52 of 99** nodes in `realm.db` have a known MAC. The other 47 (HA-only entities, infra that doesn't expose ARP, virtual things) have no stable physical anchor. Any identity scheme must support both.

The triggering case is not a pure rename — it's a *hardware swap*: a new physical device on a new VLAN inheriting the role of the old one. Lexicon's projects catalog only models pure renames (`prior_names`). Fleet needs both rename and replace.

## 3. Identity model

**Stable identity key (`fleet_id`):** prefixed string discriminating the two anchor types.

- `mac:b4:fb:e4:12:34:56` — when a MAC is known (canonical form: lowercase, colon-separated)
- `fleet:<uuid4>` — when no MAC is known; allocated once at first sight, written back into the node's `data` blob in realm.db so it's persistent across restarts

**Lifecycle states:**

- `tentative` — auto-created by `discovery_engine.py` on first sight, never curated. Not rendered on the map; surfaced in the spellbook for promotion.
- `curated` — operator-approved. Rendered on the map. Has `realm`, `kind`, `role` set.
- `retired` — taken out of service. May carry `replaced_by: <successor_fleet_id>` linking to a curated successor.

**Resolve semantics:**

`fleet.resolve(name_or_id)` accepts any of:
- a `fleet_id` (returns the entry directly)
- a `current_name` of any live entry
- a `name` from any live entry's `prior_names`
- a `current_name` of a `retired` entry — walks `replaced_by` chain to the live successor (cycle-guarded, abort after 10 hops with a warning)

Resolver returns `None` (not raises) on miss, so callers can branch on existence.

## 4. Schema

`fleet.yaml`, gitignored in `~/Projects/realmwatch/`:

```yaml
version: 1
nodes:
  - fleet_id: "mac:78:48:59:a8:25:97"
    current_name: hp-switch
    prior_names: []
    realm: signal
    kind: switch
    role: managed_switch_24port
    vendor: "HP V1910-24G"
    status: curated
    first_seen: 2024-08-12
    last_seen: 2026-05-18

  - fleet_id: "mac:b4:fb:e4:12:34:56"
    current_name: east-tree-trunk
    prior_names: []
    realm: forest
    kind: switch
    role: managed_switch_8port
    vendor: "TRENDnet GS308T"
    status: curated
    notes: "VLAN 37 trunk; replaced the office GS308T on 2026-05-18"
    first_seen: 2026-05-18
    last_seen: 2026-05-18

  - fleet_id: "mac:OLD-GS308T-MAC"          # filled in by migration from realm.db
    current_name: gst308t-office
    prior_names: []
    status: retired
    replaced_by: "mac:b4:fb:e4:12:34:56"
    retired_on: 2026-05-18
    retire_reason: "swapped for new TRENDnet on VLAN 37; renamed east-tree-trunk"
```

**Schema invariants** (enforced by lexicon load-time validation):
- `fleet_id` matches `^(mac:[0-9a-f:]{17}|fleet:[0-9a-f-]{36})$`
- `current_name` required, kebab-case (matches existing realmwatch convention)
- `status` ∈ {tentative, curated, retired}
- `replaced_by` only valid when `status == retired`
- No two live entries (status ∈ {tentative, curated}) may share a `current_name` or a `prior_names[*].name`
- `realm` ∈ existing lexicon realms; `kind` open-ended string; `role` from `node_roles.py` registry or null

## 5. Authority shift

| Field | Old home | New home |
|---|---|---|
| `current_name`, `prior_names`, `kind`, `role`, `realm`, `vendor` | `realm.db nodes.data` JSON blob | **fleet.yaml** |
| `x`, `y` (position) | `realm.db nodes` columns | unchanged |
| `ip`, `mac` (live), `connections` | `realm.db nodes.data` / `connections` table | unchanged — live state |
| persona voice/display | `personas.json` | unchanged shape; **rekeyed by `fleet_id`** |
| `herald_node_templates` keys | `realm-local.json` (by `current_name`) | unchanged shape; **rekeyed by `fleet_id`** |

`realm.db nodes.data` retains a `fleet_id` field as the foreign key into fleet.yaml; the identity-bearing fields (`label`, `role`, etc.) are removed from the blob after migration. The existing `node_id` column in `realm.db nodes` (the human-readable kebab-case name) stays *mutable* — on `/fleet/rename` it updates to the new name and the `connections` table's `from_id` / `to_id` references are rewritten in the same transaction; `fleet_id` is the stable handle that survives those updates.

## 6. Read path

1. `plugin_loader.py` instantiates `plugins/lexicon/plugin.py` with priority `100` (loaded before any feature plugin that needs identity resolution; foundational tier).
2. Plugin `setup(ctx)` imports lexicon (path-injected per realm-sigil precedent) and calls `cat = load_catalog("fleet.yaml", kind="fleet")`. Builds two indexes:
   - `by_id`: `fleet_id` → `FleetEntry` (1:1)
   - `by_name`: union of `current_name + prior_names + retired-entries' current_name` → `fleet_id` (n:1, walks `replaced_by` chains)
3. Plugin attaches a resolver to the plugin context: `ctx.fleet.resolve(name_or_id) → FleetEntry | None`. Every other plugin, herald, oracle, chat bridge, etc. uses this.
4. Plugin starts an inotify watch on `fleet.yaml`; on change → reload catalog → swap indexes atomically → broadcast SSE `plugin-broadcast { type: "fleet-update" }` so browsers refresh.
5. On `/topology` GET (and the SSE `topology` event), `map_server.py` joins each topology node to its fleet entry by `fleet_id`. Serves the *resolved* shape: `current_name`, `role`, `realm` from fleet.yaml; `x/y/ip/connections` from realm.db. Browser stays oblivious to the split.

**Inbound name resolution everywhere:** endpoints that accept a node id as a string (`POST /node`, `POST /personas`, `POST /ssh`, `GET /ping/<ip>`, etc.) wrap the string arg through `ctx.fleet.resolve()`. Stale-name callers still work; they get a `X-Fleet-Resolved: prior_name=<old>; current_name=<new>; fleet_id=<id>` response header to diagnose.

## 7. Rename flow — two verbs

**`POST /fleet/rename`** (same hardware, new name):

```json
{ "fleet_id": "mac:78:48:59:a8:25:97",
  "new_name": "iron-eye",
  "reason": "fantasy-renamed" }
```

Effects:
- Append `{name: <current>, retired_on: <today>, reason: <reason>}` to `prior_names`
- Set `current_name = new_name`
- Write fleet.yaml (round-trip preserving comments)
- Emit `realm-event { kind: "fleet.renamed", from, to, fleet_id }`
- SSE broadcast `plugin-broadcast { type: "fleet-update" }`

**`POST /fleet/replace`** (hardware swap — the gst308t-office case):

```json
{
  "old": { "fleet_id": "mac:OLD-MAC" },
  "new": {
    "fleet_id": "mac:b4:fb:e4:12:34:56",
    "current_name": "east-tree-trunk",
    "kind": "switch",
    "realm": "forest",
    "vendor": "TRENDnet GS308T"
  },
  "inherit": { "persona": true, "position": true, "herald_templates": true },
  "ip": "10.0.37.4",
  "vlan": 37,
  "retired_on": "2026-05-18",
  "reason": "moved to VLAN 37 + fantasy-named"
}
```

Effects:
- Old entry → `status: retired`, `replaced_by` = new id, `retired_on` set
- New entry → written as `status: curated`
- If `inherit.persona`: `personas.json` rekeyed from old `fleet_id` → new `fleet_id`
- If `inherit.position`: realm.db `nodes.data.fleet_id` for the topology entry flips to new id (keeps `x/y`)
- If `inherit.herald_templates`: `realm-local.json[herald_node_templates]` rekeyed
- `ip`, `vlan` updated in topology entry
- `realm-event { kind: "fleet.replaced", old_fleet_id, new_fleet_id, retired_on }`
- SSE broadcast

`old` accepts `{fleet_id}` or `{name}` (resolved via prior_names if needed).

## 8. Discovery integration

`discovery_engine.py` currently emits `(mac, ip, hostname, vendor_oui, evidence)` tuples for newly-observed devices. New callback hook in the lexicon plugin:

- Existing fleet entry for `mac:<MAC>` → bump `last_seen` only
- No existing entry → write `tentative`:
  - `fleet_id = "mac:<MAC>"`
  - `current_name` auto-derived: LLDP `SysName` → HA `friendly_name` → DHCP hostname → `<vendor>-<mac_suffix4>`
  - `kind: unknown`, `role: null`, `realm: signal` (default)
  - `discovery_evidence: { lldp: ..., ha: ..., dhcp: ..., oui: ... }` — which signals voted for the suggested name

Spellbook search panel surfaces tentative entries with a `[Promote]` action → small inline panel: edit name, pick realm/kind/role → `POST /fleet/promote` flips to curated.

## 9. Migration

`scripts/migrate-fleet.py` (one-shot, idempotent):

1. Open `realm.db`; read all 99 rows from `nodes`
2. For each row with `data.mac`: create `curated` fleet entry, `fleet_id = "mac:<MAC>"`. Carry over `label` → `current_name`, `role` → `role`, `type` → `kind` heuristic, `vendor` → `vendor`
3. For each row without `data.mac`: allocate `fleet:<uuid4>`, write `fleet_id` back into `data` blob in realm.db. Same field carryover.
4. Realm assignment: derive from existing `node_roles.py` mapping (each role has a realm hint); fall back to `signal`.
5. Bulk-write `fleet.yaml` via `lexicon.write_catalog()` (sorted by realm then name for readable diffs).
6. Rekey `realm-local.json` `herald_node_templates`: walk each key → resolve to `fleet_id` via the freshly-loaded catalog → rewrite dict with `fleet_id` keys. Keep `_legacy_name_map: {fleet_id: old_name}` as a human-readable sibling (not consulted by code; can be removed after a few releases).
7. Rekey `personas.json` the same way.
8. Strip the migrated identity fields (`label`, `role`, `realm`, `kind`, `vendor`) from `realm.db nodes.data` blobs to avoid drift; leave the live-state fields (`ip`, `mac`, etc).
9. Smoke check: for every topology node, assert `ctx.fleet.resolve(node.fleet_id) is not None`. Print summary.

Re-running on an already-migrated repo is a no-op: detects existing `fleet_id` fields in realm.db and skips.

**Roll-forward only:** no rollback script. If migration produces a bad fleet.yaml, delete it and re-run — realm.db is the source the migration reads from, so it's authoritative for the un-migrated baseline. (Take a realm.db backup before running per project rules.)

## 10. Lexicon library changes

Lexicon currently knows about `projects.yaml`. It gains:

- `load_catalog(path, kind="projects" | "fleet")` discriminator. Both share the underlying YAML round-trip and `resolve()` machinery.
- Fleet schema validator: `fleet_id` regex, name-collision check across live entries, `replaced_by` cycle guard.
- `Catalog.resolve()` walks `replaced_by` chains in addition to `prior_names`.
- No new vocabulary files. `roll('node', realm=...)` reuses existing adjective+noun vocabularies (already produces names like `east-tree-trunk`).
- Python module loaded via path injection per `realm-sigil` precedent in CLAUDE.md: `sys.path.insert(0, str(Path.home() / "Projects" / "lexicon.realm.watch" / "python"))`.

## 11. Plugin layout

```
plugins/lexicon/
├── plugin.json           # manifest; priority 100; depends_on: []
├── plugin.py             # setup(ctx) — load fleet.yaml, register resolver + endpoints, start inotify watch
├── endpoints.py          # POST /fleet/rename, /fleet/replace, /fleet/promote, /fleet/reload; GET /fleet/list, /fleet/resolve/<name>
├── inotify_watch.py      # background thread watching fleet.yaml mtime, hot-reload on change
├── panel.html            # fleet inspector — table, search, promote/rename/replace forms
├── panel.js              # SSE listener for plugin-broadcast { type: "fleet-update" }; refresh table
└── panel.css             # fantasy-themed table styling consistent with spellbook
```

## 12. SSE event additions

| Event | When | Payload |
|---|---|---|
| `plugin-broadcast { type: "fleet-update" }` | After any fleet.yaml write or inotify reload | `{ changed_fleet_ids: [...] }` |
| `realm-event { kind: "fleet.renamed" }` | On `/fleet/rename` | `{ fleet_id, from, to }` |
| `realm-event { kind: "fleet.replaced" }` | On `/fleet/replace` | `{ old_fleet_id, new_fleet_id, retired_on }` |
| `realm-event { kind: "fleet.promoted" }` | On `/fleet/promote` (tentative → curated) | `{ fleet_id, name }` |

## 13. Hot-reload exception

CLAUDE.md states "Plugin changes require a server restart." This design takes a deliberate exception for `fleet.yaml` reloads via inotify, on the grounds that:

- It's data, not code — no Python module reload, no thread restart
- The plugin holds a single in-memory dict; reload is a single atomic pointer swap
- Manual edits to `fleet.yaml` (the common operator path for fixing typos in `prior_names`) shouldn't require restarting the whole server

Explicit `POST /fleet/reload` is also exposed for the case where inotify doesn't fire (network filesystems, container bind mounts).

## 14. Out of scope (deliberate cuts)

- **HA-only entities** (lights, sensors, energy meters): keep their HA `entity_id` keying. They have stable identity from HA; doubling up adds friction without payoff.
- **`sub_entities` table** (discovery-engine services on a host): keeps its own `node_id` FK. Migration leaves these refs untouched; they ride along on whatever the parent node's resolved name is. Revisit if painful.
- **WiFi clients tracked through scans**: too volatile (MAC randomization) for curated identity. Stay as ephemeral entries in `wifi_scans` table.
- **UI for editing `prior_names` history**: read-only in v1. Fix bad renames by editing `fleet.yaml` directly; inotify picks it up.
- **Backward-compat for external tools that read `topology.json` directly off disk**: not promised. Server always serves resolved shape via HTTP; off-disk consumers are responsible for migrating.

## 15. Open questions parked for implementation

- Whether to deploy migration as one big PR or stage it: (1) lexicon library change → (2) plugin lands tentative + read path → (3) migration script run → (4) authoritative cutover. Decide during planning.
- Whether `promote` collapses into `rename` UX-wise (operator promotes-and-renames in one action) or stays separate. Plugin can expose both.
- Whether `fleet.yaml` ordering matters for diff readability vs. write performance. Default: sort on write.

## 16. Test plan

No existing test framework in realmwatch. Validation:

1. `python3 scripts/migrate-fleet.py --dry-run` — prints summary without writing
2. `python3 scripts/migrate-fleet.py` — produces `fleet.yaml`; manually inspect a handful of entries (especially the gst308t-office ↔ east-tree-trunk case)
3. `make dev` — server starts, lexicon plugin shown in load log, `/debug` lists `/fleet/*` endpoints
4. `curl /fleet/list` — returns 99-ish entries plus a tentative few
5. `curl /fleet/resolve/gst308t-office` — returns east-tree-trunk's entry (via `replaced_by`)
6. `curl -XPOST /fleet/rename -d '{"fleet_id":"mac:...","new_name":"iron-eye"}'` — name flips, prior_names appends, SSE fires
7. Open `realm-map.html` — map renders unchanged (resolved shape served), spellbook shows fleet inspector panel
8. Edit `fleet.yaml` by hand, save → server log shows hot reload, browsers refresh via SSE

---

End of design. Implementation plan to be produced by the `writing-plans` skill.
