"""Console schema and queries: devices, alert rules, alerts, settings, topology.

`api.py` and `alerts.py` both read and write these tables; neither ever touches
`readings` or `events` (ingest owns readings, the detectors own events). Settings
and topology overrides are small enough to keep as JSON-encoded key/value rows
rather than typed columns.
"""

import json
import time
from statistics import median

SCHEMA = """
CREATE TABLE IF NOT EXISTS devices (
  device_id  TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'unknown',
  room       TEXT,
  rated_w    REAL,
  notes      TEXT,
  created_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS alert_rules (
  id         INTEGER PRIMARY KEY,
  name       TEXT NOT NULL,
  kind       TEXT NOT NULL,
  device_id  TEXT,
  threshold  REAL,
  duration_s INTEGER NOT NULL DEFAULT 0,
  severity   TEXT NOT NULL DEFAULT 'warning',
  enabled    INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS alerts (
  id          INTEGER PRIMARY KEY,
  rule_id     INTEGER,
  device_id   TEXT NOT NULL,
  kind        TEXT NOT NULL,
  severity    TEXT NOT NULL,
  title       TEXT NOT NULL,
  detail      TEXT,
  event_id    INTEGER,
  value       REAL,
  status      TEXT NOT NULL DEFAULT 'open',
  opened_ts   INTEGER NOT NULL,
  updated_ts  INTEGER NOT NULL,
  acked_ts    INTEGER,
  resolved_ts INTEGER
);
CREATE INDEX IF NOT EXISTS idx_alerts_status ON alerts(status, opened_ts);
CREATE UNIQUE INDEX IF NOT EXISTS idx_alerts_event ON alerts(event_id, rule_id) WHERE event_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS topology (node_id TEXT PRIMARY KEY, label TEXT, x REAL, y REAL);
"""

DEFAULT_SETTINGS = {
    "price_per_kwh": 0.15, "currency": "$", "volts": 120, "offline_after_s": 30,
    "site_name": "Home", "co2_kg_per_kwh": 0.39,
}

# name, kind, device_id, threshold, duration_s, severity, enabled
DEFAULT_RULES = [
    ("Power spike", "spike", None, None, 0, "warning", 1),
    ("Unusual pattern (ML)", "anomaly", None, None, 0, "info", 1),
    ("Sustained high draw", "over_power", None, 1800.0, 10, "critical", 1),
    ("Node offline", "offline", None, None, 0, "warning", 1),
    ("Daily energy budget", "daily_energy", None, 5.0, 0, "info", 1),
    ("Always-on load", "always_on", None, 50.0, 14400, "info", 1),
    ("Hardware limit", "hardware_limit", None, None, 0, "critical", 1),
]

DEVICE_KINDS = {
    "unknown", "kettle", "heater", "fridge", "computer", "lighting", "tv",
    "washer", "dryer", "microwave", "other",
}
PATCHABLE_DEVICE_FIELDS = {"name", "kind", "room", "rated_w", "notes"}


def init(conn):
    """Create console tables and seed default rules/settings. Safe to call every start."""
    conn.executescript(SCHEMA)
    if conn.execute("SELECT COUNT(*) FROM alert_rules").fetchone()[0] == 0:
        conn.executemany(
            "INSERT INTO alert_rules (name, kind, device_id, threshold, duration_s, severity, enabled)"
            " VALUES (?, ?, ?, ?, ?, ?, ?)",
            DEFAULT_RULES,
        )
    for key, value in DEFAULT_SETTINGS.items():
        conn.execute("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)", (key, json.dumps(value)))
    conn.commit()


def sync_devices(conn):
    """Register a `devices` row for every distinct reading device not yet known."""
    rows = conn.execute(
        "SELECT DISTINCT device_id FROM readings WHERE device_id NOT IN (SELECT device_id FROM devices)"
    ).fetchall()
    if not rows:
        return
    now = int(time.time() * 1000)
    conn.executemany(
        "INSERT INTO devices (device_id, name, kind, created_ts) VALUES (?, ?, 'unknown', ?)",
        [(r["device_id"], r["device_id"], now) for r in rows],
    )
    conn.commit()


def get_settings(conn):
    rows = conn.execute("SELECT key, value FROM settings").fetchall()
    return {r["key"]: json.loads(r["value"]) for r in rows}


