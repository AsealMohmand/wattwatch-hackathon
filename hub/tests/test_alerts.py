"""Tests for hub/alerts.py: rule evaluation against readings/events."""

import time

import alerts
import store


def _insert_event(conn, device_id, start_ts, end_ts, peak_w, baseline_w=10.0, method="rule", explanation=None):
    cur = conn.execute(
        "INSERT INTO events (device_id, start_ts, end_ts, peak_w, baseline_w, score, method, explanation)"
        " VALUES (?, ?, ?, ?, ?, 8.0, ?, ?)",
        (device_id, start_ts, end_ts, peak_w, baseline_w, method, explanation),
    )
    conn.commit()
    return cur.lastrowid


def _insert_device(conn, device_id, name="Kettle", rated_w=None):
    conn.execute(
        "INSERT INTO devices (device_id, name, kind, rated_w, created_ts) VALUES (?, ?, 'kettle', ?, ?)",
        (device_id, name, rated_w, int(time.time() * 1000)),
    )
    conn.commit()


def test_spike_alert_created_once(conn):
    now = int(time.time() * 1000)
    _insert_device(conn, "ww-01/ch0")
    _insert_event(conn, "ww-01/ch0", now - 1000, now, 1480.0)

    alerts.evaluate(conn, now)
    alerts.evaluate(conn, now)  # second pass must not duplicate

    rows = conn.execute("SELECT * FROM alerts WHERE kind = 'spike'").fetchall()
    assert len(rows) == 1
    assert rows[0]["device_id"] == "ww-01/ch0"
    assert "1480" in rows[0]["title"]


def test_spike_alert_picks_up_late_explanation(conn):
    now = int(time.time() * 1000)
    _insert_device(conn, "ww-01/ch0")
    event_id = _insert_event(conn, "ww-01/ch0", now - 1000, now, 1480.0, explanation=None)

    alerts.evaluate(conn, now)
    row = conn.execute("SELECT * FROM alerts WHERE kind = 'spike'").fetchone()
    assert row["detail"] is None

    conn.execute("UPDATE events SET explanation = ? WHERE id = ?", ("Likely the kettle.", event_id))
    conn.commit()

    alerts.evaluate(conn, now + 1000)
    row = conn.execute("SELECT * FROM alerts WHERE kind = 'spike'").fetchone()
    assert row["detail"] == "Likely the kettle."


def test_spike_severity_bumped_over_rated(conn):
    now = int(time.time() * 1000)
    _insert_device(conn, "ww-01/ch0", rated_w=1500.0)
    _insert_event(conn, "ww-01/ch0", now - 1000, now, 2000.0)  # > 1.25 * 1500 = 1875

    alerts.evaluate(conn, now)
    row = conn.execute("SELECT * FROM alerts WHERE kind = 'spike'").fetchone()
    assert row["severity"] == "critical"


def test_offline_alert_opens_and_resolves(conn):
    now = int(time.time() * 1000)
    _insert_device(conn, "ww-02/ch0", name="Fridge")
    conn.execute("INSERT INTO readings VALUES (?, ?, ?, ?)", (now - 60_000, "ww-02/ch0", 1.0, 100.0))
    conn.commit()  # last reading 60 s ago; default offline_after_s = 30

    alerts.evaluate(conn, now)
    row = conn.execute("SELECT * FROM alerts WHERE kind = 'offline'").fetchone()
    assert row is not None
    assert row["status"] == "open"
    assert "Fridge" in row["title"]

    conn.execute("INSERT INTO readings VALUES (?, ?, ?, ?)", (now, "ww-02/ch0", 1.0, 100.0))
    conn.commit()  # fresh reading arrives
    alerts.evaluate(conn, now + 1000)
    row = conn.execute("SELECT * FROM alerts WHERE kind = 'offline'").fetchone()
    assert row["status"] == "resolved"


def test_over_power_needs_full_duration(conn):
    # default "Sustained high draw" rule: threshold=1800, duration_s=10
    now = int(time.time() * 1000)
    _insert_device(conn, "ww-01/ch1", name="Heater")
    for i in range(5):  # only 5 readings: short of the required 10 s duration
        conn.execute(
            "INSERT INTO readings VALUES (?, ?, ?, ?)", (now - (5 - i) * 1000, "ww-01/ch1", 20.0, 2000.0)
        )
    conn.commit()

    alerts.evaluate(conn, now)
    assert conn.execute("SELECT COUNT(*) FROM alerts WHERE kind = 'over_power'").fetchone()[0] == 0

    for i in range(10):  # now the full window is above threshold
        conn.execute(
            "INSERT INTO readings VALUES (?, ?, ?, ?)", (now + i * 1000, "ww-01/ch1", 20.0, 2000.0)
        )
    conn.commit()
    alerts.evaluate(conn, now + 10_000)
    assert conn.execute("SELECT COUNT(*) FROM alerts WHERE kind = 'over_power'").fetchone()[0] == 1


