"""Tests for hub/api.py: the FastAPI app over store.py + readings/events."""

import time

from conftest import add_readings


def test_empty_db_endpoints(client):
    for path in (
        "/api/health", "/api/overview", "/api/devices", "/api/readings?device_id=nope",
        "/api/energy/daily", "/api/events", "/api/alerts", "/api/alerts/summary",
        "/api/rules", "/api/topology", "/api/settings",
    ):
        r = client.get(path)
        assert r.status_code == 200, path

    assert client.get("/api/devices").json() == []
    assert client.get("/api/events").json() == []
    assert client.get("/api/alerts").json() == []

    overview = client.get("/api/overview").json()
    assert overview["devices_online"] == 0
    assert overview["devices_total"] == 0
    assert overview["kwh_today"] == 0
    assert overview["open_alerts"] == 0

    daily = client.get("/api/energy/daily").json()
    assert len(daily) == 7
    assert all(d["kwh"] == 0 for d in daily)

    topo = client.get("/api/topology").json()
    assert [n["id"] for n in topo["nodes"]] == ["hub"]
    assert topo["nodes"][0]["status"] == "offline"

    settings = client.get("/api/settings").json()
    assert settings["price_per_kwh"] == 0.15


def test_device_id_with_slash(client, conn):
    now = int(time.time() * 1000)
    add_readings(conn, "ww-01/ch0", now - 5000, [100, 100, 100, 100, 100])

    r = client.get("/api/devices/ww-01%2Fch0")
    assert r.status_code == 200
    assert r.json()["device_id"] == "ww-01/ch0"

    r = client.patch("/api/devices/ww-01%2Fch0", json={"name": "Kettle"})
    assert r.status_code == 200
    assert r.json()["name"] == "Kettle"

    r = client.get("/api/devices/ww-01%2Fch0")
    assert r.json()["name"] == "Kettle"


def test_readings_downsampled(client, conn):
    now = int(time.time() * 1000)
    start = now - 86_400 * 1000
    conn.executemany(
        "INSERT INTO readings VALUES (?, ?, ?, ?)",
        [(start + i * 1000, "ww-01/ch0", 1.0, 100.0 + (i % 50)) for i in range(86_400)],
    )
    conn.commit()

    url = f"/api/readings?device_id=ww-01%2Fch0&since_ms={start}&until_ms={now}&max_points=600"
    r = client.get(url)  # first call, warms up any caches
    assert r.status_code == 200
    body = r.json()
    assert body["device_id"] == "ww-01/ch0"
    assert len(body["points"]) <= 600

    t0 = time.monotonic()
    r = client.get(url)
    elapsed = time.monotonic() - t0
    assert r.status_code == 200
    assert elapsed < 0.3


def test_alert_ack_resolve_flow(client, conn):
    now = int(time.time() * 1000)
    conn.execute(
        "INSERT INTO alerts (device_id, kind, severity, title, status, opened_ts, updated_ts)"
        " VALUES ('ww-01/ch0', 'spike', 'warning', 'Spike on Kettle: 1480 W', 'open', ?, ?)",
        (now, now),
    )
    conn.commit()
    alert_id = conn.execute("SELECT id FROM alerts").fetchone()[0]

    r = client.post(f"/api/alerts/{alert_id}/ack")
    assert r.status_code == 200
    assert r.json()["status"] == "acknowledged"

    r = client.post(f"/api/alerts/{alert_id}/ack")
    assert r.status_code == 409

    r = client.post(f"/api/alerts/{alert_id}/resolve")
    assert r.status_code == 200
    assert r.json()["status"] == "resolved"

    r = client.post(f"/api/alerts/{alert_id}/resolve")
    assert r.status_code == 409


def test_rules_crud(client):
    r = client.post("/api/rules", json={
        "name": "Test rule", "kind": "spike", "device_id": None, "threshold": None,
        "duration_s": 0, "severity": "warning", "enabled": True,
    })
    assert r.status_code == 201
    rule = r.json()
    rule_id = rule["id"]
    assert rule["name"] == "Test rule"

    r = client.patch(f"/api/rules/{rule_id}", json={"threshold": 100.0, "enabled": False})
    assert r.status_code == 200
    assert r.json()["threshold"] == 100.0
    assert r.json()["enabled"] is False

    r = client.delete(f"/api/rules/{rule_id}")
    assert r.status_code == 204

    r = client.get("/api/rules")
    assert all(x["id"] != rule_id for x in r.json())


def test_topology_tree(client, conn):
    now = int(time.time() * 1000)
    for device_id in ("ww-01/ch0", "ww-01/ch1", "plug-1"):
        conn.execute("INSERT INTO readings VALUES (?, ?, ?, ?)", (now, device_id, 1.0, 100.0))
    conn.commit()

    r = client.get("/api/topology")
    nodes = r.json()["nodes"]
    by_kind = {}
    for n in nodes:
        by_kind.setdefault(n["kind"], []).append(n)
    assert len(by_kind["hub"]) == 1
    assert len(by_kind["node"]) == 2
    assert len(by_kind["port"]) == 2
    assert len(by_kind["appliance"]) == 3

    assert next(n for n in nodes if n["id"] == "node:ww-01")["parent"] == "hub"
    assert next(n for n in nodes if n["id"] == "port:ww-01/ch0")["parent"] == "node:ww-01"
    appliance = next(n for n in nodes if n["id"] == "dev:ww-01/ch0")
    assert appliance["parent"] == "port:ww-01/ch0"
    assert appliance["device_id"] == "ww-01/ch0"
    plug_appliance = next(n for n in nodes if n["id"] == "dev:plug-1")
    assert plug_appliance["parent"] == "node:plug-1"

    r = client.patch("/api/topology/node:ww-01", json={"x": 42.0, "y": 7.0})
    assert r.status_code == 200
    assert r.json()["x"] == 42.0
    assert r.json()["y"] == 7.0

    r = client.get("/api/topology")
    node_ww01 = next(n for n in r.json()["nodes"] if n["id"] == "node:ww-01")
    assert node_ww01["x"] == 42.0
    assert node_ww01["y"] == 7.0


