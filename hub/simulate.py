"""Fake plug node for building without hardware: POSTs one reading per second.

    python simulate.py                      # idle ~45 W with noise, kettle on 's'+Enter
    python simulate.py --auto 90            # kettle on for 60 s every 90 s
    python simulate.py --backfill 60        # write 60 min of history straight to the DB, then exit

Never run it alongside the real node when collecting training data.
"""

import argparse
import random
import sys
import threading
import time

import requests

KETTLE_W = 1480.0
IDLE_W = 45.0


def idle_watts():
    return max(0.0, random.gauss(IDLE_W, 3.0) + (random.random() < 0.02) * random.uniform(20, 80))


def backfill(minutes, device_id):
    from db import connect
    from ingest import VOLTS

    conn = connect()
    now = int(time.time() * 1000)
    rows = []
    for i in range(minutes * 60, 0, -1):
        w = idle_watts()
        rows.append((now - i * 1000, device_id, w / VOLTS, w))
    conn.executemany("INSERT INTO readings VALUES (?, ?, ?, ?)", rows)
    conn.commit()
    print(f"backfilled {len(rows)} idle readings")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--url", default="http://127.0.0.1:8000/ingest")
    ap.add_argument("--device", default="plug-1")
    ap.add_argument("--auto", type=int, metavar="SECONDS")
    ap.add_argument("--backfill", type=int, metavar="MINUTES")
    args = ap.parse_args()

    if args.backfill:
        backfill(args.backfill, args.device)
        return

    kettle_until = [0.0]

    def keys():
        for line in sys.stdin:
            if line.strip().lower().startswith("s"):
                kettle_until[0] = time.time() + 60
                print("kettle on for 60 s")

    threading.Thread(target=keys, daemon=True).start()
    start = time.time()
    while True:
        t = time.time()
        if args.auto and int(t - start) % args.auto == args.auto // 3 and t > kettle_until[0]:
            kettle_until[0] = t + 60
            print("kettle on for 60 s")
        w = idle_watts() + (random.gauss(KETTLE_W, 15) if t < kettle_until[0] else 0)
        try:
            requests.post(args.url, json={"device_id": args.device, "irms_a": w / 120, "watts": w},
                          timeout=1)
        except requests.RequestException as e:
            print(f"post failed: {e}")
        time.sleep(max(0.0, 1 - (time.time() - t)))


if __name__ == "__main__":
    main()
