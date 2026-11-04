"""Tests for the v2 API endpoints in hub/api.py (P2/P5): nodes, system, audit,
analytics, export, model, insights/assistant/llm stubs, and the SSE stream.
"""

import json
import sys
import threading
import time

import pytest

from conftest import add_readings


FW_LINE = {
    "device_id": "ww-01", "port": "ch0", "boot_id": "1fdf7b78", "uptime_ms": 22996,
    "ts": None, "irms_raw_a": 0.0805, "peak_raw_a": 0.1209, "n_samples": 861,
    "over_ceiling": False, "over_limit": False, "fw": "0.1.1-a",
}


def _seed_node_status(conn, now, over_limit=0):
    conn.execute(
        "INSERT INTO node_status (node_id, port, device_id, fw, boot_id, uptime_ms, n_samples,"
        " irms_raw_a, peak_raw_a, over_limit, first_seen_ts, last_ts, boots, readings)"
        " VALUES ('ww-01', 'ch0', 'ww-01/ch0', '0.1.1-a', 'abc', 22996, 861, 0.0805, 0.1209, ?, ?, ?, 1, 20)",
        (over_limit, now - 1000, now),
    )
    conn.commit()


# ------------------------------------------------------------------- nodes

def test_platform_nodes_from_telemetry(client, conn):
    now = int(time.time() * 1000)
    add_readings(conn, "ww-01/ch0", now - 5000, [80.0] * 5)
    _seed_node_status(conn, now)

    rows = client.get("/api/nodes").json()
    node = next(n for n in rows if n["node_id"] == "ww-01")
    assert node["fw"] == "0.1.1-a"
    assert node["online"] is True
    assert node["boots"] == 1
    port = node["ports"][0]
    assert port["port"] == "ch0"
    assert port["device_id"] == "ww-01/ch0"
    assert port["crest_factor"] == pytest.approx(0.1209 / 0.0805, rel=1e-6)
    assert port["sample_rate_hz"] == 861

    detail = client.get("/api/nodes/ww-01").json()
    assert detail["node_id"] == "ww-01"
    assert "telemetry" in detail

    assert client.get("/api/nodes/nope").status_code == 404


def test_platform_nodes_plain_device_has_null_fw(client, conn):
    now = int(time.time() * 1000)
    add_readings(conn, "plug-1", now - 2000, [50.0, 50.0])

    rows = client.get("/api/nodes").json()
    node = next(n for n in rows if n["node_id"] == "plug-1")
    assert node["fw"] is None
    assert node["ports"][0]["device_id"] == "plug-1"


# ------------------------------------------------------------------ system

def test_platform_system_lists_six_services(client):
    body = client.get("/api/system").json()
    names = [s["service"] for s in body["services"]]
    assert names == ["ingest", "detect", "explain", "alerts", "api", "digest"]
    # "api" reports its own heartbeat in the background; the rest aren't running in this test.
    statuses = {s["service"]: s["status"] for s in body["services"]}
    assert statuses["api"] == "running"
    assert all(v == "down" for k, v in statuses.items() if k != "api")
    assert body["db"]["readings"] == 0
    assert "now_ms" in body
    assert "versions" in body


def test_platform_system_reports_running_service(client, conn):
    now = int(time.time() * 1000)
    conn.execute(
        "INSERT INTO service_status (service, pid, started_ts, heartbeat_ts, info)"
        " VALUES ('ingest', 1234, ?, ?, ?)",
        (now, now, json.dumps({"mode": "serial"})),
    )
    conn.commit()
    body = client.get("/api/system").json()
    ingest = next(s for s in body["services"] if s["service"] == "ingest")
    assert ingest["status"] == "running"
    assert ingest["pid"] == 1234
    assert ingest["info"] == {"mode": "serial"}


# ------------------------------------------------------------------- audit

