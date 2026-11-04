"""Turn per-second flags into rows in the `events` table.

Flagged seconds less than GAP_MS apart merge into one event. The row is written
on the first flag and updated as the event grows, so the dashboard shows it
within a second of detection rather than after it ends.
"""

GAP_MS = 5000


class EventTracker:
    def __init__(self, conn, device_id, method, gap_ms=GAP_MS):
        self.conn = conn
        self.device_id = device_id
        self.method = method
        self.gap_ms = gap_ms
        self.event_id = None
        self.last_flag_ts = None
        self.peak_w = 0.0

    @property
    def is_open(self):
        return self.event_id is not None

    def update(self, ts, watts, flagged, score=None, baseline_w=None):
        if self.is_open and ts - self.last_flag_ts >= self.gap_ms:
            self.event_id = None  # row is already up to date; just stop extending it

        if not flagged:
            return None

        if not self.is_open:
            cur = self.conn.execute(
                "INSERT INTO events (device_id, start_ts, end_ts, peak_w, baseline_w, score, method)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (self.device_id, ts, ts, watts, baseline_w or 0.0, score, self.method),
            )
            self.event_id = cur.lastrowid
            self.peak_w = watts
            self.conn.commit()
            print(f"[{self.method}] event {self.event_id} opened: {watts:.0f} W over {baseline_w or 0:.0f} W")
        elif watts > self.peak_w:
            self.peak_w = watts
            self.conn.execute(
                "UPDATE events SET end_ts = ?, peak_w = ?, score = ? WHERE id = ?",
                (ts, watts, score, self.event_id),
            )
            self.conn.commit()
        else:
            self.conn.execute("UPDATE events SET end_ts = ? WHERE id = ?", (ts, self.event_id))
            self.conn.commit()

        self.last_flag_ts = ts
        return self.event_id
