"""Service heartbeats for the System page.

Each long-running process calls `tick()` from its loop; a row in
`service_status` older than 15 s reads as stale, older than 60 s as down.

    hb = Heartbeat(conn, "detect")
    while True:
        ...
        hb.tick({"devices": 1})
"""

import json
import os
import time

INTERVAL_S = 5


class Heartbeat:
    def __init__(self, conn, service):
        self.conn = conn
        self.service = service
        self.started_ts = int(time.time() * 1000)
        self.last = 0.0

    def tick(self, info=None, force=False):
        now = time.time()
        if not force and now - self.last < INTERVAL_S:
            return
        self.last = now
        try:
            self.conn.execute(
                "INSERT INTO service_status (service, pid, started_ts, heartbeat_ts, info)"
                " VALUES (?, ?, ?, ?, ?)"
                " ON CONFLICT(service) DO UPDATE SET pid = excluded.pid,"
                " started_ts = excluded.started_ts, heartbeat_ts = excluded.heartbeat_ts,"
                " info = excluded.info",
                (self.service, os.getpid(), self.started_ts, int(now * 1000),
                 json.dumps(info) if info is not None else None),
            )
            self.conn.commit()
        except Exception as e:  # a heartbeat must never take its service down
            print(f"heartbeat {self.service}: {e}")