def test_platform_audit_logs_writes(client, conn):
    now = int(time.time() * 1000)
    add_readings(conn, "ww-01/ch0", now - 1000, [50.0])
    client.get("/api/devices")  # registers the device so the PATCH below can find it
    client.patch("/api/devices/ww-01%2Fch0", json={"name": "Kettle"})

    rows = client.get("/api/audit").json()
    assert any(r["action"] == "patch_device" and r["target"] == "ww-01/ch0" for r in rows)
    assert all(r["actor"] == "local admin" for r in rows)


# --------------------------------------------------------------- analytics

def test_platform_analytics_summary_empty_db(client):
    body = client.get("/api/analytics/summary").json()
    assert body["kwh_today"] == 0
    assert body["always_on_w"] == 0
    assert body["active_w"] == 0
    assert body["peak_today_w"] == 0
    assert body["peak_today_ts"] is None
    assert "currency" in body


def test_platform_hourly_zero_filled(client):
    rows = client.get("/api/analytics/hourly?days=7").json()
    assert len(rows) == 7 * 24


def test_platform_summary_yesterday_same_time(client, conn, monkeypatch):
    """kwh_yesterday_same_time is yesterday from 00:00 to the same clock time as now --
    not the whole of yesterday (that's kwh_yesterday) -- so "vs yesterday" compares like
    with like instead of a few hours of today against all 24 h of yesterday.

    Dense enough (close to 1 Hz for the whole day) that neither figure trips the
    80%-coverage null guard (see test_platform_summary_yesterday_null_when_sparse
    below for the sparse case that guard exists for).
    """
    import api as api_module
    import store

    t = time.localtime()
    one_minute_past_midnight = time.struct_time((t.tm_year, t.tm_mon, t.tm_mday, 0, 1, 0, 0, 0, t.tm_isdst))
    now = int(time.mktime(one_minute_past_midnight) * 1000)
    monkeypatch.setattr(api_module, "now_ms", lambda: now)

    day_start = store.day_start_ms(now)
    yesterday_start = day_start - 86_400_000

    # Yesterday 00:00-00:01 (the "same time as now" window): fully covered at 1000 W.
    add_readings(conn, "ww-01/ch0", yesterday_start, [1000.0] * 60)
    # The rest of yesterday, also fully covered (at a different wattage) so
    # kwh_yesterday itself clears the coverage floor -- this is what must be
    # excluded from the same-time sum.
    add_readings(conn, "ww-01/ch0", yesterday_start + 60_000, [200.0] * (86_400 - 60))

    body = client.get("/api/analytics/summary").json()
    expected = 1000.0 * 60 / 3_600_000  # only the pre-cutoff block counts
    assert abs(body["kwh_yesterday_same_time"] - expected) < 1e-6
    assert body["kwh_yesterday"] is not None
    assert body["kwh_yesterday"] > body["kwh_yesterday_same_time"]


def test_platform_summary_yesterday_null_when_sparse(client, conn, monkeypatch):
    """A demo DB's "yesterday" (and its same-time slice) can be almost entirely
    empty early on. Reporting a number computed from a handful of readings over
    many sparse hours produces a nonsense swing like "+17928% vs yesterday" --
    both fields must come back null instead when their window's coverage
    (reading count / window seconds) is under 80%.
    """
    import api as api_module
    import store

    t = time.localtime()
    noon = time.struct_time((t.tm_year, t.tm_mon, t.tm_mday, 12, 0, 0, 0, 0, t.tm_isdst))
    now = int(time.mktime(noon) * 1000)
    monkeypatch.setattr(api_module, "now_ms", lambda: now)

    day_start = store.day_start_ms(now)
    yesterday_start = day_start - 86_400_000

    # A handful of readings scattered near the start of yesterday -- far under
    # 80% coverage of either the same-time window (00:00-12:00) or the full day.
    add_readings(conn, "ww-01/ch0", yesterday_start, [1000.0] * 5)

    body = client.get("/api/analytics/summary").json()
    assert body["kwh_yesterday_same_time"] is None
    assert body["kwh_yesterday"] is None
    # kwh_today is unaffected -- only yesterday's sparse windows are nulled.
    assert body["kwh_today"] == 0


