"""Builds a realistic demo/test SQLite DB: three devices, `hours` of 1 Hz
readings ending at `now_ms`, console tables (via store.init), and one rule +
one iforest event per kettle boil / heater run, with Llama-style explanation
text -- so the alert worker and every console page have real data to show.

    python seed_demo.py --db PATH [--hours 24]
    python seed_demo.py --db PATH --follow     # seed, then keep appending live data

`--follow` is a long-running process meant to be spawned by a dev/e2e harness
(see web/e2e/serve.mjs) so the console has real-looking live-updating data
instead of a demo DB that goes stale and flips every device to "offline"
mid-session. It appends one reading/second to every device except the
(deliberately offline) Fridge, with idle noise and a kettle boil every 4 min,
writing matching rule + iforest events for each boil so live alerts appear
too. It exits cleanly on SIGTERM, SIGINT, or its parent process going away.
"""

import argparse
import json
import os
import random
import signal
import threading
import time

import db
import store
from heartbeat import Heartbeat
from ingest import telemetry as fw_telemetry
from ingest import upsert_node_status

# node_id, ports (port, device_id), fw, boots, online
NODE_FW = "0.1.1-a"
ALL_SERVICES = ["ingest", "detect", "explain", "alerts", "api", "digest"]
# seed_demo fakes service_status for the processes that don't really run against a demo DB
# (there's no real ingest/detect/explain/digest -- the data is synthesized directly). It must
# NOT fake "alerts" or "api": every real deployment (this one, and web/e2e/serve.mjs) always
# pairs seed_demo.py with a genuine alerts.py and api.py, and a second, faked heartbeat for
# the same service name races the real one and intermittently shows the wrong pid.
FAKE_HEARTBEAT_SERVICES = [s for s in ALL_SERVICES if s not in ("alerts", "api")]
# Each faked service gets its own pid and start time (see _FakeHeartbeat) instead of all of
# them sharing seed_demo's own pid, which reads as one process impersonating six.
FAKE_PID_BASE = 41000

# crest_factor = peak_raw_a / irms_raw_a. A resistive load (kettle, space heater) draws a
# clean sine, crest ~1.41 (sqrt(2)); a fridge compressor's motor inrush is spikier, ~1.8.
CREST_FACTOR = {"ww-01/ch0": 1.41, "ww-01/ch1": 1.41, "ww-02/ch0": 1.8}


def _fake_service_meta(now_ms):
    """pid, started_ts per faked service: distinct and staggered, so the System page's
    service grid doesn't show the same pid six times over."""
    return {
        service: (FAKE_PID_BASE + i, now_ms - 3_600_000 - i * 97_000)
        for i, service in enumerate(FAKE_HEARTBEAT_SERVICES)
    }


class _FakeHeartbeat:
    """Like heartbeat.Heartbeat, but stamps a fixed fake pid/started_ts instead of
    os.getpid() -- heartbeat.Heartbeat always uses the real pid, which for a faked demo
    service (seed_demo's own process) would mean every faked service shares one pid.
    """

    INTERVAL_S = 5

    def __init__(self, conn, service, pid, started_ts):
        self.conn = conn
        self.service = service
        self.pid = pid
        self.started_ts = started_ts
        self.last = 0.0

    def tick(self, info=None, force=False):
        now = time.time()
        if not force and now - self.last < self.INTERVAL_S:
            return
        self.last = now
        self.conn.execute(
            "INSERT INTO service_status (service, pid, started_ts, heartbeat_ts, info)"
            " VALUES (?, ?, ?, ?, ?)"
            " ON CONFLICT(service) DO UPDATE SET pid = excluded.pid,"
            " started_ts = excluded.started_ts, heartbeat_ts = excluded.heartbeat_ts,"
            " info = excluded.info",
            (self.service, self.pid, self.started_ts, int(now * 1000),
             json.dumps(info) if info is not None else None),
        )
        self.conn.commit()

# device_id, name, kind, room, rated_w
DEVICES = [
    ("ww-01/ch0", "Kettle", "kettle", "kitchen", 1500.0),
    ("ww-01/ch1", "Space heater", "heater", "office", 1500.0),
    ("ww-02/ch0", "Fridge", "fridge", "kitchen", 150.0),
]

EXPLANATIONS = [
    "Likely the kettle boiling (high confidence). Normal: short, well above baseline, done soon.",
    "Matches a kettle boil based on peak wattage and duration (high confidence). Looks normal.",
    "Consistent with the kettle starting a boil cycle (high confidence). Nothing to check here.",
    "Space heater turning on draws a long steady load like this (high confidence). Normal if "
    "intentional; check it was not left unattended.",
    "Sustained ~1450 W matches the space heater (high confidence). Worth checking it was meant "
    "to run this long.",
]


