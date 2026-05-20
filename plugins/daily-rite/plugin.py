"""The Watcher's Daily Rite — morning briefing plugin.

Wraps producer.run_daily_rite for the realmwatch HTTP server. The original
behaviour (cron timer at 8:00 AM, gnome-speaks + notify-send) is preserved
via an in-process timer thread, with an HTTP endpoint for on-demand
triggering and a "dry run" mode that skips speech/notification.

Endpoints:
  POST /plugins/daily-rite/run       Fire the rite NOW. Body (all optional):
                                       { "speak": true, "notify": true,
                                         "chime": true, "push_event": true,
                                         "node": "katana" }
                                     Returns the briefing dict.
  GET  /plugins/daily-rite/state     Query game.db state without speaking.
  GET  /plugins/daily-rite/info      Diagnostic — last fire time, schedule, db path.

Timer behaviour:
  If DAILY_RITE_HOUR is set (default 8 — 8:00 AM local time), a background
  thread fires the rite once per day at that hour. Set DAILY_RITE_HOUR=-1
  to disable the timer entirely (HTTP trigger only).
"""
from __future__ import annotations

import datetime
import importlib.util
import os
import sys
import time
from pathlib import Path

_PLUGIN_DIR = Path(__file__).resolve().parent


def _load_sibling(name: str):
    """Load a sibling .py module under a unique sys.modules key so multiple
    plugins can each have a 'producer.py' without colliding."""
    spec_name = f"plugins.daily_rite.{name}"
    if spec_name in sys.modules:
        return sys.modules[spec_name]
    spec = importlib.util.spec_from_file_location(
        spec_name, str(_PLUGIN_DIR / f"{name}.py")
    )
    assert spec and spec.loader
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec_name] = module
    spec.loader.exec_module(module)
    return module


producer = _load_sibling("producer")


_DEFAULT_NODE = os.environ.get("DAILY_RITE_NODE", "katana")
_DB_PATH = os.environ.get("DAILY_RITE_DB", producer.DEFAULT_DB_PATH)

# -1 disables the timer; otherwise hour-of-day (0..23) at which to fire.
try:
    _SCHEDULE_HOUR = int(os.environ.get("DAILY_RITE_HOUR", "8"))
except ValueError:
    _SCHEDULE_HOUR = 8

_last_fire_ts = 0.0
_last_briefing = ""
_last_state: dict = {}


def _seconds_until_next_fire(hour: int) -> float:
    """Seconds until the next hour:00 in local time. Min 60s for safety."""
    now = datetime.datetime.now()
    target = now.replace(hour=hour, minute=0, second=0, microsecond=0)
    if target <= now:
        target += datetime.timedelta(days=1)
    delta = (target - now).total_seconds()
    return max(60.0, delta)


def _fire(push_event_fn, do_speak: bool, do_notify: bool, do_chime: bool,
          do_push: bool, node: str) -> dict:
    """One pass of the rite. Updates module state."""
    global _last_fire_ts, _last_briefing, _last_state

    result = producer.run_daily_rite(
        db_path=_DB_PATH,
        do_speak=do_speak,
        do_notify=do_notify,
        do_chime=do_chime,
    )
    _last_fire_ts = time.time()
    _last_briefing = result["briefing"]
    _last_state = result["state"]

    if do_push and push_event_fn is not None:
        try:
            push_event_fn({
                "type": "speech",
                "node": node,
                "text": result["briefing"],
                "color": "#ffd080",
                "source": "daily-rite",
                "state": result["state"],
            })
        except Exception as e:
            print(f"daily-rite: push_event failed: {e}", flush=True)

    return result


def setup(ctx):
    """Register endpoints and start scheduler thread."""

    def run_handler(req, params):
        body = req.json() or {}
        result = _fire(
            push_event_fn=ctx._push_event,
            do_speak=bool(body.get("speak", True)),
            do_notify=bool(body.get("notify", True)),
            do_chime=bool(body.get("chime", True)),
            do_push=bool(body.get("push_event", True)),
            node=body.get("node") or _DEFAULT_NODE,
        )
        return req.respond({
            "ok": True,
            "briefing": result["briefing"],
            "state": result["state"],
            "spoke": result["spoke"],
            "notified": result["notified"],
            "chimed": result["chimed"],
        })

    def state_handler(req, params):
        state = producer.query_realm_state(_DB_PATH)
        return req.respond({"ok": True, "state": state, "db_path": _DB_PATH})

    def info_handler(req, params):
        return req.respond({
            "ok": True,
            "default_node": _DEFAULT_NODE,
            "db_path": _DB_PATH,
            "schedule_hour": _SCHEDULE_HOUR,
            "last_fire_ts": _last_fire_ts,
            "last_briefing": _last_briefing,
            "last_state": _last_state,
        })

    ctx.register_endpoint("POST", "/run", run_handler)
    ctx.register_endpoint("GET", "/state", state_handler)
    ctx.register_endpoint("GET", "/info", info_handler)

    ctx.expose_api({
        "run": lambda: _fire(ctx._push_event, True, True, True, True, _DEFAULT_NODE),
        "query_state": lambda: producer.query_realm_state(_DB_PATH),
        "build_briefing": producer.build_briefing,
    })

    # Scheduler thread — fires once per day at SCHEDULE_HOUR:00 local.
    if _SCHEDULE_HOUR < 0 or _SCHEDULE_HOUR > 23:
        ctx.log("Daily Rite scheduler disabled (DAILY_RITE_HOUR=%s)", _SCHEDULE_HOUR)
    else:
        def _scheduler():
            # Sleep until the next fire time, then run once. start_background_thread
            # with interval will re-invoke us, so we recompute sleep on each call.
            wait = _seconds_until_next_fire(_SCHEDULE_HOUR)
            time.sleep(wait)
            _fire(ctx._push_event, do_speak=True, do_notify=True,
                  do_chime=True, do_push=True, node=_DEFAULT_NODE)

        # Use interval=0 (None can't be 0); pass a wrapper with no interval so
        # the helper runs once and we'll add our own loop. Actually
        # start_background_thread with interval re-runs target() then sleeps
        # `interval`. We want target() to do its own sleep-until-target then
        # fire and return — and have the loop re-call us. So pass interval=1
        # (the loop's outer sleep is negligible compared to our internal wait).
        ctx.start_background_thread(
            target=_scheduler,
            interval=1,
            name="plugin-daily-rite-scheduler",
        )
        ctx.log("Daily Rite scheduler armed for %02d:00 local", _SCHEDULE_HOUR)

    ctx.log("Daily Rite ready — node=%s, db=%s", _DEFAULT_NODE, _DB_PATH)
