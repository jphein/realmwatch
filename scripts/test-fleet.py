#!/usr/bin/env python3
"""End-to-end smoke test for the fleet plugin. Runs against a live server.

Usage: python3 scripts/test-fleet.py [--host http://localhost]
"""

from __future__ import annotations

import argparse
import json
import sys
import urllib.error
import urllib.request


def get(url: str) -> tuple[int, dict]:
    try:
        with urllib.request.urlopen(url, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.reason}


def post(url: str, body: dict) -> tuple[int, dict]:
    req = urllib.request.Request(
        url,
        data=json.dumps(body).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(req, timeout=5) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as e:
        return e.code, {"error": e.reason}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--host", default="http://localhost")
    args = parser.parse_args()

    failures = 0

    print("1. /fleet/list returns >0 entries")
    status, body = get(f"{args.host}/fleet/list")
    if status != 200 or body.get("count", 0) == 0:
        print(f"   FAIL: status={status} count={body.get('count')}")
        failures += 1
    else:
        print(f"   PASS: {body['count']} entries")

    if body.get("count"):
        sample_name = body["entries"][0]["current_name"]
        print(f"2. /fleet/resolve/{sample_name} returns the entry")
        status, body2 = get(f"{args.host}/fleet/resolve/{sample_name}")
        if status != 200 or body2.get("entry", {}).get("current_name") != sample_name:
            print(f"   FAIL: status={status} body={body2}")
            failures += 1
        else:
            print(f"   PASS")

    print("3. /fleet/resolve/does-not-exist returns 404")
    status, body3 = get(f"{args.host}/fleet/resolve/zzz-does-not-exist")
    if status != 404:
        print(f"   FAIL: expected 404, got {status}")
        failures += 1
    else:
        print(f"   PASS")

    print("4. /topology still renders (no regression)")
    status, body4 = get(f"{args.host}/topology")
    if status != 200 or "nodes" not in body4:
        print(f"   FAIL: status={status}")
        failures += 1
    else:
        print(f"   PASS: {len(body4.get('nodes', []))} nodes")

    print("5. /fleet/rename round-trips")
    status, listing = get(f"{args.host}/fleet/list?status=curated")
    if status != 200 or not listing.get("entries"):
        print(f"   FAIL: could not fetch a curated entry (status={status})")
        failures += 1
    else:
        sample = listing["entries"][0]
        fid = sample["fleet_id"]
        orig = sample["current_name"]
        tmp = f"{orig}-test"
        s1, r1 = post(f"{args.host}/fleet/rename",
                      {"fleet_id": fid, "new_name": tmp})
        if s1 != 200 or r1.get("current_name") != tmp:
            print(f"   FAIL: forward rename status={s1} body={r1}")
            failures += 1
        else:
            # Resolve via the OLD name should still find the entry.
            s2, r2 = get(f"{args.host}/fleet/resolve/{orig}")
            if s2 != 200 or r2.get("entry", {}).get("current_name") != tmp:
                print(f"   FAIL: resolve-via-old-name status={s2} body={r2}")
                failures += 1
            # Rename back to restore state.
            s3, r3 = post(f"{args.host}/fleet/rename",
                          {"fleet_id": fid, "new_name": orig})
            if s3 != 200 or r3.get("current_name") != orig:
                print(f"   FAIL: rollback rename status={s3} body={r3}")
                failures += 1
            else:
                print(f"   PASS: {orig} → {tmp} → {orig}")

    if failures:
        print(f"\n{failures} check(s) failed")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