def test_platform_breakdown_shares_sum_to_one(client, conn):
    now = int(time.time() * 1000)
    add_readings(conn, "ww-01/ch0", now - 3600_000, [100.0] * 3600)
    add_readings(conn, "ww-01/ch1", now - 3600_000, [300.0] * 3600)

    rows = client.get(f"/api/analytics/breakdown?since_ms={now - 3600_000}&until_ms={now}").json()
    total_share = sum(r["share"] for r in rows)
    assert total_share == pytest.approx(1.0, rel=1e-6)


# ------------------------------------------------------------------- export

def test_platform_export_readings_csv(client, conn):
    now = int(time.time() * 1000)
    add_readings(conn, "ww-01/ch0", now - 3000, [10.0, 20.0, 30.0])
    r = client.get(f"/api/export/readings.csv?device_id=ww-01%2Fch0&since_ms={now - 5000}&until_ms={now}")
    assert r.status_code == 200
    assert r.headers["content-type"].startswith("text/csv")
    lines = r.text.strip().splitlines()
    assert lines[0] == "ts,device_id,irms_a,watts"
    assert len(lines) == 4


def test_platform_export_events_csv(client, conn):
    now = int(time.time() * 1000)
    conn.execute(
        "INSERT INTO events (device_id, start_ts, end_ts, peak_w, baseline_w, score, method, explanation)"
        " VALUES ('ww-01/ch0', ?, ?, 1480.0, 10.0, 8.0, 'rule', 'x')",
        (now - 1000, now),
    )
    conn.commit()
    r = client.get("/api/export/events.csv")
    assert r.status_code == 200
    assert "ww-01/ch0" in r.text


# --------------------------------------------------------------------- model

def test_platform_model_not_trained(client):
    # MODEL_PATH/REPORT_PATH are process-wide (frozen at detect_iforest's first import), so
    # another test file's real training run earlier in this session can leave them behind;
    # clear them here rather than assume a pristine session, same as test_health.py does.
    from detect_iforest import MODEL_PATH

    MODEL_PATH.unlink(missing_ok=True)
    try:
        from detect_iforest import REPORT_PATH

        REPORT_PATH.unlink(missing_ok=True)
    except ImportError:
        pass

    body = client.get("/api/model").json()
    assert body["exists"] is False
    assert body["report"] is None


def test_platform_model_scores_503_without_score_series(client, conn):
    # detect_iforest.score_series doesn't exist yet (ML's function) -> 503, not a crash.
    r = client.get("/api/model/scores?device_id=ww-01%2Fch0")
    assert r.status_code == 503


def test_platform_train_job_lifecycle(client, monkeypatch):
    import tune_iforest

    def fake_run(db_path, model_out, report_out, minutes=None, progress=lambda pct, msg: None):
        progress(50, "halfway")
        progress(100, "done")
        return {"version": 1, "chosen_reason": "fake"}

    monkeypatch.setattr(tune_iforest, "run", fake_run)

    r = client.post("/api/model/train")
    assert r.status_code == 202
    job_id = r.json()["job_id"]

    # a second job while one may still be running should be refused or the first must finish fast
    for _ in range(50):
        status = client.get(f"/api/model/train/{job_id}").json()
        if status["status"] in ("done", "error"):
            break
        time.sleep(0.05)
    assert status["status"] == "done", status
    assert status["report"] == {"version": 1, "chosen_reason": "fake"}

    assert client.get("/api/model/train/nope").status_code == 404


def test_platform_train_job_409_when_already_running(client, monkeypatch):
    import threading
    import tune_iforest

    release = threading.Event()

    def slow_run(db_path, model_out, report_out, minutes=None, progress=lambda pct, msg: None):
        release.wait(5)
        return {"version": 1}

    monkeypatch.setattr(tune_iforest, "run", slow_run)
    try:
        r1 = client.post("/api/model/train")
        assert r1.status_code == 202
        r2 = client.post("/api/model/train")
        assert r2.status_code == 409
    finally:
        release.set()


