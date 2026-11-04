"""Builds the scratch DB for sparse.spec.ts: one device (ww-01/ch0), 15
minutes of ~78 W readings that ended 55 minutes ago, and no events.

Lives in web/e2e/ rather than hub/ because it's a test-fixture-only
scenario that hub/seed_demo.py doesn't build (that one always seeds all
three demo devices across --hours of history). It only imports hub/db for
the shared readings schema/connect helper -- the same dependency
hub/seed_demo.py itself has -- and never writes to
hub/energy.db: --db always points at a scratch path
passed on the command line.
"""

import argparse
import random
import sys
import time
from pathlib import Path

HUB = Path(__file__).resolve().parents[2] / "hub"
sys.path.insert(0, str(HUB))
import db  # noqa: E402

DEVICE_ID = "ww-01/ch0"


def build(db_path, now_ms=None):
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    end_ts = now_ms - 55 * 60 * 1000
    start_ts = end_ts - 15 * 60 * 1000

    conn = db.connect(db_path)
    rng = random.Random(1)
    rows = []
    t = start_ts
    while t < end_ts:
        watts = 78.0 + rng.uniform(-1.5, 1.5)
        rows.append((t, DEVICE_ID, watts / 120.0, watts))
        t += 1000
    conn.executemany("INSERT INTO readings VALUES (?,?,?,?)", rows)
    conn.commit()
    conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--db", required=True)
    args = parser.parse_args()
    build(args.db)
    print(f"seed_sparse.py: wrote sparse readings for {DEVICE_ID} to {args.db}")
