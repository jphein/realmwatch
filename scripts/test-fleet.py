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

    if failures:
        print(f"\n{failures} check(s) failed")
        return 1
    print("\nall checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
