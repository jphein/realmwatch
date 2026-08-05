#!/usr/bin/env python3
"""Build a BSSID -> AP map for the realm, for the surveyor field terminal.

WHY THIS EXISTS. On 2026-08-05 a WLED node (fishlight) was unreachable because it
had roamed onto a distant AP. Diagnosing it meant answering "whose BSSID is
02:25:9C:13:71:C0?" — and there was no way to answer it. I checked the six APs I
happened to know, found nothing, and escalated it as a possible ROGUE AP
broadcasting the house SSID. It was `north-path`: an ordinary fleet member I did
not know existed. An incomplete inventory turned a normal device into a scare.

So: enumerate the fleet from `realm fleet` (the roster, never a hand-kept list),
ask every AP what BSSIDs it actually broadcasts, and write it out. The surveyor
then classifies every BSSID it hears as OURS (which AP, which radio) or FOREIGN
(interference) instead of "unknown".

Run on a host with SSH access to the APs (katana), then deploy to the surveyor:

    scripts/surveyor_fleet_map.py                     # write + show
    scripts/surveyor_fleet_map.py --deploy surveyor   # ...and scp it over

READ BSSIDs WITH `iwinfo`, NEVER BY PARSING `iw dev`. In `iw dev` output the
`addr` line comes BEFORE `ssid`, so any awk that prints on `addr` emits the
PREVIOUS interface's SSID. Every row still looks plausible — real BSSIDs, real
SSIDs — while the whole mapping is shifted by one. That bug produced a confident,
completely wrong answer during the same incident. `iwinfo <iface> info` reports
the association as a unit and cannot shear like that.
"""
from __future__ import annotations

import argparse
import concurrent.futures
import json
import pathlib
import re
import subprocess
import sys

OUT = pathlib.Path.home() / ".cache/realm-fleet-bssids.json"
SSH = ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8",
       "-o", "StrictHostKeyChecking=accept-new"]

# One round-trip per AP. `iwinfo` with no args lists the wireless interfaces;
# `iwinfo <if> info` then gives ESSID + Access Point + Channel together.
PROBE = r"""
for i in $(iwinfo 2>/dev/null | awk '/ESSID/{print $1}'); do
  iwinfo "$i" info 2>/dev/null | tr '\n' '\f' | sed 's/\f/\n/g' | awk -v I="$i" '
    /ESSID/ {s=$0; sub(/.*ESSID: /,"",s); gsub(/"/,"",s); e=s}
    /Access Point/ {s=$0; sub(/.*Access Point: /,"",s); gsub(/ /,"",s); a=s}
    /Channel/ {s=$0; sub(/.*Channel: /,"",s); split(s,c," "); ch=c[1]}
    END {if (a != "") printf "%s|%s|%s|%s\n", I, a, ch, e}'
done
"""


def fleet_aps() -> list[str]:
    """The roster comes from `realm fleet` — never a list typed by hand."""
    try:
        r = subprocess.run(["realm", "fleet"], capture_output=True, text=True, timeout=60)
    except FileNotFoundError:
        sys.exit("`realm` not on PATH — it is the source of truth for the roster")
    aps, in_ap = [], False
    for line in r.stdout.splitlines():
        if re.match(r"^\s*Access Points\s*$", line):
            in_ap = True
            continue
        if in_ap:
            if re.match(r"^\s*$", line):
                continue
            # A new unindented section header ends the AP block.
            if not line.startswith(("  ", "\t")):
                break
            aps.append(line.split()[0])
    return aps


def probe(ap: str) -> tuple[str, list[dict]]:
    try:
        r = subprocess.run(SSH + [f"root@{ap}", PROBE],
                           capture_output=True, text=True, timeout=25)
    except subprocess.TimeoutExpired:
        return ap, []
    rows = []
    for line in r.stdout.strip().splitlines():
        parts = line.split("|")
        if len(parts) != 4 or not parts[1]:
            continue
        iface, bssid, chan, essid = parts
        try:
            ch = int(chan)
        except ValueError:
            ch = None
        rows.append({
            "iface": iface,
            "bssid": bssid.upper(),
            "channel": ch,
            # 2.4 GHz is ch 1-14; anything higher is 5/6 GHz. Band matters for a
            # survey because a client that is 2.4-only (every ESP32) simply
            # cannot see half the fleet.
            "band": ("2.4" if ch and ch <= 14 else "5" if ch else "?"),
            "ssid": essid,
        })
    return ap, rows


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--deploy", metavar="HOST", help="scp the map to HOST after building")
    ap.add_argument("--out", default=str(OUT))
    args = ap.parse_args()

    aps = fleet_aps()
    if not aps:
        sys.exit("`realm fleet` returned no Access Points — refusing to write an empty map")
    print(f"  roster: {len(aps)} APs from `realm fleet`")

    bssids: dict[str, dict] = {}
    unreachable = []
    with concurrent.futures.ThreadPoolExecutor(max_workers=12) as ex:
        for name, rows in ex.map(probe, aps):
            if not rows:
                unreachable.append(name)
                continue
            for r in rows:
                bssids[r["bssid"]] = {"ap": name, **r}

    # A map built from a partial sweep is WORSE than no map: every BSSID from a
    # skipped AP would be reported as FOREIGN, i.e. as an intruder. Say so loudly
    # rather than silently shipping a file that mislabels our own hardware.
    if unreachable:
        print(f"  WARNING unreachable ({len(unreachable)}): {', '.join(unreachable)}")
        print("  -> their BSSIDs will read as FOREIGN in surveys until they answer")

    doc = {
        "aps_total": len(aps),
        "aps_probed": len(aps) - len(unreachable),
        "unreachable": unreachable,
        "bssids": bssids,
        "ssids": sorted({v["ssid"] for v in bssids.values() if v["ssid"]}),
    }
    out = pathlib.Path(args.out)
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(doc, indent=1, sort_keys=True) + "\n")
    print(f"  {len(bssids)} BSSIDs across {doc['aps_probed']} APs -> {out}")
    print(f"  SSIDs in the realm: {', '.join(doc['ssids'])}")

    if args.deploy:
        subprocess.run(["scp", "-o", "BatchMode=yes", str(out),
                        f"{args.deploy}:.cache/realm-fleet-bssids.json"], check=False)
        print(f"  deployed -> {args.deploy}:~/.cache/realm-fleet-bssids.json")
    return 0


if __name__ == "__main__":
    sys.exit(main())
