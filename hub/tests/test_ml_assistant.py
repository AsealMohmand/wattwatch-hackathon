"""ML5: assistant context shape, streaming protocol, and the digest insert.
`llm.chat_stream`/`llm.chat` are monkeypatched; no real Ollama call.
"""

import json
import re
import time

import pytest

import assistant
import digest
import llm


def test_ml_assistant_context_has_core_keys(conn):
    now_ms = 1_700_000_000_000
    conn.executemany(
        "INSERT INTO readings VALUES (?,?,?,?)",
        [(now_ms - i * 1000, "ww-01/ch0", 0.7, 80.0) for i in range(60)],
    )
    conn.commit()

    ctx = assistant.build_context(conn, now_ms)

    for key in (
        "site_name", "currency", "price_per_kwh", "co2_kg_per_kwh", "devices", "nodes",
        "incidents", "open_alerts", "hourly_kwh_today", "kwh_today", "kwh_yesterday",
        "kwh_mtd", "cost_today", "cost_mtd", "co2_kg_today", "model",
    ):
        assert key in ctx, f"missing context key: {key}"
    assert isinstance(ctx["devices"], list)
    assert isinstance(ctx["nodes"], list)
    assert isinstance(ctx["model"], dict) and "trained" in ctx["model"]


def test_ml_assistant_context_rounds_numbers_and_formats_timestamps(conn):
    """A real answer once said '1.0735004764565215 kilowatt-hours' because the context
    handed the model an unrounded float. Every number in the context must already be
    rounded (kWh/cost to 2dp, watts to whole numbers) and every timestamp must be a
    local HH:MM/date string, never raw epoch ms -- round at the source, since the
    system prompt already tells the model to quote numbers exactly as given.
    """
    now_ms = 1_700_000_000_000
    # 60 readings of 80 W -> kwh_today = 60*80/3_600_000 = 0.13333...: a real repeating decimal.
    conn.executemany(
        "INSERT INTO readings VALUES (?,?,?,?)",
        [(now_ms - i * 1000, "ww-01/ch0", 0.7, 80.0) for i in range(60)],
    )
    conn.execute(
        "INSERT INTO events (device_id, start_ts, end_ts, peak_w, baseline_w, score, method)"
        " VALUES ('ww-01/ch0', ?, ?, 1480.3333, 80.1234, -0.2, 'iforest')",
        (now_ms - 30_000, now_ms - 10_000),
    )
    conn.commit()

    ctx = assistant.build_context(conn, now_ms)

    assert "now_ms" not in ctx and "start_ts" not in json.dumps(ctx["incidents"])
    assert re.fullmatch(r"\d{2}:\d{2}", ctx["now_local"])
    assert re.fullmatch(r"\d{4}-\d{2}-\d{2}", ctx["today"])

    assert ctx["kwh_today"] == round(ctx["kwh_today"], 2)
    assert ctx["cost_today"] == round(ctx["cost_today"], 2)

    for d in ctx["devices"]:
        if d["watts"] is not None:
            assert isinstance(d["watts"], int)
        assert d["kwh_today"] == round(d["kwh_today"], 2)

    assert len(ctx["incidents"]) == 1
    incident = ctx["incidents"][0]
    assert re.fullmatch(r"\d{2}:\d{2}", incident["local_time"])
    assert incident["peak_w"] == 1480  # rounded from 1480.3333
    assert incident["baseline_w"] == 80  # rounded from 80.1234

    # no raw epoch-scale number anywhere in the serialized context (13-digit ms, or even
    # the 10-digit seconds form) -- that's the exact shape of number that confused the model.
    assert not re.search(r"\d{10,}", json.dumps(ctx))


def test_ml_assistant_stream_emits_done(conn, monkeypatch):
    def fake_stream(messages, model=None, timeout=60):
        yield "Nothing "
        yield "unusual "
        yield "today."

    monkeypatch.setattr(llm, "chat_stream", fake_stream)

    events = list(assistant.answer_stream(conn, "Is anything unusual?", [], 1_700_000_000_000))

    assert events[-1][0] in ("done", "error")
    kind, payload = events[-1]
    assert kind == "done"
    assert "latency_ms" in payload and "model" in payload and "context_keys" in payload
    assert "site_name" in payload["context_keys"]
    tokens = [p["t"] for k, p in events if k == "token"]
    assert "".join(tokens) == "Nothing unusual today."


def test_ml_assistant_stream_emits_error_on_failure(conn, monkeypatch):
    def fake_stream(messages, model=None, timeout=60):
        raise ConnectionError("ollama down")
        yield  # pragma: no cover -- makes this a generator

    monkeypatch.setattr(llm, "chat_stream", fake_stream)

    events = list(assistant.answer_stream(conn, "hello", [], 1_700_000_000_000))
    assert events[-1][0] == "error"
    assert "message" in events[-1][1]


