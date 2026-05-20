"""The Combat Ward plugin — threat classification layer over alerting.

Migrated from os.realm.watch/servers/combat_ward 2026-05-19.

Design (Wave 3 reconcile decision — see selene-findings.md for the full
overlap analysis):

- plugins/alerting/ is the canonical event-router. Channels, rules, cooldowns,
  severity, dependency suppression, maintenance windows, ack suppression —
  all stay there. Combat-ward does NOT duplicate any of that.
- plugins/combat-ward/ subscribes to the realm-event bus and turns
  threat-class events into game-state side effects:
    • bestiary encounter counters (Shadow Probe, Battering Ram, …)
    • ward actions (proposed defensive actions, policy-checked)
    • defense report aggregations
  This is a layer ON TOP of alerting's output, not a replacement.

Endpoints:
  GET  /combat-ward/threats          recent threat-class events (sev >= 3)
  GET  /combat-ward/bestiary         bestiary catalogue + encounter counts
  GET  /combat-ward/encounters       active threat quests + linked actions
  GET  /combat-ward/defense-report   realm defense summary
  GET  /combat-ward/wards            ward templates (banish, slow, isolate, …)

Realm-event hook:
  Every realm-event with severity >= 3 and an event_type in the bestiary map
  (port_scan, brute_force, ddos, …) bumps the bestiary counter via
  server.update_bestiary().
"""
from __future__ import annotations

import sys
from pathlib import Path

from realm_text import real_home


# Make the lexicon python lib importable for downstream tooling (mirrors
# plugins/realm-engine — keeps the pattern consistent across plugins that
# touch entities / lore).
_LEXICON_PY = real_home() / "Projects" / "lexicon.realm.watch" / "python"
if _LEXICON_PY.exists() and str(_LEXICON_PY) not in sys.path:
    sys.path.insert(0, str(_LEXICON_PY))

# Make the plugins/ directory importable so `from . import ...` works.
_PLUGIN_DIR = Path(__file__).resolve().parent
if str(_PLUGIN_DIR.parent) not in sys.path:
    sys.path.insert(0, str(_PLUGIN_DIR.parent))


from . import server  # noqa: E402
from . import mcp_tools  # noqa: E402
from .db import DEFAULT_DB_PATH  # noqa: E402


GAME_DB_PATH = DEFAULT_DB_PATH


def _log(msg: str) -> None:
    """Plugin-prefixed stdout, force-flushed so it survives buffering."""
    print(f"[combat-ward] {msg}", flush=True)


# ── Event handler ────────────────────────────────────────────────────────

def _on_realm_event(evt: dict) -> None:
    """Classify a realm event into a bestiary encounter (if applicable).

    Pure side-effect: bumps the bestiary counter when the event matches a
    known threat type. Does NOT dispatch notifications — that's alerting's
    job. Does NOT propose actions — those are only created via the
    /combat-ward MCP tool or HTTP API (humans-in-the-loop by default).

    Severity normalization: realmwatch realm events store severity as either
    an integer (0-5, game.db scale) or omit it entirely (string-only scales
    live in alerting). We accept either:
      • int severity from realm-engine ingest path
      • severity == "critical" / "warning" string from alerting-style events
        → mapped to 4 / 3 for the bestiary threshold
    """
    if not isinstance(evt, dict):
        return
    event_type = evt.get("type") or evt.get("event_type") or ""
    if not event_type:
        return

    severity_raw = evt.get("severity", 0)
    if isinstance(severity_raw, str):
        severity = {"critical": 4, "warning": 3, "info": 1}.get(severity_raw, 0)
    else:
        try:
            severity = int(severity_raw or 0)
        except (TypeError, ValueError):
            severity = 0

    try:
        result = server.update_bestiary(
            db_path=GAME_DB_PATH,
            event_type=str(event_type),
            severity=severity,
        )
        if result and not result.get("error"):
            _log(
                f"bestiary encounter: {event_type} → "
                f"{result.get('fantasy_name', '?')} "
                f"(total={result.get('times_encountered', 0)})"
            )
    except Exception as e:
        # The game.db schema is owned by realm-engine. If realm-engine
        # hasn't booted yet (or the bestiary_entries table is missing),
        # the depends_on declaration should prevent it — but stay defensive.
        _log(f"update_bestiary failed for {event_type!r}: {e}")


# ── HTTP handlers ────────────────────────────────────────────────────────

def _h_threats(req, params):
    try:
        limit = int(req.query_params.get("limit", "20"))
    except (TypeError, ValueError):
        limit = 20
    try:
        return req.respond(server.get_active_threats(GAME_DB_PATH, limit=limit))
    except Exception as e:
        return req.respond({"error": f"{type(e).__name__}: {e}"}, status=500)


