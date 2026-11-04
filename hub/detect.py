"""Detection loop: once per second, run both detectors over new readings.

The rule always runs. The Isolation Forest joins as soon as model.joblib exists
(train it while this keeps running; it is picked up without a restart).

    python detect.py
"""

import time

from db import connect
from detect_iforest import MODEL_PATH, IForestDetector
from detect_rule import RuleDetector
from events import EventTracker
from heartbeat import Heartbeat

WARMUP_MS = 600_000  # replay the last 10 min on start, without emitting events


class Device:
    def __init__(self, conn, device_id):
        self.rule = RuleDetector()
        self.rule_events = EventTracker(conn, device_id, "rule")
        self.iforest = IForestDetector.load()
        self.iforest_events = EventTracker(conn, device_id, "iforest")

    def step(self, ts, watts, live=True):
        flagged, score, base = self.rule.step(ts, watts)
        if live:
            self.rule_events.update(ts, watts, flagged, score, base)
        if self.iforest:
            flagged, score, base = self.iforest.step(ts, watts)
            if live:
                self.iforest_events.update(ts, watts, flagged, score, base)


def main():
    conn = connect()
    hb = Heartbeat(conn, "detect")
    devices = {}
    model_mtime = MODEL_PATH.stat().st_mtime if MODEL_PATH.exists() else None

    def device(device_id):
        if device_id not in devices:
            devices[device_id] = Device(conn, device_id)
        return devices[device_id]

    def rows_after(rowid, until_rowid=None):
        q = "SELECT rowid, ts, device_id, watts FROM readings WHERE rowid > ?"
        args = [rowid]
        if until_rowid is not None:
            q += " AND rowid <= ?"
            args.append(until_rowid)
        return conn.execute(q + " ORDER BY rowid", args).fetchall()

    # Replay the last 10 min so the baselines are ready before the first live second.
    since = int(time.time() * 1000) - WARMUP_MS
    start = conn.execute(
        "SELECT COALESCE(MIN(rowid) - 1, (SELECT COALESCE(MAX(rowid), 0) FROM readings))"
        " FROM readings WHERE ts >= ?", (since,)
    ).fetchone()[0]
    last_rowid = start
    for r in rows_after(start):
        device(r["device_id"]).step(r["ts"], r["watts"], live=False)
        last_rowid = r["rowid"]
    print(f"warmed up on {len(devices)} device(s); iforest {'on' if model_mtime else 'off'}; detecting")
    hb.tick({"devices": len(devices), "iforest": bool(model_mtime)}, force=True)

    while True:
        hb.tick({"devices": len(devices), "iforest": bool(model_mtime)})
        mtime = MODEL_PATH.stat().st_mtime if MODEL_PATH.exists() else None
        if mtime and mtime != model_mtime:
            try:
                loaded = {k: IForestDetector.load() for k in devices}
            except Exception as e:  # file still being written by train
                print(f"model not ready ({e}); retrying")
                loaded = None
        if mtime and mtime != model_mtime and loaded is not None:
            model_mtime = mtime
            # New model: prime its 10-min buffer from history so it scores immediately.
            for k, d in devices.items():
                d.iforest = loaded[k]
            for r in rows_after(start, last_rowid):
                d = device(r["device_id"])
                if d.iforest and r["ts"] >= int(time.time() * 1000) - WARMUP_MS:
                    d.iforest.step(r["ts"], r["watts"])
            print(f"loaded {MODEL_PATH.name}; Isolation Forest live")

        for r in rows_after(last_rowid):
            device(r["device_id"]).step(r["ts"], r["watts"])
            last_rowid = r["rowid"]
        time.sleep(1)


if __name__ == "__main__":
    main()