def test_overview_counts_online(client, conn):
    now = int(time.time() * 1000)
    conn.execute("INSERT INTO readings VALUES (?, ?, ?, ?)", (now - 2000, "ww-01/ch0", 1.0, 100.0))
    conn.execute("INSERT INTO readings VALUES (?, ?, ?, ?)", (now - 600_000, "ww-02/ch0", 0.5, 50.0))
    conn.commit()

    body = client.get("/api/overview").json()
    assert body["devices_total"] == 2
    assert body["devices_online"] == 1


def test_energy_daily_zero_filled(client):
    r = client.get("/api/energy/daily?days=7")
    assert r.status_code == 200
    days = r.json()
    assert len(days) == 7
    assert all(d["kwh"] == 0 and d["cost"] == 0 for d in days)


def test_settings_patch_rejects_unknown_key(client):
    r = client.patch("/api/settings", json={"bogus": 1})
    assert r.status_code == 422


def test_readings_reports_last_ts_outside_window(client, conn):
    now = int(time.time() * 1000)
    old_ts = now - 3_600_000  # 1 h ago, outside the default 10 min window
    conn.execute("INSERT INTO readings VALUES (?, ?, ?, ?)", (old_ts, "ww-01/ch0", 0.5, 60.0))
    conn.commit()

    r = client.get("/api/readings?device_id=ww-01%2Fch0")
    body = r.json()
    assert body["points"] == []
    assert body["last_ts"] == old_ts


def test_alert_detectors_lists_both(client, conn):
    now = int(time.time() * 1000)
    conn.execute(
        "INSERT INTO devices (device_id, name, kind, created_ts) VALUES (?, ?, 'kettle', ?)",
        ("ww-01/ch0", "Kettle", now),
    )
    rule_event = conn.execute(
        "INSERT INTO events (device_id, start_ts, end_ts, peak_w, baseline_w, score, method, explanation)"
        " VALUES ('ww-01/ch0', ?, ?, 1480.0, 10.0, 8.0, 'rule', NULL)",
        (now - 1000, now),
    ).lastrowid
    conn.execute(
        "INSERT INTO events (device_id, start_ts, end_ts, peak_w, baseline_w, score, method, explanation)"
        " VALUES ('ww-01/ch0', ?, ?, 1480.0, 10.0, -0.3, 'iforest', NULL)",
        (now - 1000, now),
    )
    conn.execute(
        "INSERT INTO alerts (rule_id, device_id, kind, severity, title, event_id, status, opened_ts, updated_ts)"
        " VALUES (1, 'ww-01/ch0', 'spike', 'warning', 'Spike on Kettle: 1480 W', ?, 'open', ?, ?)",
        (rule_event, now, now),
    )
    conn.commit()

    rows = client.get("/api/alerts").json()
    row = next(r for r in rows if r["kind"] == "spike")
    assert sorted(row["detectors"]) == ["iforest", "rule"]


def test_incidents_merge_rule_and_iforest(client, conn):
    now = int(time.time() * 1000)
    conn.execute(
        "INSERT INTO devices (device_id, name, kind, created_ts) VALUES (?, ?, 'kettle', ?)",
        ("ww-01/ch0", "Kettle", now),
    )
    conn.execute(
        "INSERT INTO events (device_id, start_ts, end_ts, peak_w, baseline_w, score, method, explanation)"
        " VALUES ('ww-01/ch0', ?, ?, 1480.0, 10.0, 8.0, 'rule', 'Likely the kettle.')",
        (now - 60_000, now - 55_000),
    )
    conn.execute(
        "INSERT INTO events (device_id, start_ts, end_ts, peak_w, baseline_w, score, method, explanation)"
        " VALUES ('ww-01/ch0', ?, ?, 1480.0, 10.0, -0.3, 'iforest', NULL)",
        (now - 59_000, now - 54_000),
    )
    conn.commit()

    incidents = client.get("/api/incidents?device_id=ww-01%2Fch0").json()
    assert len(incidents) == 1
    inc = incidents[0]
    assert sorted(inc["methods"]) == ["iforest", "rule"]
    assert inc["rule_score"] == 8.0
    assert inc["iforest_score"] == -0.3
    assert inc["explanation"] == "Likely the kettle."
    assert len(inc["event_ids"]) == 2
    assert inc["id"].startswith("i-")


def test_incidents_keep_separate_events_apart(client, conn):
    now = int(time.time() * 1000)
    conn.execute(
        "INSERT INTO devices (device_id, name, kind, created_ts) VALUES (?, ?, 'kettle', ?)",
        ("ww-01/ch0", "Kettle", now),
    )
    conn.execute(
        "INSERT INTO events (device_id, start_ts, end_ts, peak_w, baseline_w, score, method, explanation)"
        " VALUES ('ww-01/ch0', ?, ?, 1480.0, 10.0, 8.0, 'rule', NULL)",
        (now - 100_000, now - 95_000),
    )
    # starts 20 s after the first event ends: must stay a separate incident
    conn.execute(
        "INSERT INTO events (device_id, start_ts, end_ts, peak_w, baseline_w, score, method, explanation)"
        " VALUES ('ww-01/ch0', ?, ?, 1480.0, 10.0, 8.0, 'rule', NULL)",
        (now - 75_000, now - 70_000),
    )
    conn.commit()

    incidents = client.get("/api/incidents?device_id=ww-01%2Fch0").json()
    assert len(incidents) == 2