def _h_bestiary(req, params):
    threat_type = req.query_params.get("threat_type") or None
    try:
        return req.respond(server.get_bestiary(GAME_DB_PATH, threat_type=threat_type))
    except Exception as e:
        return req.respond({"error": f"{type(e).__name__}: {e}"}, status=500)


def _h_encounters(req, params):
    quest_id = req.query_params.get("quest_id") or None
    try:
        return req.respond(
            server.get_encounter_status(GAME_DB_PATH, quest_id=quest_id),
        )
    except Exception as e:
        return req.respond({"error": f"{type(e).__name__}: {e}"}, status=500)


def _h_defense_report(req, params):
    try:
        return req.respond(server.defense_report(GAME_DB_PATH))
    except Exception as e:
        return req.respond({"error": f"{type(e).__name__}: {e}"}, status=500)


def _h_wards(req, params):
    try:
        return req.respond(server.get_ward_templates(GAME_DB_PATH))
    except Exception as e:
        return req.respond({"error": f"{type(e).__name__}: {e}"}, status=500)


# ── Plugin entry point ───────────────────────────────────────────────────

def setup(ctx):
    """Register event handler + HTTP endpoints + expose API."""

    # Sanity check: confirm the game.db tables we read/write exist. If
    # realm-engine isn't loaded the depends_on declaration should have
    # short-circuited us, but log clearly when something's off.
    try:
        from .db import get_connection
        conn = get_connection(GAME_DB_PATH)
        tables = {
            r[0] for r in conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table'",
            ).fetchall()
        }
        conn.close()
        required = {"actions", "action_policy_log", "bestiary_entries",
                    "ward_templates", "events", "entities", "quests"}
        missing = required - tables
        if missing:
            _log(f"WARNING: missing tables in {GAME_DB_PATH}: {sorted(missing)}")
        else:
            _log(f"game.db ready at {GAME_DB_PATH}")
    except Exception as e:
        _log(f"could not open {GAME_DB_PATH}: {e}")

    # Subscribe to the realm-event bus. Combat-ward never replaces
    # alerting's routing — it just observes the bus to update game state.
    #
    # NOTE: realmwatch's registry dispatches by event `type`, not by SSE
    # channel. We register the handler on each threat-class type that maps
    # to a bestiary entry, so the dispatch is O(1) per event (no broadcast
    # filtering inside the handler).
    threat_types = {
        "port_scan", "brute_force", "dns_poisoning",
        "firewall_block", "ddos", "unknown_device",
        "cpu_spike", "memory_critical",
    }
    for et in threat_types:
        ctx.on_event(et, _on_realm_event)

    # Also register on the abstract "realm-event" channel — matches the
    # convention used by plugins/realm-engine, even though it's currently
    # a no-op in the registry (documented future-proofing).
    ctx.on_event("realm-event", _on_realm_event)

    # Register HTTP endpoints (raw_path=True per the documented gotcha —
    # the plugin loader otherwise prefixes with /plugins/combat-ward/).
    ctx.register_endpoint("GET", "/combat-ward/threats", _h_threats, raw_path=True)
    ctx.register_endpoint("GET", "/combat-ward/bestiary", _h_bestiary, raw_path=True)
    ctx.register_endpoint("GET", "/combat-ward/encounters", _h_encounters, raw_path=True)
    ctx.register_endpoint("GET", "/combat-ward/defense-report", _h_defense_report, raw_path=True)
    ctx.register_endpoint("GET", "/combat-ward/wards", _h_wards, raw_path=True)

    # Status provider — surfaces a one-line summary on /status / GET /plugins.
    def _status_provider():
        try:
            return {"combat-ward": server.defense_report(GAME_DB_PATH)}
        except Exception:
            return {"combat-ward": {"error": "defense_report failed"}}

    ctx.register_status_provider(_status_provider)

    # Expose API for cross-plugin access (mcp plugin's Wave 1.5 wiring +
    # any future quest-forge / progression hooks).
    ctx.expose_api({
        "db_path": GAME_DB_PATH,
        "get_active_threats": server.get_active_threats,
        "propose_action": server.propose_action,
        "approve_action": server.approve_action,
        "execute_action": server.execute_action,
        "get_encounter_status": server.get_encounter_status,
        "get_bestiary": server.get_bestiary,
        "record_encounter": server.record_encounter,
        "update_bestiary": server.update_bestiary,
        "get_ward_templates": server.get_ward_templates,
        "defense_report": server.defense_report,
        "mcp_tools": mcp_tools.MCP_TOOLS,
    })

    _log(
        f"plugin loaded — 5 endpoints + {len(threat_types)} threat-type hooks "
        f"+ {len(mcp_tools.MCP_TOOLS)} MCP tools"
    )