def update_settings(conn, patch):
    current = get_settings(conn)
    unknown = set(patch) - set(current)
    if unknown:
        raise ValueError(f"unknown setting(s): {', '.join(sorted(unknown))}")
    for key, value in patch.items():
        conn.execute("UPDATE settings SET value = ? WHERE key = ?", (json.dumps(value), key))
    conn.commit()
    return get_settings(conn)


def day_start_ms(now_ms):
    """Local midnight, as Unix ms, for the day containing now_ms."""
    t = time.localtime(now_ms / 1000)
    midnight = time.struct_time((t.tm_year, t.tm_mon, t.tm_mday, 0, 0, 0, t.tm_wday, t.tm_yday, t.tm_isdst))
    return int(time.mktime(midnight) * 1000)


def month_start_ms(now_ms):
    """Local midnight on the 1st of the month containing now_ms."""
    t = time.localtime(now_ms / 1000)
    midnight = time.struct_time((t.tm_year, t.tm_mon, 1, 0, 0, 0, t.tm_wday, t.tm_yday, t.tm_isdst))
    return int(time.mktime(midnight) * 1000)


def days_in_month(now_ms):
    import calendar
    t = time.localtime(now_ms / 1000)
    return calendar.monthrange(t.tm_year, t.tm_mon)[1]


def percentile(values, p):
    """Linear-interpolated percentile (0-100) of a list of numbers; 0.0 if empty."""
    if not values:
        return 0.0
    s = sorted(values)
    if len(s) == 1:
        return float(s[0])
    k = (len(s) - 1) * (p / 100.0)
    f = int(k)
    c = min(f + 1, len(s) - 1)
    if f == c:
        return float(s[f])
    return float(s[f] + (s[c] - s[f]) * (k - f))


INCIDENT_GAP_MS = 10_000  # events on the same device merge if they overlap or sit within this of each other


def events_overlap(a_start, a_end, b_start, b_end, gap_ms=INCIDENT_GAP_MS):
    """True if [a_start, a_end] and [b_start, b_end] overlap or sit within gap_ms of each other."""
    return not (a_end + gap_ms < b_start or b_end + gap_ms < a_start)


def alert_detectors(conn, event_id):
    """Methods detecting the same incident as this alert's event: its own method plus any
    other method's event on the same device whose interval overlaps it (per the incidents
    merge rule). Alerts with no event (over_power, offline, daily_energy, always_on) get [].
    """
    if event_id is None:
        return []
    e = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
    if e is None:
        return []
    rows = conn.execute(
        "SELECT DISTINCT method FROM events WHERE device_id = ?"
        " AND NOT (end_ts + ? < ? OR ? + ? < start_ts)",
        (e["device_id"], INCIDENT_GAP_MS, e["start_ts"], e["end_ts"], INCIDENT_GAP_MS),
    ).fetchall()
    methods = {r["method"] for r in rows}
    methods.add(e["method"])
    order = {"rule": 0, "iforest": 1}
    return sorted(methods, key=lambda m: order.get(m, 2))


def explanation_row(conn, event_id):
    """The structured AI explanation for an event (the `ai` field on Event/Incident/Alert
    JSON), or None if there isn't one yet (template-only, or not explained at all).
    """
    if event_id is None:
        return None
    r = conn.execute("SELECT * FROM explanations WHERE event_id = ?", (event_id,)).fetchone()
    if r is None:
        return None
    return {
        "appliance": r["appliance"], "confidence": r["confidence"], "verdict": r["verdict"],
        "summary": r["summary"], "model": r["model"], "latency_ms": r["latency_ms"],
        "fallback": bool(r["fallback"]),
    }


