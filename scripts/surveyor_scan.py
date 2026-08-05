#!/usr/bin/env python3
"""Field RF site survey — run ON the surveyor tablet, at the place being surveyed.

    surveyor_scan.py --site "thomas-roof"
    surveyor_scan.py --site "willows-cabin-eave" --dwell 45 --note "SW corner, 3m up"
    surveyor_scan.py --site x --iperf 10.0.6.120     # add a throughput leg
    surveyor_scan.py --compare                        # list past surveys

WHY THIS IS NOT `ap_scanner.py`. realmwatch's ap_scanner SSHes to our APs and
asks what clients THEY see — the infrastructure's view of itself. It is
structurally incapable of answering the question a WISP survey asks: *standing
at a place where we have no AP yet, what is receivable, and how congested is the
air?* You cannot SSH to an AP that does not exist. This is the client-side view,
carried to the site on a battery.

WHY A DWELL, NOT A SCAN. One scan is a snapshot of a fading channel — the same
BSSID moved 12 dB between sweeps during testing. Alignment and go/no-go
decisions need a distribution, so this sweeps repeatedly across a dwell window
and reports min/median/max per BSSID. A single number would be confidently
wrong, which is worse than slow.

WHY dBm AND NOT nmcli's PERCENT. `nmcli` reports SIGNAL as 0-100, mapped from
dBm by a nonlinear curve nobody should reverse. `iw scan` gives real dBm, which
is the unit link budgets are computed in. It needs root — the surveyor has
passwordless sudo for exactly this kind of reason.
"""
from __future__ import annotations

import argparse
import json
import pathlib
import re
import statistics
import subprocess
import sys
import time
from collections import defaultdict

HOME = pathlib.Path.home()
FLEET = HOME / ".cache/realm-fleet-bssids.json"
SURVEYS = HOME / "surveys"

# Usable-link rules of thumb for planning, in dBm. These are receive-side
# thresholds for a fixed outdoor link, deliberately conservative: a link that is
# merely "connectable" at install will fail in rain and in summer foliage.
GRADES = [
    (-55, "EXCELLENT", "full rate, headroom for weather and foliage"),
    (-65, "GOOD",      "solid; standard install"),
    (-72, "USABLE",    "works, but little margin — aim carefully"),
    (-80, "MARGINAL",  "will drop in rain/leaf-out; needs a better mount"),
    (-200, "UNUSABLE", "do not plan a subscriber on this"),
]


def grade(dbm: float) -> tuple[str, str]:
    for thresh, label, note in GRADES:
        if dbm >= thresh:
            return label, note
    return "UNUSABLE", ""


def chan_from_freq(mhz: int) -> int | None:
    if 2412 <= mhz <= 2484:
        return 14 if mhz == 2484 else (mhz - 2407) // 5
    if 5000 < mhz < 5900:
        return (mhz - 5000) // 5
    if 5955 <= mhz <= 7115:
        return (mhz - 5955) // 5 + 1
    return None


def sweep(iface: str) -> list[dict]:
    """One `iw scan` pass -> list of {bssid, ssid, freq, signal}."""
    try:
        r = subprocess.run(["sudo", "-n", "iw", "dev", iface, "scan"],
                           capture_output=True, text=True, timeout=45)
    except subprocess.TimeoutExpired:
        return []
    if r.returncode != 0:
        # A scan can transiently fail with -EBUSY while the card is roaming.
        # That is not fatal to a dwell; the next sweep usually succeeds.
        return []
    out, cur = [], None
    for line in r.stdout.splitlines():
        m = re.match(r"^BSS ([0-9a-fA-F:]{17})", line)
        if m:
            if cur and cur.get("signal") is not None:
                out.append(cur)
            cur = {"bssid": m.group(1).upper(), "ssid": "", "freq": None, "signal": None}
            continue
        if cur is None:
            continue
        s = line.strip()
        if s.startswith("freq:"):
            try:
                cur["freq"] = int(float(s.split(":", 1)[1]))
            except ValueError:
                pass
        elif s.startswith("signal:"):
            try:
                cur["signal"] = float(s.split(":", 1)[1].strip().split()[0])
            except (ValueError, IndexError):
                pass
        elif s.startswith("SSID:"):
            cur["ssid"] = s.split(":", 1)[1].strip()
    if cur and cur.get("signal") is not None:
        out.append(cur)
    return out