def test_ml_digest_inserts_row(conn, monkeypatch):
    now_ms = 1_700_000_000_000
    conn.executemany(
        "INSERT INTO readings VALUES (?,?,?,?)",
        [(now_ms - i * 1000, "ww-01/ch0", 0.7, 80.0) for i in range(60)],
    )
    conn.commit()

    def fake_chat(messages, model=None, format=None, timeout=20, options=None):
        return ("Usage stayed near the baseline all day, with no incidents worth checking. "
                "Costs are tracking in line with yesterday."), 180

    monkeypatch.setattr(llm, "chat", fake_chat)

    row = digest.generate(conn, now_ms)

    assert row["kind"] == "daily_digest"
    assert row["title"].startswith("Today so far:")
    assert row["body"]
    assert row["model"] == llm.MODEL
    assert row["latency_ms"] == 180

    stored = conn.execute("SELECT * FROM insights WHERE id = ?", (row["id"],)).fetchone()
    assert stored is not None
    assert stored["kind"] == "daily_digest"


def test_ml_digest_rejects_non_prose_reply(conn, monkeypatch):
    """Regression for the real bug: a raw/unrounded context got the model to echo back
    data instead of writing prose -- 'POST /api/insights/digest' returned 200 with a body
    like "1793785064342 1793785064342 0.23... 0.60...". generate() must reject that rather
    than store it, so a bad reply never clobbers the last good digest.
    """
    now_ms = 1_700_000_000_000
    conn.executemany(
        "INSERT INTO readings VALUES (?,?,?,?)",
        [(now_ms - i * 1000, "ww-01/ch0", 0.7, 80.0) for i in range(60)],
    )
    conn.commit()

    garbage = "1793785064342 1793785064342 0.23384615384615384 0.6078692810457516"

    def fake_chat(messages, model=None, format=None, timeout=20, options=None):
        return garbage, 50

    monkeypatch.setattr(llm, "chat", fake_chat)

    with pytest.raises(RuntimeError):
        digest.generate(conn, now_ms)

    assert conn.execute("SELECT COUNT(*) FROM insights").fetchone()[0] == 0


def test_ml_digest_rejects_restated_settings(conn, monkeypatch):
    """Regression for the real bug: a digest read 'The current time is 03:50... the cost of
    electricity per kWh is $0.15...' -- restating settings the user already sees elsewhere,
    instead of giving insight. generate() must reject that (even though it reads as fine
    prose) rather than store it.
    """
    now_ms = 1_700_000_000_000
    conn.executemany(
        "INSERT INTO readings VALUES (?,?,?,?)",
        [(now_ms - i * 1000, "ww-01/ch0", 0.7, 80.0) for i in range(60)],
    )
    conn.commit()

    restated = (
        "The current time is 03:50 and today's date is 2023-11-14. Usage has been steady, and "
        "the cost of electricity per kWh is $0.15, in line with yesterday."
    )

    def fake_chat(messages, model=None, format=None, timeout=20, options=None):
        return restated, 90

    monkeypatch.setattr(llm, "chat", fake_chat)

    with pytest.raises(RuntimeError):
        digest.generate(conn, now_ms)

    assert conn.execute("SELECT COUNT(*) FROM insights").fetchone()[0] == 0


def test_ml_digest_prompt_context_has_no_raw_timestamps_or_long_floats(conn, monkeypatch):
    """Checks the prompt actually built, not just build_context's return value: the JSON
    the model receives must not contain an epoch-scale number or an unrounded float.
    """
    now_ms = 1_700_000_000_000
    conn.executemany(
        "INSERT INTO readings VALUES (?,?,?,?)",
        [(now_ms - 1000, "ww-01/ch0", 0.7, 83.33333), (now_ms, "ww-01/ch0", 0.7, 83.33333)],
    )
    conn.commit()

    captured = {}

    def fake_chat(messages, model=None, format=None, timeout=20, options=None):
        captured["messages"] = messages
        return "Nothing unusual happened today. Usage stayed near the baseline.", 50

    monkeypatch.setattr(llm, "chat", fake_chat)
    digest.generate(conn, now_ms)

    user_content = next(m["content"] for m in captured["messages"] if m["role"] == "user")
    assert not re.search(r"\d{10,}", user_content), "a raw epoch timestamp leaked into the prompt"
    for match in re.findall(r"\d+\.\d+", user_content):
        decimals = match.split(".")[1]
        assert len(decimals) <= 2, f"unrounded float in prompt: {match}"
