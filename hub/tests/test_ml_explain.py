"""ML3: structured explainer -- rejects invented numbers, falls back on
failure, and writes the `explanations` row plus the legacy `events.explanation`.
`llm.chat` is monkeypatched throughout; no real Ollama call.
"""

import json

import pytest

import explain
import llm


def make_event(conn, device_id="ww-01/ch0", start_ts=1_700_000_000_000, duration_s=60,
               baseline_w=80, peak_w=1480):
    end_ts = start_ts + duration_s * 1000
    cur = conn.execute(
        "INSERT INTO events (device_id, start_ts, end_ts, peak_w, baseline_w, score, method)"
        " VALUES (?, ?, ?, ?, ?, ?, ?)",
        (device_id, start_ts, end_ts, peak_w, baseline_w, -0.2, "iforest"),
    )
    conn.commit()
    return conn.execute("SELECT * FROM events WHERE id = ?", (cur.lastrowid,)).fetchone()


def test_ml_explainer_rejects_invented_numbers(conn, monkeypatch):
    e = make_event(conn)
    now_ms = e["end_ts"] + explain.SETTLE_MS + 1000
    calls = []

    def fake_chat(messages, model=None, format=None, timeout=20, options=None):
        calls.append(options)
        data = {"appliance": "kettle", "confidence": "high", "verdict": "normal",
                "summary": "Power jumped to 9999 W for 10 s."}  # 9999 not in the input facts
        return json.dumps(data), 42

    monkeypatch.setattr(llm, "chat", fake_chat)
    data = explain.explain_event(conn, e, now_ms)

    assert len(calls) == 2  # one try, one retry at temperature 0
    assert calls[1] == {"temperature": 0}
    assert data["summary"] == explain.template(e)  # fell back to the template

    row = conn.execute("SELECT * FROM explanations WHERE event_id = ?", (e["id"],)).fetchone()
    assert row["fallback"] == 1
    assert row["prompt_version"] == "v2"
    assert conn.execute("SELECT explanation FROM events WHERE id = ?", (e["id"],)).fetchone()["explanation"] == data["summary"]


def test_ml_explainer_falls_back_on_timeout(conn, monkeypatch):
    e = make_event(conn)
    now_ms = e["end_ts"] + explain.SETTLE_MS + 1000

    def fake_chat(messages, model=None, format=None, timeout=20, options=None):
        raise TimeoutError("ollama did not respond")

    monkeypatch.setattr(llm, "chat", fake_chat)
    data = explain.explain_event(conn, e, now_ms)

    assert data["summary"] == explain.template(e)
    row = conn.execute("SELECT * FROM explanations WHERE event_id = ?", (e["id"],)).fetchone()
    assert row["fallback"] == 1
    assert row["model"]


def test_ml_explainer_writes_structured_row(conn, monkeypatch):
    e = make_event(conn, baseline_w=80, peak_w=1480, duration_s=95)
    now_ms = e["end_ts"] + explain.SETTLE_MS + 1000

    def fake_chat(messages, model=None, format=None, timeout=20, options=None):
        data = {"appliance": "kettle", "confidence": "high", "verdict": "normal",
                "summary": "Power jumped from 80 W to 1480 W for 96 s, matching a kettle boiling. "
                           "That's normal."}
        return json.dumps(data), 350

    monkeypatch.setattr(llm, "chat", fake_chat)
    data = explain.explain_event(conn, e, now_ms)

    assert data["appliance"] == "kettle"
    assert data["confidence"] == "high"
    assert data["verdict"] == "normal"

    row = conn.execute("SELECT * FROM explanations WHERE event_id = ?", (e["id"],)).fetchone()
    assert row is not None
    assert row["appliance"] == "kettle"
    assert row["confidence"] == "high"
    assert row["verdict"] == "normal"
    assert row["summary"] == data["summary"]
    assert row["prompt_version"] == "v2"
    assert row["fallback"] == 0
    assert row["latency_ms"] == 350

    ev = conn.execute("SELECT explanation FROM events WHERE id = ?", (e["id"],)).fetchone()
    assert ev["explanation"] == data["summary"]
