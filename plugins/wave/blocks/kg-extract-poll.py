#!/usr/bin/env python3
"""Translate familiar-kgops.sh JSON into the wave-block backfill log-line format.

Lets `wave-block.py backfill --cmd 'python3 kg-extract-poll.py'` reuse the
polished `render_backfill` template (progress bar, sparklines, wave banners,
bar chart, multi-worker awareness) for OUR KG-extract queue — which is a
separate queue from the AGE backfill the original poller targets.

Output line shape parsed by wave-block's BackfillState:
  backfill: drawers_seen=N entities_added=N skipped=0 errors=N rate=N.N/s workers=N

Where for the KG-extract queue:
  drawers_seen      = completed extraction-queue rows
  entities_added    = SUM(triples_extracted)  (triple count surfaced as the "entities" metric)
  errors            = rows with error NOT NULL
  rate              = drained per second (derived from the JSON's per-minute rate)
  workers           = count of active mempalace-kg-extract@* worker units
"""
from __future__ import annotations

import json
import os
import subprocess
import sys
import time

HERE = os.path.dirname(os.path.abspath(__file__))
# kgops-collect.py lives on familiar (it uses `docker exec mempalace-db psql`,
# which only works where the postgres container runs). SSH there each poll.
COLLECTOR_REMOTE_PATH = "/home/jp/Projects/familiar.realm.watch/ops/scripts/kgops-collect.py"
SSH_HOST = os.environ.get("KGOPS_SSH_HOST", "familiar")


def main() -> int:
    try:
        out = subprocess.check_output(
            ["ssh", "-o", "ConnectTimeout=8", SSH_HOST, f"python3 {COLLECTOR_REMOTE_PATH}"],
            text=True,
            timeout=20,
        )
    except subprocess.CalledProcessError as e:
        print(f"# kg-extract-poll: ssh collector failed exit={e.returncode}", file=sys.stderr)
        return 1
    except subprocess.TimeoutExpired:
        print("# kg-extract-poll: ssh collector timeout", file=sys.stderr)
        return 1

    try:
        m = json.loads(out)
    except json.JSONDecodeError:
        print("# kg-extract-poll: collector did not emit valid JSON", file=sys.stderr)
        return 1

    done = int(m.get("kg_completed", 0))
    incomplete = int(m.get("kg_incomplete", 0))
    errors = int(m.get("kg_errors", 0))
    entities = int(m.get("kg_total_triples", done))
    rate_per_min = float(m.get("kg_rate_per_min", 0.0))
    rate_per_s = rate_per_min / 60.0

    workers = sum(1 for k, v in m.items() if k.startswith("worker_") and v == "active")
    workers = max(workers, 1)

    # Match the shape parse_backfill_status() expects: a status JSON whose
    # recent_output[-1] is the canonical log-line we'd otherwise stream.
    total = done + incomplete
    log_line = (
        f"{time.strftime('%Y-%m-%d %H:%M:%S')} mempalace.kg_extract INFO "
        f"backfill: drawers_seen={done} entities_added={entities} "
        f"skipped=0 errors={errors} rate={rate_per_s:.2f}/s workers={workers}"
    )
    json.dump(
        {
            "in_progress": incomplete > 0,
            "elapsed_seconds": 0,
            "total_drawers": total,
            "checkpointed_drawers": done,
            "recent_output": [log_line],
        },
        sys.stdout,
    )
    sys.stdout.write("\n")
    sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main())