def _idle(rng, n, lo=8.0, hi=12.0):
    return [rng.uniform(lo, hi) for _ in range(n)]


def _kettle_watts(rng, total_s):
    """6 boils of 1480 W for 120-200 s, idle noise otherwise. Returns (watts, [(start_s, dur_s)])."""
    watts = _idle(rng, total_s)
    boils = []
    for i in range(6):
        start_s = int((i + 0.5) * total_s / 6)
        dur_s = min(rng.randint(120, 200), total_s - start_s)
        for j in range(dur_s):
            watts[start_s + j] = 1480.0 + rng.uniform(-10, 10)
        boils.append((start_s, dur_s))
    return watts, boils


def _heater_watts(rng, total_s):
    """2 long runs of 1450 W, idle noise otherwise. Returns (watts, [(start_s, dur_s)])."""
    watts = _idle(rng, total_s)
    runs = []
    for frac in (0.25, 0.65):
        start_s = int(frac * total_s)
        dur_s = min(rng.randint(1200, 2400), total_s - start_s)  # 20-40 min
        for j in range(dur_s):
            watts[start_s + j] = 1450.0 + rng.uniform(-10, 10)
        runs.append((start_s, dur_s))
    return watts, runs


def _fridge_watts(rng, total_s):
    """Cycles 0/110 W every ~20 min."""
    watts = []
    on, toggle_at = False, 0
    for s in range(total_s):
        if s >= toggle_at:
            on = not on
            toggle_at = s + rng.randint(15, 25) * 60
        watts.append((110.0 + rng.uniform(-5, 5)) if on else 0.0)
    return watts


def build(db_path, now_ms=None, hours=24):
    now_ms = now_ms if now_ms is not None else int(time.time() * 1000)
    total_s = hours * 3600
    start_ms = now_ms - total_s * 1000
    rng = random.Random(42)

    conn = db.connect(db_path)
    store.init(conn)
    conn.executemany(
        "INSERT INTO devices (device_id, name, kind, room, rated_w, created_ts) VALUES (?, ?, ?, ?, ?, ?)",
        [(device_id, name, kind, room, rated_w, now_ms) for device_id, name, kind, room, rated_w in DEVICES],
    )

    kettle_watts, boils = _kettle_watts(rng, total_s)
    heater_watts, runs = _heater_watts(rng, total_s)
    fridge_watts = _fridge_watts(rng, total_s)
    fridge_n = max(0, total_s - 300)  # ww-02/ch0 stops 5 min before now_ms: offline device

    def rows(device_id, watts_list, n=None):
        n = len(watts_list) if n is None else n
        return [(start_ms + i * 1000, device_id, watts_list[i] / 120.0, watts_list[i]) for i in range(n)]

    conn.executemany("INSERT INTO readings VALUES (?, ?, ?, ?)", rows("ww-01/ch0", kettle_watts))
    conn.executemany("INSERT INTO readings VALUES (?, ?, ?, ?)", rows("ww-01/ch1", heater_watts))
    conn.executemany("INSERT INTO readings VALUES (?, ?, ?, ?)", rows("ww-02/ch0", fridge_watts, fridge_n))
    conn.commit()

    events = []  # device_id, start_ts, end_ts, peak_w, baseline_w, explanation, appliance, verdict
    for i, (start_s, dur_s) in enumerate(boils):
        if dur_s <= 0:
            continue
        last = i == len(boils) - 1  # last kettle event: explanation stays NULL ("Explaining...")
        explanation = None if last else EXPLANATIONS[i % 3]
        events.append(("ww-01/ch0", start_ms + start_s * 1000,
                        start_ms + (start_s + dur_s - 1) * 1000, 1480.0, 10.0, explanation,
                        "Kettle", "normal"))
    for i, (start_s, dur_s) in enumerate(runs):
        if dur_s <= 0:
            continue
        explanation = EXPLANATIONS[3 + (i % 2)]
        verdict = "check" if i == 1 else "normal"  # the second long run reads "worth checking"
        events.append(("ww-01/ch1", start_ms + start_s * 1000,
                        start_ms + (start_s + dur_s - 1) * 1000, 1450.0, 10.0, explanation,
                        "Space heater", verdict))

    for device_id, start_ts, end_ts, peak_w, baseline_w, explanation, appliance, verdict in events:
        rule_id = conn.execute(
            "INSERT INTO events (device_id, start_ts, end_ts, peak_w, baseline_w, score, method, explanation)"
            " VALUES (?, ?, ?, ?, ?, 8.0, 'rule', ?)",
            (device_id, start_ts, end_ts, peak_w, baseline_w, explanation),
        ).lastrowid
        conn.execute(
            "INSERT INTO events (device_id, start_ts, end_ts, peak_w, baseline_w, score, method, explanation)"
            " VALUES (?, ?, ?, ?, ?, -0.2, 'iforest', ?)",
            (device_id, start_ts, end_ts, peak_w, baseline_w, explanation),
        )
        if explanation is not None:
            conn.execute(
                "INSERT INTO explanations (event_id, appliance, confidence, verdict, summary,"
                " model, prompt_version, latency_ms, fallback, created_ts)"
                " VALUES (?, ?, 'high', ?, ?, 'llama3.2:3b', 'v2', ?, 0, ?)",
                (rule_id, appliance, verdict, explanation, 400 + rng.randint(0, 300), end_ts),
            )
    conn.commit()

    _seed_v2_extras(conn, now_ms, start_ms, total_s)