def incidents(conn, device_id, since_ms, limit):
    """Merge events on the same device whose [start_ts, end_ts] ranges overlap or sit within
    10 s of each other into one incident per the contract. Newest first.
    """
    q = "SELECT * FROM events WHERE 1=1"
    args = []
    if device_id:
        q += " AND device_id = ?"
        args.append(device_id)
    if since_ms is not None:
        q += " AND start_ts >= ?"
        args.append(since_ms)
    q += " ORDER BY device_id, start_ts, id"
    rows = conn.execute(q, args).fetchall()

    groups = []
    for r in rows:
        if (
            groups
            and groups[-1][-1]["device_id"] == r["device_id"]
            and r["start_ts"] - max(e["end_ts"] for e in groups[-1]) <= INCIDENT_GAP_MS
        ):
            groups[-1].append(r)
        else:
            groups.append([r])

    device_names = {
        d["device_id"]: d["name"] for d in conn.execute("SELECT device_id, name FROM devices").fetchall()
    }

    out = []
    for g in groups:
        first = g[0]  # already ordered by start_ts, id
        start_ts = min(e["start_ts"] for e in g)
        end_ts = max(e["end_ts"] for e in g)
        duration_s = max(1, round((end_ts - start_ts) / 1000) + 1)
        peak_w = max(e["peak_w"] for e in g)
        rule_events = [e for e in g if e["method"] == "rule"]
        iforest_events = [e for e in g if e["method"] == "iforest"]
        baseline_w = (rule_events or iforest_events or g)[0]["baseline_w"]
        methods = []
        if rule_events:
            methods.append("rule")
        if iforest_events:
            methods.append("iforest")
        explanation = (
            rule_events[0]["explanation"] if rule_events
            else (iforest_events[0]["explanation"] if iforest_events else None)
        )
        ai_event_id = (
            rule_events[0]["id"] if rule_events
            else (iforest_events[0]["id"] if iforest_events else None)
        )
        out.append({
            "id": f"i-{first['id']}",
            "device_id": first["device_id"],
            "device_name": device_names.get(first["device_id"], first["device_id"]),
            "start_ts": start_ts,
            "end_ts": end_ts,
            "duration_s": duration_s,
            "peak_w": peak_w,
            "baseline_w": baseline_w,
            "methods": methods,
            "rule_score": rule_events[0]["score"] if rule_events else None,
            "iforest_score": iforest_events[0]["score"] if iforest_events else None,
            "explanation": explanation,
            "event_ids": sorted(e["id"] for e in g),
            "ai": explanation_row(conn, ai_event_id),
        })
    out.sort(key=lambda i: i["start_ts"], reverse=True)
    if limit is not None:
        out = out[:limit]
    return out


def kwh(conn, device_id, since_ms, until_ms):
    """kWh = SUM(watts) / 3_600_000 over [since_ms, until_ms) -- 1 Hz readings."""
    q = "SELECT COALESCE(SUM(watts), 0) FROM readings WHERE ts >= ? AND ts < ?"
    args = [since_ms, until_ms]
    if device_id is not None:
        q += " AND device_id = ?"
        args.append(device_id)
    total = conn.execute(q, args).fetchone()[0]
    return total / 3_600_000


def window_coverage(conn, since_ms, until_ms):
    """How much of [since_ms, until_ms) is actually backed by readings, at the
    1 Hz rate the hub samples at. For each device that has at least one
    reading in the window, its reading count contributes count / window_s;
    a device with zero readings in the window doesn't dilute the figure (a
    second device that never reported shouldn't make a fully-covered single
    device read as 50%). A single, fully-reporting device yields ~1.0;
    several fully-reporting devices can sum past 1.0 -- harmless, since this
    is only ever compared against a floor (e.g. 0.8) to catch windows with
    next to nothing in them, such as "yesterday up to the current clock
    time" early in a demo DB's life.
    """
    window_s = (until_ms - since_ms) / 1000.0
    if window_s <= 0:
        return 0.0
    rows = conn.execute(
        "SELECT device_id, COUNT(*) AS n FROM readings WHERE ts >= ? AND ts < ? GROUP BY device_id",
        (since_ms, until_ms),
    ).fetchall()
    total = sum(r["n"] for r in rows if r["n"] > 0)
    return total / window_s


