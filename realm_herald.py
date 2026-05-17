#!/usr/bin/env python3
"""Realm Herald — makes nodes speak on the live map.

Periodically generates thematic status reports from collectd data
and posts them as speech events to the map server. Runs alongside
map_server.py as a background daemon.

Usage:
    python3 realm_herald.py              # Run with defaults (90s interval)
    python3 realm_herald.py --interval 60  # Custom interval
    python3 realm_herald.py --once         # Single round, then exit
"""

import argparse
import json
import random
import time
import urllib.request
from collectd_reader import get_all_summaries

MAP_URL = "http://localhost"

# ── Node voice templates ──
# Each node has themed report templates using {placeholders} filled from collectd data.
# Templates are randomly selected; nodes only speak when they have interesting data.

# NODE_TEMPLATES — per-node persona templates for the herald.
# JP-specific data lives in realm-local.json (gitignored). On a fresh
# clone the dict is empty and the herald speaks generic lines until a
# realm-local.json is populated. See realm-local.json.example.
def _load_node_templates():
    try:
        import json, os
        path = os.path.join(os.path.dirname(__file__), 'realm-local.json')
        with open(path) as f:
            return json.load(f).get('herald_node_templates', {})
    except (FileNotFoundError, OSError, json.JSONDecodeError):
        return {}

NODE_TEMPLATES = _load_node_templates()

# Track recent speakers to avoid repetition
_recent_speakers = []
_MAX_RECENT = 5


def _fmt_uptime(seconds):
    if seconds is None:
        return "unknown time"
    days = int(seconds // 86400)
    hours = int((seconds % 86400) // 3600)
    if days > 0:
        return f"{days}d {hours}h"
    return f"{hours}h"


def _fmt_rate(bps):
    if bps is None or bps == 0:
        return "0"
    if bps > 1048576:
        return f"{bps / 1048576:.1f} MB/s"
    if bps > 1024:
        return f"{bps / 1024:.0f} KB/s"
    return f"{bps:.0f} B/s"


def _build_context(summary):
    """Build template context from a collectd host summary."""
    ctx = {
        "load": "idle",
        "mem_pct": "?",
        "uptime": "unknown",
        "temp": "?",
        "conntrack": "0",
        "dhcp_leases": "0",
        "iface_summary": "",
    }
    if summary.get("load_1") is not None:
        ctx["load"] = f"{summary['load_1']:.2f}"
    if summary.get("mem_pct") is not None:
        ctx["mem_pct"] = f"{summary['mem_pct']}"
    if summary.get("uptime") is not None:
        ctx["uptime"] = _fmt_uptime(summary["uptime"])
    if summary.get("temp") is not None:
        ctx["temp"] = f"{summary['temp']:.0f}"
    if summary.get("conntrack") is not None:
        ctx["conntrack"] = f"{summary['conntrack']:,}"
    if summary.get("dhcp_leases") is not None:
        ctx["dhcp_leases"] = f"{summary['dhcp_leases']}"
    # Interface summary — top busiest
    if summary.get("interfaces"):
        sorted_ifaces = sorted(
            summary["interfaces"].items(),
            key=lambda x: (x[1].get("rx_bps", 0) + x[1].get("tx_bps", 0)),
            reverse=True,
        )
        parts = []
        for name, data in sorted_ifaces[:2]:
            rx = data.get("rx_bps", 0)
            tx = data.get("tx_bps", 0)
            if rx + tx > 0:
                parts.append(f"{name}: \u2193{_fmt_rate(rx)} \u2191{_fmt_rate(tx)}")
        ctx["iface_summary"] = ", ".join(parts) if parts else "Flows quiet."
    return ctx


def _post_event(event):
    """POST a speech event to the map server."""
    try:
        data = json.dumps(event).encode()
        req = urllib.request.Request(
            f"{MAP_URL}/event",
            data=data,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        with urllib.request.urlopen(req, timeout=3):
            pass
        return True
    except Exception as e:
        print(f"  Failed to post: {e}")
        return False


def _pick_speakers(summaries, count=2):
    """Pick the most interesting nodes to speak this round."""
    global _recent_speakers
    candidates = []
    for host, summary in summaries.items():
        # Match to template keys
        host_lower = host.lower().replace("-", "").replace("_", "")
        matched_key = None
        for key in NODE_TEMPLATES:
            if key.replace("-", "").replace("_", "") == host_lower:
                matched_key = key
                break
        if not matched_key:
            continue
        if matched_key in _recent_speakers:
            continue
        # Score by interestingness (high load, high traffic, high temp)
        score = 0
        if summary.get("load_1") is not None:
            score += summary["load_1"] * 10
        if summary.get("temp") is not None and summary["temp"] > 50:
            score += (summary["temp"] - 40) * 2
        if summary.get("conntrack"):
            score += min(summary["conntrack"] / 100, 20)
        if summary.get("interfaces"):
            total = sum(
                v.get("rx_bps", 0) + v.get("tx_bps", 0)
                for v in summary["interfaces"].values()
            )
            score += min(total / 10000, 30)
        # Add some randomness so quiet nodes still speak sometimes
        score += random.uniform(0, 15)
        candidates.append((matched_key, summary, score))

    candidates.sort(key=lambda x: x[2], reverse=True)
    picked = candidates[:count]

    for key, _, _ in picked:
        _recent_speakers.append(key)
    while len(_recent_speakers) > _MAX_RECENT:
        _recent_speakers.pop(0)

    return [(key, summary) for key, summary, _ in picked]


def herald_round():
    """Run one round of the herald — pick nodes and make them speak."""
    summaries = get_all_summaries()
    if not summaries:
        print("No collectd data available.")
        return

    speakers = _pick_speakers(summaries)
    if not speakers:
        print("No nodes ready to speak this round.")
        return

    for node_key, summary in speakers:
        templates = NODE_TEMPLATES[node_key]
        ctx = _build_context(summary)
        template = random.choice(templates["templates"])
        try:
            text = template.format(**ctx)
        except KeyError:
            text = template  # fallback if placeholder missing

        event = {
            "type": "speech",
            "node": node_key,
            "text": text,
            "color": templates.get("color", ""),
        }
        print(f"  {templates['name']}: {text}")
        _post_event(event)
        time.sleep(0.5)  # slight stagger between speeches


def main():
    parser = argparse.ArgumentParser(description="Realm Herald — automated node reports")
    parser.add_argument("--interval", type=int, default=90, help="Seconds between rounds (default: 90)")
    parser.add_argument("--once", action="store_true", help="Run one round and exit")
    args = parser.parse_args()

    print(f"Realm Herald: speaking every {args.interval}s")
    print(f"Map server: {MAP_URL}")

    if args.once:
        herald_round()
        return

    while True:
        print(f"\n[Herald Round — {time.strftime('%H:%M:%S')}]")
        try:
            herald_round()
        except KeyboardInterrupt:
            raise
        except Exception as e:
            print(f"  Herald round failed: {e}")
        time.sleep(args.interval)


if __name__ == "__main__":
    main()