def _seed_v2_extras(conn, now_ms, start_ms, total_s):
    """node_status/node_telemetry, structured insights, service_status and audit_log for the
    demo, so every v2 console page has something real to show before --follow even starts.
    """
    # node_status: ww-01 has 2 ports, fw "0.1.1-a", 2 boots (one reboot partway through the
    # seeded window); ww-02/ch0 is the deliberately offline fridge, last seen 5 min ago.
    # Representative irms per device (the fridge's is its on-cycle draw, 110 W, not the 0 W
    # it happens to read right now -- a crest factor needs a nonzero current to be meaningful).
    irms_a = {"ww-01/ch0": 1480.0 / 120, "ww-01/ch1": 10.0 / 120, "ww-02/ch0": 110.0 / 120}
    node_rows = [
        # node_id, port, device_id, fw, boot_id, uptime_ms, n_samples, irms_raw_a, peak_raw_a,
        # over_limit, first_seen_ts, last_ts, boots, readings
        ("ww-01", "ch0", "ww-01/ch0", NODE_FW, "demo-boot-2", int(total_s * 1000 / 3),
         861, round(irms_a["ww-01/ch0"], 4), round(irms_a["ww-01/ch0"] * CREST_FACTOR["ww-01/ch0"], 4),
         0, start_ms, now_ms, 2, total_s),
        ("ww-01", "ch1", "ww-01/ch1", NODE_FW, "demo-boot-2", int(total_s * 1000 / 3),
         861, round(irms_a["ww-01/ch1"], 4), round(irms_a["ww-01/ch1"] * CREST_FACTOR["ww-01/ch1"], 4),
         0, start_ms, now_ms, 2, total_s),
        ("ww-02", "ch0", "ww-02/ch0", NODE_FW, "demo-boot-1", total_s * 1000,
         861, round(irms_a["ww-02/ch0"], 4), round(irms_a["ww-02/ch0"] * CREST_FACTOR["ww-02/ch0"], 4),
         0, start_ms, now_ms - 300_000, 1, max(0, total_s - 300)),
    ]
    conn.executemany(
        "INSERT INTO node_status (node_id, port, device_id, fw, boot_id, uptime_ms, n_samples,"
        " irms_raw_a, peak_raw_a, over_limit, first_seen_ts, last_ts, boots, readings)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
        node_rows,
    )

    # node_telemetry: dense samples (every 10 s, matching the real every-10th-reading rate)
    # for the last hour of each node, enough for the Node detail telemetry charts.
    telem_window_s = min(total_s, 3600)
    telem_irms_a = {"ww-01/ch0": 0.0805, "ww-01/ch1": 0.08, "ww-02/ch0": round(110.0 / 120, 4)}
    telem = []
    for node_id, port in (("ww-01", "ch0"), ("ww-01", "ch1"), ("ww-02", "ch0")):
        device_id = f"{node_id}/{port}"
        last_ts = now_ms if node_id == "ww-01" else now_ms - 300_000
        irms = telem_irms_a[device_id]
        crest = CREST_FACTOR[device_id]
        for s in range(0, telem_window_s, 10):
            ts = last_ts - (telem_window_s - s) * 1000
            telem.append((ts, node_id, port, s * 1000, 861, irms, round(irms * crest, 4), 0))
    conn.executemany(
        "INSERT INTO node_telemetry (ts, node_id, port, uptime_ms, n_samples, irms_raw_a,"
        " peak_raw_a, over_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        telem,
    )

    # 2 daily digests: yesterday's (closed out) and today's (so far).
    day_start = store.day_start_ms(now_ms)
    yesterday_start = day_start - 86_400_000
    conn.execute(
        "INSERT INTO insights (kind, created_ts, period_start, period_end, title, body, model, latency_ms)"
        " VALUES ('daily_digest', ?, ?, ?, ?, ?, 'llama3.2:3b', ?)",
        (day_start - 3_600_000, yesterday_start, day_start, "Yesterday: 3.1 kWh, $0.47",
         "The kettle boiled 6 times and the space heater ran twice in the office, including one "
         "run worth a second look. Everything else idled normally.", 612),
    )
    conn.execute(
        "INSERT INTO insights (kind, created_ts, period_start, period_end, title, body, model, latency_ms)"
        " VALUES ('daily_digest', ?, ?, ?, ?, ?, 'llama3.2:3b', ?)",
        (now_ms - 900_000, day_start, now_ms, "Today so far: 1.9 kWh, $0.28",
         "Usage looks ordinary so far: the kettle has boiled a few times and the fridge is "
         "cycling normally. The fridge has been offline for the last few minutes.", 548),
    )

    # service_status: all six services reporting as healthy, as if run_all.py were running.
    # The faked services (ingest/detect/explain/digest -- there's no real process behind
    # them against a demo DB) each get their own pid and start time. alerts/api are real
    # processes that always pair with seed_demo; this is just a placeholder row until their
    # own first heartbeat lands (within 5 s) and overwrites it with the real pid.
    meta = _fake_service_meta(now_ms)
    for service in FAKE_HEARTBEAT_SERVICES:
        pid, started_ts = meta[service]
        _FakeHeartbeat(conn, service, pid, started_ts).tick(info={"mode": "demo"}, force=True)
    for service in ("alerts", "api"):
        Heartbeat(conn, service).tick(info={"mode": "demo"}, force=True)

    # audit_log: a few plausible local-admin actions for the Audit table.
    audit_rows = [
        (now_ms - 3_600_000, "local admin", "patch_device", "ww-01/ch0", json.dumps({"name": "Kettle"})),
        (now_ms - 3_000_000, "local admin", "ack_alert", "1", None),
        (now_ms - 1_800_000, "local admin", "generate_digest", None, None),
        (now_ms - 600_000, "local admin", "patch_settings", None, json.dumps({"price_per_kwh": 0.15})),
    ]
    conn.executemany(
        "INSERT INTO audit_log (ts, actor, action, target, detail) VALUES (?, ?, ?, ?, ?)",
        audit_rows,
    )
    conn.commit()


