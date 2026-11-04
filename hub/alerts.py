"""Alert worker: evaluates alert_rules against readings/events and keeps the
alerts table current. `evaluate` is the pure, testable pass; `main` just loops
it. Never writes readings or events -- only reads them.

    python alerts.py
"""

import time

import db
import store
from heartbeat import Heartbeat

LOOP_S = 2
LOOKBACK_MS = 24 * 3_600_000  # ignore events older than this: a first run against an old DB must not flood


def _device_row(conn, device_id):
    return conn.execute("SELECT * FROM devices WHERE device_id = ?", (device_id,)).fetchone()


def _device_name(conn, device_id):
    d = _device_row(conn, device_id)
    return d["name"] if d else device_id


def _rules_for(conn, kind):
    return conn.execute("SELECT * FROM alert_rules WHERE kind = ? AND enabled = 1", (kind,)).fetchall()


def _rule_device_ids(conn, rule):
    if rule["device_id"]:
        return [rule["device_id"]]
    return [r["device_id"] for r in conn.execute("SELECT device_id FROM devices").fetchall()]


def _open_alert(conn, rule, device_id, kind, severity, title, detail, event_id, value,
                 opened_ts, updated_ts, touched):
    cur = conn.execute(
        "INSERT INTO alerts (rule_id, device_id, kind, severity, title, detail, event_id, value,"
        " status, opened_ts, updated_ts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)",
        (rule["id"], device_id, kind, severity, title, detail, event_id, value, opened_ts, updated_ts),
    )
    touched.append(cur.lastrowid)


def _active_alert(conn, rule_id, device_id, kind):
    return conn.execute(
        "SELECT * FROM alerts WHERE rule_id = ? AND device_id = ? AND kind = ?"
        " AND status IN ('open','acknowledged')",
        (rule_id, device_id, kind),
    ).fetchone()


def _resolve(conn, alert_id, now_ms, touched):
    conn.execute(
        "UPDATE alerts SET status='resolved', resolved_ts=?, updated_ts=? WHERE id=?",
        (now_ms, now_ms, alert_id),
    )
    touched.append(alert_id)


def _overlapping_rule_event_exists(conn, e):
    """True if a 'rule'-method event on the same device overlaps e's interval (per the
    incidents merge rule). Used to suppress a new anomaly alert when the rule detector
    already caught the same incident -- one alert per boil, not two.
    """
    row = conn.execute(
        "SELECT 1 FROM events WHERE device_id = ? AND method = 'rule' AND id != ?"
        " AND NOT (end_ts + ? < ? OR ? + ? < start_ts) LIMIT 1",
        (e["device_id"], e["id"], store.INCIDENT_GAP_MS, e["start_ts"], e["end_ts"], store.INCIDENT_GAP_MS),
    ).fetchone()
    return row is not None