# ------------------------------------------------------- insights/assistant/llm

def test_platform_insights_empty(client):
    assert client.get("/api/insights").json() == []


def test_platform_digest_503_when_module_missing(client, monkeypatch):
    # Simulate "ML hasn't shipped digest.py yet" even though it may already exist on
    # disk: sys.modules[name] = None makes `import digest` raise ImportError.
    monkeypatch.setitem(sys.modules, "digest", None)
    r = client.post("/api/insights/digest")
    assert r.status_code == 503


def test_platform_digest_503_on_generate_failure(client, monkeypatch):
    fake_digest = type(sys)("digest")

    def raise_generate(conn, now_ms):
        raise RuntimeError("Ollama unreachable")

    fake_digest.generate = raise_generate
    monkeypatch.setitem(sys.modules, "digest", fake_digest)
    r = client.post("/api/insights/digest")
    assert r.status_code == 503


def test_platform_digest_200_on_success(client, monkeypatch):
    fake_digest = type(sys)("digest")

    def fake_generate(conn, now_ms):
        return {"id": 1, "kind": "daily_digest", "created_ts": now_ms, "period_start": None,
                "period_end": None, "title": "Today so far: 0 kWh", "body": "Nothing yet.",
                "model": "llama3.2:3b", "latency_ms": 5}

    fake_digest.generate = fake_generate
    monkeypatch.setitem(sys.modules, "digest", fake_digest)
    r = client.post("/api/insights/digest")
    assert r.status_code == 200
    assert r.json()["title"].startswith("Today so far")


def test_platform_assistant_503_when_module_missing_or_llm_down(client, monkeypatch):
    # (a) "ML hasn't shipped assistant.py yet" -> 503 before any stream starts.
    monkeypatch.setitem(sys.modules, "assistant", None)
    r = client.post("/api/assistant", json={"question": "hello?"})
    assert r.status_code == 503
    monkeypatch.delitem(sys.modules, "assistant", raising=False)

    # (b) module available but Ollama is unreachable -> 503, still before the stream starts.
    import api as api_module

    def raise_get(*a, **k):
        raise ConnectionError("down")

    monkeypatch.setattr(api_module.requests, "get", raise_get)
    r = client.post("/api/assistant", json={"question": "hello?"})
    assert r.status_code == 503


def test_platform_llm_status_shape(client):
    body = client.get("/api/llm").json()
    assert "model" in body
    assert "reachable" in body
    assert "prompt_version" in body
    assert "eval" in body


# ---------------------------------------------------------------------- stream

def test_platform_stream_emits_reading(client, conn):
    # The stream only emits rows newer than the rowid it saw when its poll loop first ran
    # -- which happens the moment the body starts being read, not when the connection opens
    # -- so a reading written synchronously before iterating could race into the baseline
    # and never be seen. Insert it from a delayed background thread instead. Bounded by a
    # client-side timeout plus the server's own test-only iteration cap (see conftest.py),
    # so a logic regression fails fast instead of hanging the suite.
    now = int(time.time() * 1000)
    found = None
    pending_event = None

    def delayed_insert():
        time.sleep(0.2)
        add_readings(conn, "ww-01/ch0", now, [42.0])

    threading.Thread(target=delayed_insert, daemon=True).start()

    with client.stream("GET", "/api/stream", timeout=10.0) as r:
        assert r.status_code == 200
        for line in r.iter_lines():
            if line.startswith("event:"):
                pending_event = line[len("event:"):].strip()
            elif line.startswith("data:") and pending_event == "reading":
                data = json.loads(line[len("data:"):].strip())
                if data["device_id"] == "ww-01/ch0" and data["watts"] == 42.0:
                    found = data
                    break
    assert found is not None, "never saw the reading event"