# --follow: every device except the offline Fridge keeps getting readings.
FOLLOW_DEVICES = ["ww-01/ch0", "ww-01/ch1"]
BOIL_DEVICE = "ww-01/ch0"
BOIL_PERIOD_S = 240  # a boil starts every 4 min
BOIL_DURATION_S = 90
BOIL_W = 1480.0


def _watch_parent(stop):
    """Set `stop` once the process that spawned us is gone, so an orphaned --follow
    process (e.g. its harness was killed without a clean shutdown) does not run forever.
    Non-destructive: only checks liveness, never signals the parent.
    """
    ppid = os.getppid()
    if os.name == "nt":
        import ctypes

        PROCESS_SYNCHRONIZE = 0x00100000
        handle = ctypes.windll.kernel32.OpenProcess(PROCESS_SYNCHRONIZE, False, ppid)
        if not handle:
            return  # no permission/parent already gone before we could check; let signals handle it
        try:
            while not stop.is_set():
                if ctypes.windll.kernel32.WaitForSingleObject(handle, 500) == 0:  # WAIT_OBJECT_0: signaled = exited
                    stop.set()
                    return
        finally:
            ctypes.windll.kernel32.CloseHandle(handle)
    else:
        while not stop.is_set():
            if os.getppid() != ppid:  # reparented to init: our parent died
                stop.set()
                return
            stop.wait(0.5)