def _event_alerts(conn, now_ms, method, kind, title_fmt, touched, suppress_if_rule_overlap=False):
    """spike (method='rule') and anomaly (method='iforest') alerts: one per (event, rule).

    opened_ts is the event's own start_ts (when the spike happened), not now_ms (when this
    worker pass ran) -- otherwise every alert reads "opened Ns ago" with the same N on any
    restart or first run.
    """
    rules = _rules_for(conn, kind)
    if rules:
        events = conn.execute(
            "SELECT * FROM events WHERE method = ? AND start_ts >= ?", (method, now_ms - LOOKBACK_MS)
        ).fetchall()
        for e in events:
            if suppress_if_rule_overlap and _overlapping_rule_event_exists(conn, e):
                # The rule detector already caught this incident; don't double-alert. An
                # anomaly alert opened before the rule event appeared is left alone --
                # this only stops a *new* one from being created now.
                continue
            for rule in rules:
                if rule["device_id"] is not None and rule["device_id"] != e["device_id"]:
                    continue
                exists = conn.execute(
                    "SELECT id FROM alerts WHERE event_id = ? AND rule_id = ?", (e["id"], rule["id"])
                ).fetchone()
                if exists:
                    continue
                device = _device_row(conn, e["device_id"])
                name = device["name"] if device else e["device_id"]
                severity = rule["severity"]
                if device and device["rated_w"] and e["peak_w"] > 1.25 * device["rated_w"]:
                    severity = "critical"
                title = title_fmt.format(name=name, peak_w=e["peak_w"])
                _open_alert(
                    conn, rule, e["device_id"], kind, severity, title, e["explanation"],
                    e["id"], e["peak_w"], e["start_ts"], now_ms, touched,
                )

    # Backfill: once Llama fills events.explanation, push it onto alerts still showing "Explaining...".
    pending = conn.execute(
        "SELECT id, event_id FROM alerts WHERE kind = ? AND detail IS NULL AND event_id IS NOT NULL", (kind,)
    ).fetchall()
    for a in pending:
        row = conn.execute("SELECT explanation FROM events WHERE id = ?", (a["event_id"],)).fetchone()
        if row and row["explanation"] is not None:
            conn.execute(
                "UPDATE alerts SET detail = ?, updated_ts = ? WHERE id = ?",
                (row["explanation"], now_ms, a["id"]),
            )
            touched.append(a["id"])


def _over_power(conn, now_ms, touched):
    for rule in _rules_for(conn, "over_power"):
        duration_s, threshold = rule["duration_s"] or 0, rule["threshold"]
        if threshold is None or duration_s <= 0:
            continue
        since = now_ms - duration_s * 1000
        for device_id in _rule_device_ids(conn, rule):
            rows = conn.execute(
                "SELECT watts FROM readings WHERE device_id = ? AND ts >= ? ORDER BY ts", (device_id, since)
            ).fetchall()
            active = _active_alert(conn, rule["id"], device_id, "over_power")
            sustained = len(rows) >= duration_s and all(r["watts"] > threshold for r in rows)
            if sustained:
                current = rows[-1]["watts"]
                if not active:
                    name = _device_name(conn, device_id)
                    _open_alert(
                        conn, rule, device_id, "over_power", rule["severity"],
                        f"Sustained high draw on {name}", None, None, current, now_ms, now_ms, touched,
                    )
                else:
                    conn.execute(
                        "UPDATE alerts SET value=?, updated_ts=? WHERE id=?", (current, now_ms, active["id"])
                    )
            elif active:
                latest = conn.execute(
                    "SELECT watts FROM readings WHERE device_id = ? ORDER BY ts DESC LIMIT 1", (device_id,)
                ).fetchone()
                if latest and latest["watts"] <= threshold:
                    _resolve(conn, active["id"], now_ms, touched)


def _offline(conn, now_ms, touched):
    rules = _rules_for(conn, "offline")
    if not rules:
        return
    settings = store.get_settings(conn)
    offline_after_ms = settings["offline_after_s"] * 1000
    for rule in rules:
        for device_id in _rule_device_ids(conn, rule):
            last = conn.execute(
                "SELECT MAX(ts) AS ts FROM readings WHERE device_id = ?", (device_id,)
            ).fetchone()
            last_ts = last["ts"] if last else None
            active = _active_alert(conn, rule["id"], device_id, "offline")
            is_offline = last_ts is None or now_ms - last_ts > offline_after_ms
            if is_offline:
                if not active:
                    name = _device_name(conn, device_id)
                    _open_alert(
                        conn, rule, device_id, "offline", rule["severity"],
                        f"{name} offline", None, None, None, now_ms, now_ms, touched,
                    )
            elif active:
                _resolve(conn, active["id"], now_ms, touched)


