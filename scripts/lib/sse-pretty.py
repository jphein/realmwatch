#!/usr/bin/env python3
"""Colored SSE pretty-printer for `realm tail`. Reads event:/data: lines
on stdin, prints  HH:MM:SS  [type]  node  message  with per-type color.
Filters: --type alert,quest  --plugin combat-ward
Backfill: --backfill FILE (JSON array from GET /events?since=...)"""
from __future__ import annotations

import argparse
import json
import os
import sys
import time

RESET = "\033[0m"
COLORS = {
    "alert": "\033[1;31m", "error": "\033[1;31m", "critical": "\033[1;31m",
    "warn": "\033[33m", "warning": "\033[33m",
    "speech": "\033[2;36m", "oracle": "\033[2;36m",
    "discovery": "\033[35m",
    "quest": "\033[33m",
    "status": "\033[32m", "energy": "\033[32m",
    "traffic": "\033[34m", "latency": "\033[34m", "wifi": "\033[34m",
    "topology": "\033[2;34m",
    "firewall": "\033[35m",
    "xp.grant": "\033[1;95m", "level.up": "\033[1;95m",
    "achievement.unlocked": "\033[1;93m",
    "realm-event": "\033[1;37m",
    "plugin-broadcast": "\033[2;37m",
}
DEFAULT_COLOR = "\033[37m"


def _shorten(text, limit=160):
    text = str(text).replace("\n", " ").replace("\r", " ").strip()
    return text if len(text) <= limit else text[:limit - 1] + "…"


def _ts_str(payload):
    ts = payload.get("ts") or payload.get("timestamp") or time.time()
    try:
        return time.strftime("%H:%M:%S", time.localtime(float(ts)))
    except (TypeError, ValueError):
        return time.strftime("%H:%M:%S")


def _node_str(payload):
    for k in ("node", "node_name", "node_id", "host", "source"):
        v = payload.get(k)
        if v:
            return str(v)
    return "-"


def _message_str(payload):
    for k in ("text", "message", "msg", "title", "description"):
        v = payload.get(k)
        if v:
            return _shorten(v)
    try:
        skip = {"ts", "id", "type", "ack_at", "ack_by", "closed_at"}
        return _shorten(json.dumps({k: v for k, v in payload.items() if k not in skip},
                                   separators=(",", ":")))
    except (TypeError, ValueError):
        return _shorten(payload)


def _plugin_str(payload):
    for k in ("source_system", "plugin", "source", "origin"):
        v = payload.get(k)
        if v:
            return str(v).lower()
    return None


def _effective_type(event_name, payload):
    """For wrapper SSE names, prefer the nested .type/.kind tag."""
    if event_name in ("realm-event", "plugin-broadcast"):
        nested = payload.get("type") or payload.get("kind")
        if nested:
            return str(nested)
    return event_name


def _emit(event_name, payload, args):
    eff = _effective_type(event_name, payload)

    if args.type:
        wanted = {t.strip().lower() for t in args.type.split(",") if t.strip()}
        if not (wanted & {event_name.lower(), eff.lower()}):
            return

    if args.plugin:
        p = _plugin_str(payload)
        if not p or p != args.plugin.lower():
            return

    col = COLORS.get(eff, DEFAULT_COLOR) if args.use_color else ""
    rst = RESET if args.use_color else ""
    ts = _ts_str(payload)
    node = _node_str(payload)
    msg = _message_str(payload)
    print(f"{ts}  {col}[{eff}]{rst}  {node:<16}  {msg}", flush=True)


def _consume_backfill(path, args):
    try:
        with open(path, "r", encoding="utf-8") as f:
            events = json.load(f)
    except (OSError, ValueError) as e:
        print(f"sse-pretty: backfill read failed: {e}", file=sys.stderr)
        return
    if isinstance(events, list):
        for evt in events:
            if isinstance(evt, dict):
                _emit("realm-event", evt, args)


def _consume_sse_stdin(args):
    current = ""
    for raw in sys.stdin:
        line = raw.rstrip("\r\n")
        if line.startswith("event:"):
            current = line[6:].strip()
        elif line.startswith("data:"):
            data = line[5:].lstrip()
            if not data:
                continue
            try:
                payload = json.loads(data)
            except ValueError:
                payload = {"text": data}
            if not isinstance(payload, dict):
                payload = {"text": str(payload)}
            _emit(current or "realm-event", payload, args)


def main():
    ap = argparse.ArgumentParser(prog="sse-pretty")
    ap.add_argument("--type", default="")
    ap.add_argument("--plugin", default="")
    ap.add_argument("--no-color", action="store_true")
    ap.add_argument("--backfill", default="")
    args = ap.parse_args()

    no_color_env = bool(os.environ.get("NO_COLOR")) or os.environ.get("REALM_NO_COLOR") == "1"
    args.use_color = (not args.no_color) and (not no_color_env) and sys.stdout.isatty()

    try:
        sys.stdout.reconfigure(line_buffering=True)
    except AttributeError:
        pass

    if args.backfill:
        _consume_backfill(args.backfill, args)

    try:
        _consume_sse_stdin(args)
    except (BrokenPipeError, KeyboardInterrupt):
        try:
            sys.stdout.flush()
        except Exception:
            pass
    return 0


if __name__ == "__main__":
    sys.exit(main())