def load_fleet() -> dict:
    if not FLEET.exists():
        print(f"  NOTE no fleet map at {FLEET} — everything will read as FOREIGN.")
        print("       Build it on katana: scripts/surveyor_fleet_map.py --deploy surveyor")
        return {"bssids": {}, "unreachable": []}
    d = json.loads(FLEET.read_text())
    # An AP that was unreachable when the map was built has no BSSIDs in it, so
    # its beacons would be mislabelled as an intruder. Surface that, loudly.
    if d.get("unreachable"):
        print(f"  WARNING fleet map was built with {len(d['unreachable'])} AP(s) "
              f"unreachable: {', '.join(d['unreachable'])}")
        print("          Their BSSIDs will be misreported as FOREIGN.")
    return d


def main() -> int:
    p = argparse.ArgumentParser(description=__doc__,
                                formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument("--site", help="label for this location, e.g. 'thomas-roof'")
    p.add_argument("--note", default="", help="free text: mount height, aspect, weather")
    p.add_argument("--dwell", type=int, default=25, help="seconds to sweep (default 25)")
    p.add_argument("--iface", default=None, help="wireless interface (auto-detected)")
    p.add_argument("--iperf", metavar="HOST", help="also run an iperf3 throughput test")
    p.add_argument("--compare", action="store_true", help="list past surveys and exit")
    args = p.parse_args()

    SURVEYS.mkdir(exist_ok=True)
    if args.compare:
        rows = sorted(SURVEYS.glob("*.json"))
        if not rows:
            print("  no surveys recorded yet")
            return 0
        for f in rows:
            d = json.loads(f.read_text())
            best = d.get("best_ours") or {}
            print(f"  {d['site']:24s} {d['when'][:16]}  best-ours "
                  f"{best.get('ap','-'):16s} {best.get('median','-')} dBm  "
                  f"foreign={d['summary']['foreign_bssids']}")
        return 0

    if not args.site:
        p.error("--site is required (it is what makes the record comparable later)")

    iface = args.iface
    if not iface:
        r = subprocess.run(["sh", "-c",
                            "iw dev | awk '/Interface/{print $2; exit}'"],
                           capture_output=True, text=True)
        iface = (r.stdout or "").strip()
    if not iface:
        sys.exit("no wireless interface found (pass --iface)")

    fleet = load_fleet()
    fmap = fleet.get("bssids", {})

    print(f"  site '{args.site}' · iface {iface} · dwelling {args.dwell}s")
    samples: dict[str, list[float]] = defaultdict(list)
    meta: dict[str, dict] = {}
    t0, sweeps = time.time(), 0
    while time.time() - t0 < args.dwell:
        got = sweep(iface)
        if got:
            sweeps += 1
        for b in got:
            samples[b["bssid"]].append(b["signal"])
            meta.setdefault(b["bssid"], {"ssid": b["ssid"], "freq": b["freq"]})
            if b["ssid"] and not meta[b["bssid"]]["ssid"]:
                meta[b["bssid"]]["ssid"] = b["ssid"]
        print(f"    sweep {sweeps}: {len(samples)} BSSIDs seen", end="\r", flush=True)
    print()

    # A dwell that captured one sweep is a snapshot wearing a distribution's
    # clothes. Refuse to present it as a survey.
    if sweeps < 2:
        print(f"  ONLY {sweeps} usable sweep(s) — not a survey. Is the card busy, "
              f"or is sudo/iw missing? Re-run with a longer --dwell.")
        return 1

    rows = []
    for bssid, sig in samples.items():
        ours = fmap.get(bssid)
        m = meta[bssid]
        ch = chan_from_freq(m["freq"]) if m["freq"] else None
        med = round(statistics.median(sig), 1)
        g, why = grade(med)
        rows.append({
            "bssid": bssid, "ssid": m["ssid"] or "(hidden)",
            "freq": m["freq"], "channel": ch,
            "band": "2.4" if ch and ch <= 14 else "5/6" if ch else "?",
            "samples": len(sig),
            "min": round(min(sig), 1), "median": med, "max": round(max(sig), 1),
            "spread": round(max(sig) - min(sig), 1),
            "ours": bool(ours), "ap": ours["ap"] if ours else None,
            "grade": g, "grade_note": why,
        })
    rows.sort(key=lambda r: -r["median"])

    ours = [r for r in rows if r["ours"]]
    foreign = [r for r in rows if not r["ours"]]

    print(f"\n  === OURS ({len(ours)}) — receivable realm APs ===")
    for r in ours[:14]:
        print(f"    {r['median']:7.1f} dBm  {r['grade']:9s} {r['ap']:16s} "
              f"{r['ssid']:14s} ch{str(r['channel'] or '?'):>3s}  "
              f"±{r['spread']:.0f}dB n={r['samples']}")
    if not ours:
        print("    NONE — no realm AP is receivable here. A new link is required.")

    print(f"\n  === FOREIGN ({len(foreign)}) — interference budget ===")
    cong: dict[int, list[float]] = defaultdict(list)
    for r in foreign:
        if r["channel"]:
            cong[r["channel"]].append(r["median"])
    for r in foreign[:6]:
        print(f"    {r['median']:7.1f} dBm  {r['ssid']:22s} ch{r['channel']}")
    if len(foreign) > 6:
        print(f"    ... and {len(foreign)-6} more")

    print("\n  === CHANNEL CONGESTION (foreign only; lower is better) ===")
    # Strongest foreign signal on a channel matters more than how many there are:
    # one loud neighbour ruins a channel that twenty distant ones do not.
    scored = sorted(cong.items(), key=lambda kv: -max(kv[1]))
    for ch, sigs in scored[:8]:
        band = "2.4" if ch <= 14 else "5/6"
        print(f"    ch{ch:<4d} {band:4s} {len(sigs):2d} networks, "
              f"strongest {max(sigs):.0f} dBm")
    clean24 = [c for c in (1, 6, 11) if c not in cong]
    if clean24:
        print(f"    2.4 GHz channels with NO foreign traffic heard: {clean24}")

    best = ours[0] if ours else None
    if best:
        print(f"\n  VERDICT: best realm link here is {best['ap']} "
              f"({best['ssid']}) at {best['median']} dBm — {best['grade']}")
        print(f"           {best['grade_note']}")
        if best["spread"] > 12:
            print(f"           NOTE {best['spread']} dB of variation across the dwell — "
                  f"unstable aim or a moving obstruction. Re-survey before committing.")
    else:
        print("\n  VERDICT: no realm coverage — this site needs a PtP link, not an AP.")

    iperf = None
    if args.iperf:
        print(f"\n  iperf3 -> {args.iperf}")
        r = subprocess.run(["iperf3", "-c", args.iperf, "-t", "8", "-J"],
                           capture_output=True, text=True, timeout=60)
        try:
            j = json.loads(r.stdout)
            bps = j["end"]["sum_received"]["bits_per_second"]
            iperf = {"host": args.iperf, "mbps": round(bps / 1e6, 1)}
            print(f"    {iperf['mbps']} Mbit/s")
        except Exception:
            print(f"    iperf3 failed: {(r.stderr or r.stdout)[:120]}")

    doc = {
        "site": args.site, "note": args.note,
        "when": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
        "iface": iface, "dwell_s": args.dwell, "sweeps": sweeps,
        "fleet_map_aps": fleet.get("aps_probed"),
        "summary": {
            "total_bssids": len(rows),
            "ours_bssids": len(ours),
            "foreign_bssids": len(foreign),
        },
        "best_ours": ({"ap": best["ap"], "ssid": best["ssid"],
                       "median": best["median"], "grade": best["grade"]} if best else None),
        "iperf": iperf,
        "observations": rows,
    }
    stamp = time.strftime("%Y%m%d-%H%M%S")
    safe = re.sub(r"[^a-z0-9._-]+", "-", args.site.lower())
    out = SURVEYS / f"{stamp}-{safe}.json"
    out.write_text(json.dumps(doc, indent=1) + "\n")
    print(f"\n  recorded -> {out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
