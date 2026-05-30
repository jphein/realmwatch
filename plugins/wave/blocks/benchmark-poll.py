#!/usr/bin/env python3
"""Emit the SME benchmark slate as JSON for wave-block `slate` mode.

The benchmark-progress wave block is a *read-only* view over a small JSON
status file that the SME eval runs write. This poller resolves the file,
loads it, and re-emits it on stdout once per poll. No network, no ssh —
the file is the source of truth and the SME harness (or a human) updates
it out of band.

Path resolution (first hit wins):
  1. $REALM_BENCHMARK_SLATE              explicit override
  2. ~/.realmwatch/benchmark-slate.json  live copy (SME runs write here)
  3. <this dir>/benchmark-slate.example.json   shipped read-only fallback

The shipped example is the schema reference and the "nothing wired yet"
default — the block renders a sensible slate even on a fresh checkout.

Schema (realmwatch-benchmark-slate/v1):
  title        str    block title
  updated      str    ISO-8601 of last write (drives the freshness footer)
  benchmarks   list   [{id,label,status,blurb,metrics:[{name,value,kind}]}]
  structural   list   [{id,label,status}]  (SME structural cats)

  status   one of: done | partial | in_progress | pending | blocked
  metric.kind  one of: fraction | number | pending  (fraction → x100 %)

Output is the parsed slate verbatim plus a `_source` field naming which
path won, and `_error` if nothing parsed (so the renderer can surface it).
"""
from __future__ import annotations

import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
EXAMPLE = os.path.join(HERE, "benchmark-slate.example.json")


def _real_home() -> str:
    """Invoking user's home, sudo-aware (map_server may run under sudo).

    Mirrors realm_text.real_home() but kept dependency-free so the poller
    runs standalone over ssh/stdin like the other block collectors.
    """
    for env_var in ("SUDO_USER", "LOGNAME", "USER"):
        user = os.environ.get(env_var)
        if user and user != "root":
            cand = os.path.join("/home", user)
            if os.path.isdir(cand):
                return cand
    return os.path.expanduser("~")


def _candidate_paths() -> list[str]:
    paths: list[str] = []
    override = os.environ.get("REALM_BENCHMARK_SLATE", "").strip()
    if override:
        paths.append(override)
    paths.append(os.path.join(_real_home(), ".realmwatch", "benchmark-slate.json"))
    paths.append(EXAMPLE)
    return paths


def main() -> int:
    last_err = "no slate file found"
    for path in _candidate_paths():
        if not path or not os.path.isfile(path):
            continue
        try:
            with open(path) as f:
                slate = json.load(f)
        except (OSError, json.JSONDecodeError) as e:
            last_err = f"{os.path.basename(path)}: {e}"
            continue
        if not isinstance(slate, dict):
            last_err = f"{os.path.basename(path)}: not a JSON object"
            continue
        slate["_source"] = path
        json.dump(slate, sys.stdout)
        sys.stdout.write("\n")
        return 0

    json.dump({"_error": last_err, "title": "SME Benchmark Slate"}, sys.stdout)
    sys.stdout.write("\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
