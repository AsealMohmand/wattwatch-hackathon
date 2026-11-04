"""Tests for hub/store.py: console schema, device registry sync, settings, kWh math."""

import time

import store


def test_init_idempotent_seeds_seven_rules(conn):
    store.init(conn)  # conftest's `conn` fixture already called init once; must stay idempotent
    rules = conn.execute("SELECT * FROM alert_rules").fetchall()
    assert len(rules) == 7
    assert any(r["kind"] == "hardware_limit" for r in rules)


def test_sync_devices_registers_new_ids(conn):
    conn.execute(
        "INSERT INTO readings (ts, device_id, irms_a, watts) VALUES (?, ?, ?, ?)",
        (1000, "ww-01/ch0", 1.0, 120.0),
    )
    conn.commit()

    store.sync_devices(conn)
    row = conn.execute("SELECT * FROM devices WHERE device_id = ?", ("ww-01/ch0",)).fetchone()
    assert row is not None
    assert row["name"] == "ww-01/ch0"
    assert row["kind"] == "unknown"

    store.sync_devices(conn)  # idempotent: no duplicate row
    count = conn.execute(
        "SELECT COUNT(*) FROM devices WHERE device_id = ?", ("ww-01/ch0",)
    ).fetchone()[0]
    assert count == 1


def test_kwh_one_hour_at_1000w_is_1(conn):
    conn.executemany(
        "INSERT INTO readings VALUES (?, ?, ?, ?)",
        [(i * 1000, "ww-01/ch0", 1000.0 / 120, 1000.0) for i in range(3600)],
    )
    conn.commit()
    result = store.kwh(conn, "ww-01/ch0", 0, 3600 * 1000)
    assert abs(result - 1.0) < 1e-9


def test_offline_device_watts_null_last_watts_kept(conn):
    now = int(time.time() * 1000)
    # last reading 5 minutes ago; default offline_after_s = 30 -> offline
    conn.execute(
        "INSERT INTO readings (ts, device_id, irms_a, watts) VALUES (?, ?, ?, ?)",
        (now - 300_000, "ww-02/ch0", 0.5, 77.0),
    )
    conn.commit()
    store.sync_devices(conn)

    rows = store.device_rows(conn, now)
    row = next(r for r in rows if r["device_id"] == "ww-02/ch0")
    assert row["online"] is False
    assert row["watts"] is None
    assert row["last_watts"] == 77.0
    assert row["last_ts"] == now - 300_000

    detail = store.device_detail(conn, "ww-02/ch0", now)
    assert detail["watts"] is None
    assert detail["last_watts"] == 77.0


def test_on_time_today_s_counts_seconds_over_20w(conn):
    now = int(time.time() * 1000)
    day_start = store.day_start_ms(now)
    # 5 s above 20 W, 5 s at/under 20 W -- on_time must count only the first 5,
    # regardless of baseline (an always-on 78 W load has no "spike" over 2x baseline).
    watts = [78.0, 78.0, 78.0, 78.0, 78.0, 20.0, 10.0, 5.0, 0.0, 78.0]
    conn.executemany(
        "INSERT INTO readings VALUES (?, ?, ?, ?)",
        [(day_start + i * 1000, "ww-01/ch0", w / 120, w) for i, w in enumerate(watts)],
    )
    conn.commit()
    store.sync_devices(conn)

    detail = store.device_detail(conn, "ww-01/ch0", now)
    assert detail["stats"]["on_time_today_s"] == 6  # five 78 W readings + the trailing one


def test_settings_roundtrip_types(conn):
    settings = store.get_settings(conn)
    assert isinstance(settings["price_per_kwh"], float)
    assert isinstance(settings["offline_after_s"], int)

    updated = store.update_settings(conn, {"price_per_kwh": 0.30, "offline_after_s": 60})
    assert updated["price_per_kwh"] == 0.30
    assert isinstance(updated["price_per_kwh"], float)
    assert updated["offline_after_s"] == 60
    assert isinstance(updated["offline_after_s"], int)

    reloaded = store.get_settings(conn)
    assert reloaded["price_per_kwh"] == 0.30
    assert reloaded["offline_after_s"] == 60