def device_rows(conn, now_ms):
    """All devices in Device-contract shape (no `stats`)."""
    settings = get_settings(conn)
    offline_after_ms = settings["offline_after_s"] * 1000
    day_start = day_start_ms(now_ms)
    devices = conn.execute("SELECT * FROM devices ORDER BY device_id").fetchall()
    out = []
    for d in devices:
        last = conn.execute(
            "SELECT ts, watts FROM readings WHERE device_id = ? ORDER BY ts DESC LIMIT 1",
            (d["device_id"],),
        ).fetchone()
        last_ts = last["ts"] if last else None
        online = last_ts is not None and now_ms - last_ts <= offline_after_ms
        events_today = conn.execute(
            "SELECT COUNT(*) FROM events WHERE device_id = ? AND start_ts >= ?",
            (d["device_id"], day_start),
        ).fetchone()[0]
        open_alerts = conn.execute(
            "SELECT COUNT(*) FROM alerts WHERE device_id = ? AND status IN ('open','acknowledged')",
            (d["device_id"],),
        ).fetchone()[0]
        last_watts = last["watts"] if last else None
        out.append({
            "device_id": d["device_id"],
            "name": d["name"],
            "kind": d["kind"],
            "room": d["room"],
            "rated_w": d["rated_w"],
            "notes": d["notes"],
            "online": online,
            "last_ts": last_ts,
            "watts": last_watts if online else None,
            "last_watts": last_watts,
            "kwh_today": kwh(conn, d["device_id"], day_start, now_ms),
            "events_today": events_today,
            "open_alerts": open_alerts,
        })
    return out


def device_detail(conn, device_id, now_ms):
    """Device-contract shape plus `stats`, or None if the device is unknown."""
    row = next((r for r in device_rows(conn, now_ms) if r["device_id"] == device_id), None)
    if row is None:
        return None

    day_start = day_start_ms(now_ms)
    hour_ago = now_ms - 3_600_000
    day_ago = now_ms - 86_400_000
    week_ago = now_ms - 7 * 86_400_000

    avg_1h = conn.execute(
        "SELECT AVG(watts) FROM readings WHERE device_id = ? AND ts >= ?", (device_id, hour_ago)
    ).fetchone()[0]
    peak_24h = conn.execute(
        "SELECT MAX(watts) FROM readings WHERE device_id = ? AND ts >= ?", (device_id, day_ago)
    ).fetchone()[0]
    first_seen = conn.execute(
        "SELECT MIN(ts) FROM readings WHERE device_id = ?", (device_id,)
    ).fetchone()[0]
    last_24h_watts = [
        r["watts"] for r in conn.execute(
            "SELECT watts FROM readings WHERE device_id = ? AND ts >= ?", (device_id, day_ago)
        ).fetchall()
    ]
    baseline_w = median(last_24h_watts) if last_24h_watts else None
    # Fixed 20 W floor, not 2x baseline: that definition fails always-on loads that sit
    # above their own baseline by less than 2x (e.g. a device idling at 78 W).
    on_time_today_s = conn.execute(
        "SELECT COUNT(*) FROM readings WHERE device_id = ? AND ts >= ? AND watts > 20",
        (device_id, day_start),
    ).fetchone()[0]

    row["stats"] = {
        "avg_w_1h": avg_1h,
        "peak_w_24h": peak_24h,
        "kwh_today": row["kwh_today"],
        "kwh_7d": kwh(conn, device_id, week_ago, now_ms),
        "on_time_today_s": on_time_today_s,
        "baseline_w": baseline_w,
        "first_seen_ts": first_seen,
    }
    return row


def update_device(conn, device_id, patch):
    """Apply a PATCH {name?, kind?, room?, rated_w?, notes?}; None if unknown device."""
    exists = conn.execute("SELECT 1 FROM devices WHERE device_id = ?", (device_id,)).fetchone()
    if not exists:
        return None
    unknown = set(patch) - PATCHABLE_DEVICE_FIELDS
    if unknown:
        raise ValueError(f"unknown field(s): {', '.join(sorted(unknown))}")
    if "kind" in patch and patch["kind"] not in DEVICE_KINDS:
        raise ValueError(f"invalid kind: {patch['kind']}")
    for key, value in patch.items():
        conn.execute(f"UPDATE devices SET {key} = ? WHERE device_id = ?", (value, device_id))
    if patch:
        conn.commit()
    return device_detail(conn, device_id, int(time.time() * 1000))


# ------------------------------------------------------------------ nodes (v2)