def _daily_energy(conn, now_ms, touched):
    rules = _rules_for(conn, "daily_energy")
    if not rules:
        return
    day_start = store.day_start_ms(now_ms)
    for rule in rules:
        threshold = rule["threshold"]
        if threshold is None:
            continue
        for device_id in _rule_device_ids(conn, rule):
            kwh_today = store.kwh(conn, device_id, day_start, now_ms)
            if kwh_today <= threshold:
                continue
            opened_today = conn.execute(
                "SELECT id FROM alerts WHERE rule_id = ? AND device_id = ? AND kind = 'daily_energy'"
                " AND opened_ts >= ?",
                (rule["id"], device_id, day_start),
            ).fetchone()
            if opened_today:
                continue
            name = _device_name(conn, device_id)
            _open_alert(
                conn, rule, device_id, "daily_energy", rule["severity"],
                f"{name} used {kwh_today:.2f} kWh today", None, None, kwh_today, now_ms, now_ms, touched,
            )


def _always_on(conn, now_ms, touched):
    for rule in _rules_for(conn, "always_on"):
        duration_s, threshold = rule["duration_s"] or 0, rule["threshold"]
        if threshold is None or duration_s <= 0:
            continue
        since = now_ms - duration_s * 1000
        for device_id in _rule_device_ids(conn, rule):
            rows = conn.execute(
                "SELECT watts FROM readings WHERE device_id = ? AND ts >= ? ORDER BY ts", (device_id, since)
            ).fetchall()
            active = _active_alert(conn, rule["id"], device_id, "always_on")
            coverage = len(rows) / duration_s
            min_w = min((r["watts"] for r in rows), default=None)
            if coverage >= 0.9 and min_w is not None and min_w > threshold:
                if not active:
                    name = _device_name(conn, device_id)
                    _open_alert(
                        conn, rule, device_id, "always_on", rule["severity"],
                        f"Always-on load: {name}", None, None, min_w, now_ms, now_ms, touched,
                    )
            elif active and (min_w is None or min_w <= threshold):
                _resolve(conn, active["id"], now_ms, touched)


def _hardware_limit(conn, now_ms, touched):
    """node_status.over_limit = 1 on a device's port -> critical alert; resolves when
    the firmware clears the flag on a later reading.
    """
    rules = _rules_for(conn, "hardware_limit")
    if not rules:
        return
    for rule in rules:
        device_filter = rule["device_id"]
        if device_filter:
            rows = conn.execute(
                "SELECT device_id, over_limit FROM node_status WHERE device_id = ?", (device_filter,)
            ).fetchall()
        else:
            rows = conn.execute("SELECT device_id, over_limit FROM node_status").fetchall()
        for r in rows:
            device_id = r["device_id"]
            active = _active_alert(conn, rule["id"], device_id, "hardware_limit")
            if r["over_limit"]:
                if not active:
                    name = _device_name(conn, device_id)
                    _open_alert(
                        conn, rule, device_id, "hardware_limit", rule["severity"],
                        f"Hardware limit exceeded on {name}", None, None, None, now_ms, now_ms, touched,
                    )
            elif active:
                _resolve(conn, active["id"], now_ms, touched)


def evaluate(conn, now_ms):
    """One pass over every enabled rule. Returns ids of alerts opened or updated."""
    touched = []
    _event_alerts(conn, now_ms, "rule", "spike", "Spike on {name}: {peak_w:.0f} W", touched)
    _event_alerts(conn, now_ms, "iforest", "anomaly", "Unusual pattern on {name}", touched,
                  suppress_if_rule_overlap=True)
    _over_power(conn, now_ms, touched)
    _offline(conn, now_ms, touched)
    _daily_energy(conn, now_ms, touched)
    _always_on(conn, now_ms, touched)
    _hardware_limit(conn, now_ms, touched)
    conn.commit()
    return touched


def main():
    conn = db.connect()
    store.init(conn)
    hb = Heartbeat(conn, "alerts")
    print("alert worker: evaluating every 2 s")
    while True:
        touched = evaluate(conn, int(time.time() * 1000))
        hb.tick({"touched_last_pass": len(touched)})
        time.sleep(LOOP_S)


if __name__ == "__main__":
    main()