def _write_boil_events(conn, device_id, start_ts, end_ts, rng):
    """Writes the rule + iforest event rows for one completed boil, plus a structured
    `explanations` row for the rule event (same shape explain.py v2 writes: appliance,
    confidence, verdict, summary, model "llama3.2:3b", prompt_version "v2") so a new
    incident that lands while --follow is running has real AI meta, not just the legacy
    plain-text `events.explanation` line.
    """
    explanation = rng.choice(EXPLANATIONS[:3])
    rule_event_id = None
    for method, score in (("rule", 8.0), ("iforest", -0.2)):
        cur = conn.execute(
            "INSERT INTO events (device_id, start_ts, end_ts, peak_w, baseline_w, score, method, explanation)"
            " VALUES (?, ?, ?, ?, 10.0, ?, ?, ?)",
            (device_id, start_ts, end_ts, BOIL_W, score, method, explanation),
        )
        if method == "rule":
            rule_event_id = cur.lastrowid
    conn.execute(
        "INSERT INTO explanations (event_id, appliance, confidence, verdict, summary,"
        " model, prompt_version, latency_ms, fallback, created_ts)"
        " VALUES (?, 'Kettle', 'high', 'normal', ?, 'llama3.2:3b', 'v2', ?, 0, ?)",
        (rule_event_id, explanation, 400 + rng.randint(0, 300), end_ts),
    )
    conn.commit()


def follow(db_path):
    """Append one reading/second to every device in FOLLOW_DEVICES, with idle noise and a
    kettle boil (1480 W, 90 s) every 4 min, until SIGTERM/SIGINT/parent death. Writes a
    matching rule + iforest event for each completed boil.
    """
    conn = db.connect(db_path)
    store.init(conn)
    rng = random.Random()
    stop = threading.Event()

    def _request_stop(*_args):
        stop.set()

    signal.signal(signal.SIGINT, _request_stop)
    signal.signal(signal.SIGTERM, _request_stop)
    if hasattr(signal, "SIGBREAK"):  # Windows Ctrl+Break / some process-group kills
        signal.signal(signal.SIGBREAK, _request_stop)

    threading.Thread(target=_watch_parent, args=(stop,), daemon=True).start()

    meta = _fake_service_meta(int(time.time() * 1000))
    heartbeats = {s: _FakeHeartbeat(conn, s, *meta[s]) for s in FAKE_HEARTBEAT_SERVICES}

    print(f"seed_demo --follow: appending 1 reading/s to {FOLLOW_DEVICES}", flush=True)
    t_start = time.time()
    boil_start_ts = None
    try:
        while not stop.is_set():
            now_ms = int(time.time() * 1000)
            elapsed_s = int(time.time() - t_start)
            boiling = (elapsed_s % BOIL_PERIOD_S) < BOIL_DURATION_S

            for device_id in FOLLOW_DEVICES:
                if device_id == BOIL_DEVICE and boiling:
                    watts = BOIL_W + rng.uniform(-10, 10)
                else:
                    watts = rng.uniform(8.0, 12.0)
                conn.execute(
                    "INSERT INTO readings VALUES (?, ?, ?, ?)", (now_ms, device_id, watts / 120.0, watts)
                )
                # Keep node_status/node_telemetry fresh too, via the same path real firmware
                # telemetry takes in ingest.py, so the Nodes page stays "live" during the demo.
                node_id, port = device_id.split("/", 1)
                fw_raw = {
                    "device_id": node_id, "port": port, "boot_id": "demo-boot-2",
                    "uptime_ms": elapsed_s * 1000, "irms_raw_a": round(watts / 120.0, 4),
                    "peak_raw_a": round(watts * CREST_FACTOR[device_id] / 120.0, 4), "n_samples": 861,
                    "over_limit": False, "fw": NODE_FW,
                }
                upsert_node_status(conn, fw_telemetry(fw_raw), now_ms)
            conn.commit()

            for service in FAKE_HEARTBEAT_SERVICES:  # _FakeHeartbeat.tick rate-limits itself to every 5 s
                heartbeats[service].tick(info={"mode": "demo"})

            if boiling and boil_start_ts is None:
                boil_start_ts = now_ms
            elif not boiling and boil_start_ts is not None:
                _write_boil_events(conn, BOIL_DEVICE, boil_start_ts, now_ms - 1000, rng)
                boil_start_ts = None

            stop.wait(1.0)
    finally:
        conn.close()
    print("seed_demo --follow: stopped", flush=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", required=True)
    ap.add_argument("--hours", type=int, default=24)
    ap.add_argument("--follow", action="store_true", help="keep appending live data after seeding")
    args = ap.parse_args()
    build(args.db, hours=args.hours)
    print(f"seeded {args.db} with {args.hours} h of demo data")
    if args.follow:
        follow(args.db)


if __name__ == "__main__":
    main()
