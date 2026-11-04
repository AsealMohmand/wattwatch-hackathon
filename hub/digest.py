"""Daily AI digest: a 3-5 sentence summary of the day's energy use, written by
Llama from the same grounded context the assistant uses, stored as an
`insights` row (kind "daily_digest").

    python digest.py     # loop: generate when none exists for today, or the
                          # last one is more than 60 min old
"""

import json
import re
import time

import assistant
import llm
import store
from db import connect
from heartbeat import Heartbeat

SYSTEM_PROMPT = (
    "Write a 3-5 sentence daily energy digest for a home dashboard, from the JSON context given "
    "below. Give insight, not a recap: name the biggest consumer (context.biggest_consumer) and "
    "its share of today's usage so far, call out anything unusual -- an open incident in "
    "context.incidents, an always-on load, or an offline node in context.offline_nodes -- compare "
    "today's usage so far with context.kwh_yesterday_same_time (the same time yesterday, not the "
    "whole of yesterday), and end with one concrete suggestion only if the data actually supports "
    "one; otherwise skip the suggestion rather than inventing one. "
    "Only use numbers already present in the context -- never invent or recompute one. Never "
    "restate the current time, today's date, or the price per kWh; the reader already has those "
    "on screen. Write plain prose sentences (not a list of the numbers), no markdown, no headers, "
    "no preamble.\n\n"
    "Example 1 -- context: {\"kwh_today\": 2.1, \"kwh_yesterday_same_time\": 2.6, "
    "\"biggest_consumer\": {\"name\": \"Space heater\", \"kwh_today\": 1.4, \"share_pct\": 67}, "
    "\"offline_nodes\": [], \"incidents\": [{\"device_name\": \"Kettle\", \"local_time\": \"07:12\"}]}\n"
    "Digest: The space heater is today's biggest draw at 1.4 kWh, about two-thirds of the 2.1 kWh "
    "used so far. That's a bit behind this time yesterday's 2.6 kWh. The kettle's 07:12 boil was "
    "the only notable event; nothing else looks out of place.\n\n"
    "Example 2 -- context: {\"kwh_today\": 0.6, \"kwh_yesterday_same_time\": 0.4, "
    "\"biggest_consumer\": {\"name\": \"Fridge\", \"kwh_today\": 0.3, \"share_pct\": 50}, "
    "\"offline_nodes\": [\"ww-02\"], \"incidents\": []}\n"
    "Digest: The fridge accounts for half of today's 0.6 kWh, with everything else quiet so far. "
    "That's ahead of this time yesterday's 0.4 kWh. Node ww-02 has dropped offline; worth checking "
    "it's still plugged in and powered."
)
STALE_MS = 60 * 60 * 1000
LOOP_SLEEP_S = 30
_LONG_NUMBER_RE = re.compile(r"\d{10,}")  # a raw epoch timestamp leaking into the reply
# The exact restated-settings phrases a prior real digest used ("The current time is 03:50...
# cost of electricity per kWh is $0.15..."): the reader already sees these on screen, so a
# digest that restates them is reciting settings instead of giving insight.
_RESTATED_SETTINGS_RE = re.compile(r"current time|today'?s date|per\s*kwh\s+is", re.I)


def _looks_like_prose(text):
    """Guards against the failure mode a raw, unrounded context produces: the model
    echoing context values back (timestamps, long floats) instead of writing sentences.
    """
    if not text or _LONG_NUMBER_RE.search(text):
        return False
    sentences = [s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s]
    return len(sentences) >= 2 and len(text.split()) >= 8


def _restates_settings(text):
    """True if the body recites a setting instead of giving insight (see
    _RESTATED_SETTINGS_RE) -- the thing a user already sees elsewhere on the dashboard."""
    return bool(_RESTATED_SETTINGS_RE.search(text))


def _augment_context(context):
    """Adds digest-only analysis hints on top of assistant.build_context's fixed keys, so
    the model quotes a pre-computed biggest-consumer share and offline-node list instead of
    doing that arithmetic itself (a 3b model does both unreliably).
    """
    devices = context.get("devices") or []
    kwh_today = context.get("kwh_today") or 0.0
    biggest = max(devices, key=lambda d: d.get("kwh_today") or 0.0, default=None)
    biggest_consumer = None
    if biggest and (biggest.get("kwh_today") or 0.0) > 0:
        share_pct = round(100 * biggest["kwh_today"] / kwh_today) if kwh_today else None
        biggest_consumer = {
            "name": biggest["name"], "kwh_today": biggest["kwh_today"], "share_pct": share_pct,
        }
    offline_nodes = [n["node_id"] for n in (context.get("nodes") or []) if not n.get("online")]
    out = dict(context)
    out["biggest_consumer"] = biggest_consumer
    out["offline_nodes"] = offline_nodes
    return out


def generate(conn, now_ms: int) -> dict:
    """Builds a digest from assistant.build_context (plus digest-only analysis hints), asks
    Llama to write it, inserts an `insights` row (kind daily_digest), and returns that row as
    an Insight dict. Raises on LLM failure, or if both attempts come back invalid -- callers
    (API) should surface that as a 503 and let the last good digest keep showing rather than
    inserting a bad one.
    """
    context = _augment_context(assistant.build_context(conn, now_ms))
    day_start = store.day_start_ms(now_ms)
    currency = context["currency"]
    kwh_today = context["kwh_today"]
    cost_today = context["cost_today"]
    title = f"Today so far: {kwh_today:.1f} kWh, {currency}{cost_today:.2f}"

    messages = [
        {"role": "system", "content": SYSTEM_PROMPT},
        {"role": "user", "content": json.dumps(context)},
    ]
    body, latency_ms, last_bad = None, 0, None
    for attempt in range(2):  # first try default temp, retry once at temperature 0
        options = {"temperature": 0} if attempt == 1 else None
        text, latency_ms = llm.chat(messages, timeout=30, options=options)
        candidate = text.strip()
        if _looks_like_prose(candidate) and not _restates_settings(candidate):
            body = candidate
            break
        last_bad = candidate
    if body is None:
        raise RuntimeError(f"digest reply invalid after retry, discarding: {last_bad!r}")

    created_ts = int(time.time() * 1000)
    cur = conn.execute(
        "INSERT INTO insights (kind, created_ts, period_start, period_end, title, body, model, latency_ms)"
        " VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        ("daily_digest", created_ts, day_start, now_ms, title, body, llm.MODEL, latency_ms),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM insights WHERE id = ?", (cur.lastrowid,)).fetchone()
    return dict(row)


def _needs_digest(conn, now_ms):
    day_start = store.day_start_ms(now_ms)
    last = conn.execute(
        "SELECT created_ts FROM insights WHERE kind = 'daily_digest' ORDER BY created_ts DESC LIMIT 1"
    ).fetchone()
    if last is None:
        return True
    if last["created_ts"] < day_start:
        return True
    return now_ms - last["created_ts"] > STALE_MS


def main():
    conn = connect()
    hb = Heartbeat(conn, "digest")
    print(f"digest: generating with {llm.MODEL} when stale")
    while True:
        hb.tick()
        now_ms = int(time.time() * 1000)
        if _needs_digest(conn, now_ms):
            try:
                row = generate(conn, now_ms)
                print(f"digest: generated #{row['id']} ({row['title']})")
            except Exception as err:
                print(f"digest: failed ({err}); will retry")
        # Beat while waiting: the System page calls a service stale after 15 s of silence.
        for _ in range(LOOP_SLEEP_S // 5):
            time.sleep(5)
            hb.tick()


if __name__ == "__main__":
    main()
