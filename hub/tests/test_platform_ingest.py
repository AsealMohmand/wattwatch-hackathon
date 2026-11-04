"""Tests for v2 telemetry capture in hub/ingest.py (P1)."""

import ingest


FW_LINE = {
    "device_id": "ww-01", "port": "ch0", "boot_id": "1fdf7b78", "uptime_ms": 22996,
    "ts": None, "irms_raw_a": 0.0805, "peak_raw_a": 0.1209, "n_samples": 861,
    "over_ceiling": False, "over_limit": False, "fw": "0.1.1-a",
}


def test_platform_telemetry_upsert_and_boots(conn):
    t1 = ingest.telemetry(FW_LINE)
    assert t1["node_id"] == "ww-01"
    assert t1["port"] == "ch0"
    assert t1["device_id"] == "ww-01/ch0"
    ingest.upsert_node_status(conn, t1, 1_000)

    row = conn.execute(
        "SELECT * FROM node_status WHERE node_id = ? AND port = ?", ("ww-01", "ch0")
    ).fetchone()
    assert row["boots"] == 1
    assert row["readings"] == 1
    assert row["fw"] == "0.1.1-a"
    assert row["device_id"] == "ww-01/ch0"

    # same boot_id again: no new boot
    t2 = ingest.telemetry(dict(FW_LINE, uptime_ms=23996))
    ingest.upsert_node_status(conn, t2, 2_000)
    row = conn.execute(
        "SELECT * FROM node_status WHERE node_id = ? AND port = ?", ("ww-01", "ch0")
    ).fetchone()
    assert row["boots"] == 1
    assert row["readings"] == 2

    # new boot_id: boots increments
    t3 = ingest.telemetry(dict(FW_LINE, boot_id="deadbeef", uptime_ms=500))
    ingest.upsert_node_status(conn, t3, 3_000)
    row = conn.execute(
        "SELECT * FROM node_status WHERE node_id = ? AND port = ?", ("ww-01", "ch0")
    ).fetchone()
    assert row["boots"] == 2
    assert row["readings"] == 3


def test_platform_telemetry_sampled_every_10th(conn):
    t = ingest.telemetry(FW_LINE)
    for i in range(1, 26):
        ingest.upsert_node_status(conn, t, i * 1000)

    n = conn.execute(
        "SELECT COUNT(*) FROM node_telemetry WHERE node_id = ? AND port = ?", ("ww-01", "ch0")
    ).fetchone()[0]
    assert n == 2  # readings 10 and 20 out of 25

    rows = conn.execute(
        "SELECT ts FROM node_telemetry WHERE node_id = ? AND port = ? ORDER BY ts", ("ww-01", "ch0")
    ).fetchall()
    assert [r["ts"] for r in rows] == [10_000, 20_000]


def test_platform_plain_csv_has_no_telemetry(conn):
    row, raw = ingest.parse_line("ww-01/ch0,0.5,60.0")
    assert row is not None
    assert raw is None
    assert ingest.telemetry({"device_id": "ww-01/ch0", "irms_a": 0.5, "watts": 60.0}) is None

    n_before = conn.execute("SELECT COUNT(*) FROM node_status").fetchone()[0]
    assert n_before == 0