def node_rows(conn, now_ms):
    """Node-contract shape (no `telemetry`): one row per firmware node (node_status'
    node_id), plus a synthetic one-port node for every device that has never sent
    firmware telemetry (plain CSV/HTTP), so it still shows up with fw=null.
    """
    settings = get_settings(conn)
    offline_after_ms = settings["offline_after_s"] * 1000
    device_names = {
        d["device_id"]: d["name"] for d in conn.execute("SELECT device_id, name FROM devices").fetchall()
    }

    grouped = {}
    for r in conn.execute("SELECT * FROM node_status").fetchall():
        grouped.setdefault(r["node_id"], []).append(dict(r))

    telemetry_ids = {r["device_id"] for rows in grouped.values() for r in rows}
    all_ids = {d["device_id"] for d in conn.execute("SELECT device_id FROM devices").fetchall()}
    for device_id in sorted(all_ids - telemetry_ids):
        node_id, _, port = device_id.partition("/")
        grouped.setdefault(node_id, []).append({
            "node_id": node_id, "port": port, "device_id": device_id, "fw": None, "boot_id": None,
            "uptime_ms": None, "n_samples": None, "irms_raw_a": None, "peak_raw_a": None,
            "over_limit": 0, "first_seen_ts": None, "last_ts": None, "boots": 0, "readings": 0,
        })

    out = []
    for node_id, rows in sorted(grouped.items()):
        device_ids = [r["device_id"] for r in rows]
        placeholders = ",".join("?" * len(device_ids))
        last_reading = conn.execute(
            f"SELECT MAX(ts) FROM readings WHERE device_id IN ({placeholders})", device_ids
        ).fetchone()[0]
        minute_ago = now_ms - 60_000
        readings_per_min = conn.execute(
            f"SELECT COUNT(*) FROM readings WHERE device_id IN ({placeholders}) AND ts >= ?",
            device_ids + [minute_ago],
        ).fetchone()[0]

        ports = []
        for r in rows:
            last_ts = r["last_ts"]
            if last_ts is None:
                last_ts = conn.execute(
                    "SELECT MAX(ts) FROM readings WHERE device_id = ?", (r["device_id"],)
                ).fetchone()[0]
            online = last_ts is not None and now_ms - last_ts <= offline_after_ms
            crest = None
            if r["irms_raw_a"] and r["irms_raw_a"] >= 0.01 and r["peak_raw_a"] is not None:
                crest = r["peak_raw_a"] / r["irms_raw_a"]
            ports.append({
                "port": r["port"], "device_id": r["device_id"],
                "device_name": device_names.get(r["device_id"], r["device_id"]),
                "online": online, "irms_raw_a": r["irms_raw_a"], "peak_raw_a": r["peak_raw_a"],
                "crest_factor": crest, "n_samples": r["n_samples"], "sample_rate_hz": r["n_samples"],
                "over_limit": bool(r["over_limit"]), "last_ts": last_ts, "readings": r["readings"],
            })

        fws = [r["fw"] for r in rows if r["fw"]]
        first_seens = [r["first_seen_ts"] for r in rows if r["first_seen_ts"] is not None]
        uptimes = [r["uptime_ms"] for r in rows if r["uptime_ms"] is not None]
        boots_vals = [r["boots"] for r in rows if r["boots"]]
        out.append({
            "node_id": node_id,
            "fw": fws[0] if fws else None,
            "online": any(p["online"] for p in ports),
            "first_seen_ts": min(first_seens) if first_seens else None,
            "last_ts": last_reading,
            "boots": max(boots_vals) if boots_vals else 0,
            "uptime_ms": max(uptimes) if uptimes else None,
            "readings_per_min": readings_per_min,
            "ports": ports,
        })
    return out


def node_detail(conn, node_id, now_ms):
    """Node-contract shape plus `telemetry` (the last hour), or None if unknown."""
    node = next((n for n in node_rows(conn, now_ms) if n["node_id"] == node_id), None)
    if node is None:
        return None
    hour_ago = now_ms - 3_600_000
    rows = conn.execute(
        "SELECT ts, port, uptime_ms, n_samples, irms_raw_a, peak_raw_a FROM node_telemetry"
        " WHERE node_id = ? AND ts >= ? ORDER BY ts",
        (node_id, hour_ago),
    ).fetchall()
    node["telemetry"] = [dict(r) for r in rows]
    return node