def test_daily_energy_once_per_day(conn):
    # default "Daily energy budget" rule: threshold=5.0 kWh
    now = int(time.time() * 1000)
    _insert_device(conn, "ww-01/ch0")
    day_start = store.day_start_ms(now)
    conn.executemany(
        "INSERT INTO readings VALUES (?, ?, ?, ?)",
        [(day_start + i * 1000, "ww-01/ch0", 50.0, 6000.0) for i in range(3600)],  # 6 kWh in one hour
    )
    conn.commit()

    alerts.evaluate(conn, now)
    alerts.evaluate(conn, now + 1000)  # second pass same day must not duplicate
    rows = conn.execute("SELECT * FROM alerts WHERE kind = 'daily_energy'").fetchall()
    assert len(rows) == 1


def test_old_events_ignored(conn):
    now = int(time.time() * 1000)
    _insert_device(conn, "ww-01/ch0")
    _insert_event(conn, "ww-01/ch0", now - 25 * 3_600_000, now - 25 * 3_600_000 + 1000, 1480.0)

    alerts.evaluate(conn, now)
    assert conn.execute("SELECT COUNT(*) FROM alerts WHERE kind = 'spike'").fetchone()[0] == 0


def test_spike_alert_opened_at_event_start(conn):
    now = int(time.time() * 1000)
    _insert_device(conn, "ww-01/ch0")
    event_start = now - 45_000  # the spike happened 45 s ago, not "now" (worker run time)
    _insert_event(conn, "ww-01/ch0", event_start, event_start + 5000, 1480.0)

    alerts.evaluate(conn, now)
    row = conn.execute("SELECT * FROM alerts WHERE kind = 'spike'").fetchone()
    assert row["opened_ts"] == event_start
    assert row["updated_ts"] == now


def test_anomaly_suppressed_when_rule_event_overlaps(conn):
    now = int(time.time() * 1000)
    _insert_device(conn, "ww-01/ch0")
    _insert_event(conn, "ww-01/ch0", now - 60_000, now - 55_000, 1480.0, method="rule")
    _insert_event(conn, "ww-01/ch0", now - 59_000, now - 54_000, 1480.0, method="iforest")

    alerts.evaluate(conn, now)

    assert conn.execute("SELECT COUNT(*) FROM alerts WHERE kind = 'spike'").fetchone()[0] == 1
    assert conn.execute("SELECT COUNT(*) FROM alerts WHERE kind = 'anomaly'").fetchone()[0] == 0


def test_anomaly_kept_if_created_before_rule_event_appeared(conn):
    now = int(time.time() * 1000)
    _insert_device(conn, "ww-01/ch0")
    _insert_event(conn, "ww-01/ch0", now - 60_000, now - 55_000, 1480.0, method="iforest")

    alerts.evaluate(conn, now)  # no rule event yet -> anomaly alert opens normally
    assert conn.execute("SELECT COUNT(*) FROM alerts WHERE kind = 'anomaly'").fetchone()[0] == 1

    # the rule event shows up late (e.g. detector lag); the existing anomaly alert must stay
    _insert_event(conn, "ww-01/ch0", now - 60_000, now - 55_000, 1480.0, method="rule")
    alerts.evaluate(conn, now + 1000)
    assert conn.execute("SELECT COUNT(*) FROM alerts WHERE kind = 'anomaly'").fetchone()[0] == 1


def test_hardware_limit_opens_and_resolves(conn):
    now = int(time.time() * 1000)
    _insert_device(conn, "ww-01/ch0")
    conn.execute(
        "INSERT INTO node_status (node_id, port, device_id, over_limit, first_seen_ts, last_ts,"
        " boots, readings) VALUES ('ww-01', 'ch0', 'ww-01/ch0', 1, ?, ?, 1, 1)",
        (now, now),
    )
    conn.commit()

    alerts.evaluate(conn, now)
    row = conn.execute("SELECT * FROM alerts WHERE kind = 'hardware_limit'").fetchone()
    assert row is not None
    assert row["status"] == "open"
    assert row["severity"] == "critical"

    conn.execute("UPDATE node_status SET over_limit = 0 WHERE device_id = 'ww-01/ch0'")
    conn.commit()
    alerts.evaluate(conn, now + 1000)
    row = conn.execute("SELECT * FROM alerts WHERE kind = 'hardware_limit'").fetchone()
    assert row["status"] == "resolved"


def test_disabled_rule_noop(conn):
    now = int(time.time() * 1000)
    conn.execute("UPDATE alert_rules SET enabled = 0 WHERE kind = 'spike'")
    conn.commit()
    _insert_device(conn, "ww-01/ch0")
    _insert_event(conn, "ww-01/ch0", now - 1000, now, 1480.0)

    alerts.evaluate(conn, now)  # must not crash, must not open an alert
    assert conn.execute("SELECT COUNT(*) FROM alerts WHERE kind = 'spike'").fetchone()[0] == 0
