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

NODE_TEMPLATES = {
    "gatekeeper": {
        "name": "The Gatekeeper",
        "color": "rgba(96,128,192,0.6)",
        "templates": [
            "The gates hold. {conntrack} connections tracked through my domain. Memory at {mem_pct}%.",
            "{dhcp_leases} souls granted passage into the realm. Load: {load}.",
            "I have stood vigil for {uptime}. The perimeter holds. {iface_summary}",
            "Temperature at {temp}\u00B0C. {conntrack} active threads weave through my gates.",
            "The outer darkness probes, but {conntrack} connections are accounted for. All orderly.",
        ],
    },
    "mr8300-host": {
        "name": "<REDACTED>",
        "color": "rgba(192,144,96,0.5)",
        "templates": [
            "My beacon burns steady. Load: {load}. Uptime: {uptime}.",
            "Memory holds at {mem_pct}%. The signal reaches true.",
            "Standing watch at {temp}\u00B0C. {iface_summary}",
        ],
    },
    "onhub-office": {
        "name": "The Scribe's Alcove",
        "color": "rgba(192,144,96,0.5)",
        "templates": [
            "The scriptorium hums. Load: {load}. Memory: {mem_pct}%.",
            "Uptime: {uptime}. My signal guides the scribes. {iface_summary}",
        ],
    },
    "onhub-closet": {
        "name": "The Hidden Chamber",
        "color": "rgba(192,144,96,0.5)",
        "templates": [
            "I dwell unseen, but my signal pervades. Load: {load}.",
            "The hidden currents flow — {iface_summary}. Memory: {mem_pct}%.",
        ],
    },
    "wndr4300sw-shed": {
        "name": "The Woodshed Watch",
        "color": "rgba(192,144,96,0.5)",
        "templates": [
            "Out here in the wild reaches, my beacon holds. Load: {load}.",
            "The shed stands. Uptime: {uptime}. {iface_summary}",
        ],
    },
    "onhub-pumphouse": {
        "name": "The Pumphouse Keep",
        "color": "rgba(192,144,96,0.5)",
        "templates": [
            "Water and signal flow together. Load: {load}. Memory: {mem_pct}%.",
            "The deep keep holds. Uptime: {uptime}. My reach extends outward.",
        ],
    },
    "wrt1900ac-family": {
        "name": "The Great Hall",
        "color": "rgba(192,144,96,0.5)",
        "templates": [
            "The Great Hall buzzes with life. Load: {load}. {iface_summary}",
            "Many souls gather here. Memory: {mem_pct}%. Temperature: {temp}\u00B0C.",
        ],
    },
    "ea6350-cl": {
        "name": "The Citadel Beacon",
        "color": "rgba(192,144,96,0.5)",
        "templates": [
            "My beacon burns atop the Citadel. Load: {load}.",
            "From here I see all approaches. Memory: {mem_pct}%. {iface_summary}",
        ],
    },
    "eap225-outdoor": {
        "name": "The Sentinel",
        "color": "rgba(192,144,96,0.5)",
        "templates": [
            "I stand in the open air, my signal unshielded. Load: {load}.",
            "The outdoor watch continues. Uptime: {uptime}. Memory: {mem_pct}%.",
        ],
    },
    "ea6350v3-family": {
        "name": "The Inner Ward",
        "color": "rgba(192,144,96,0.5)",
        "templates": [
            "The inner defenses hold firm. Load: {load}. {iface_summary}",
            "Memory: {mem_pct}%. I guard the family's corridors.",
        ],
    },
    "onhub-family": {
        "name": "The Family Hearth",
        "color": "rgba(192,144,96,0.5)",
        "templates": [
            "The hearth glows warm. Load: {load}. Memory: {mem_pct}%.",
            "Uptime: {uptime}. All gather 'round my signal.",
        ],
    },
    "onhub-bed": {
        "name": "The Dreamer's Rest",
        "color": "rgba(192,144,96,0.5)",
        "templates": [
            "The dreamers slumber, but I remain awake. Load: {load}.",
            "A quiet watch. Memory: {mem_pct}%. Uptime: {uptime}.",
        ],
    },
}

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
