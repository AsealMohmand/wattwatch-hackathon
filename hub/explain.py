"""Explainer worker: a local Llama model turns each event into a structured
verdict (prompt v2) stored in `explanations`, plus the legacy plain-text
`events.explanation` line for compatibility with everything that already
reads it.

Runs off the detection loop: it polls for events with `explanation IS NULL`, so a
slow model never delays detection. Llama's JSON reply is validated (no invented
numbers, at most two sentences); on failure it retries once at temperature 0,
then falls back to a template line, so the dashboard never shows a blank or a
hallucinated number.

    ollama pull llama3.2:3b
    python explain.py                      # OLLAMA_MODEL=llama3.2:1b if CPU is slow
"""

import json
import re
import time
from datetime import datetime

from db import connect
from heartbeat import Heartbeat
import llm

TIMEOUT_S = 20
SETTLE_MS = 5000   # explain once the event has ended (no flag for 5 s) ...
EARLY_MS = 8000    # ... or has been running this long, so the demo doesn't wait out a kettle
PROMPT_VERSION = "v2"

RESPONSE_SCHEMA = {
    "type": "object",
    "properties": {
        "appliance": {"type": "string"},
        "confidence": {"type": "string", "enum": ["low", "medium", "high"]},
        "verdict": {"type": "string", "enum": ["normal", "check"]},
        "summary": {"type": "string"},
    },
    "required": ["appliance", "confidence", "verdict", "summary"],
}

# prompt v1: the original plain two-sentence explainer. Kept only so
# eval_explain.py can score it against v2; the live loop always uses v2.
SYSTEM_V1 = (
    "You explain home power readings in two short sentences. "
    "Sentence 1: what likely caused it (appliance type guess, with your confidence). "
    "Sentence 2: whether it looks normal or worth checking. "
    "Never invent numbers not given. "
    "If still_running is true the appliance is still on, so running_for_s is not its final duration. "
    "Reply with just the two sentences: no preamble, no labels."
)

# prompt v2: structured JSON, grounded with device metadata and a few-shot set.
SYSTEM_V2 = (
    "You are an electrician's assistant explaining a home power reading to its owner. "
    "You are given JSON facts about one event: device id, device name/kind/room/rated_w when known, "
    "the local time, baseline and peak watts, how long it ran (duration_s, or running_for_s if "
    "still_running is true), and similar_events_today (how many similar jumps happened earlier today). "
    "Reply with ONLY a JSON object: "
    '{"appliance": string, "confidence": "low"|"medium"|"high", "verdict": "normal"|"check", "summary": string}. '
    "appliance is your best guess at what caused it (use device_name/device_kind if given). "
    "summary is at most two short sentences: what likely caused it, and whether it looks normal or worth "
    "checking. Every number you write in summary must be one already present in the input facts (rounding "
    "to the nearest whole number is fine). Never invent a number. If still_running is true, say it is still "
    "running rather than stating a final duration."
)

FEWSHOT = [
    (
        {"device": "ww-01/ch0", "device_kind": "kettle", "baseline_w": 80, "peak_w": 1480,
         "duration_s": 95, "local_time": "07:12", "similar_events_today": 2},
        {"appliance": "kettle", "confidence": "high", "verdict": "normal",
         "summary": "Power jumped from 80 W to 1480 W for 95 s, matching an electric kettle boiling. "
                     "That's normal; it's happened 2 other times today."},
    ),
    (
        {"device": "ww-01/ch1", "baseline_w": 85, "peak_w": 1210, "running_for_s": 1900,
         "still_running": True, "local_time": "14:40", "similar_events_today": 0},
        {"appliance": "space heater", "confidence": "medium", "verdict": "check",
         "summary": "Power has held near 1210 W for over 1900 s and is still running, consistent with a "
                     "space heater. Worth checking it's meant to stay on that long."},
    ),
    (
        {"device": "ww-01/ch0", "baseline_w": 78, "peak_w": 328, "duration_s": 40,
         "local_time": "03:12", "similar_events_today": 0},
        {"appliance": "unknown appliance", "confidence": "low", "verdict": "check",
         "summary": "Power rose from 78 W to 328 W for 40 s at 03:12, with no similar events earlier "
                     "today. Cause is unclear; worth checking."},
    ),
]


def template(e):
    secs = max(1, round((e["end_ts"] - e["start_ts"]) / 1000) + 1)
    return f"Power jumped from {e['baseline_w']:.0f} W to {e['peak_w']:.0f} W for {secs} s."


def device_context(conn, device_id):
    """Name/kind/room/rated_w from the `devices` table, when set and informative.
    Returns None if the table doesn't exist (bare hub DB) or nothing is set.
    """
    try:
        row = conn.execute(
            "SELECT name, kind, room, rated_w FROM devices WHERE device_id = ?", (device_id,)
        ).fetchone()
    except Exception:
        return None
    if row is None:
        return None
    out = {}
    if row["name"] and row["name"] != device_id:
        out["device_name"] = row["name"]
    if row["kind"] and row["kind"] != "unknown":
        out["device_kind"] = row["kind"]
    if row["room"]:
        out["room"] = row["room"]
    if row["rated_w"]:
        out["rated_w"] = round(row["rated_w"])
    return out or None


def facts(conn, e, now_ms):
    start = datetime.fromtimestamp(e["start_ts"] / 1000)
    midnight = int(start.replace(hour=0, minute=0, second=0, microsecond=0).timestamp() * 1000)
    similar = conn.execute(
        "SELECT COUNT(*) FROM events WHERE device_id = ? AND method = ? AND id != ?"
        " AND start_ts >= ? AND start_ts < ? AND peak_w BETWEEN ? AND ?",
        (e["device_id"], e["method"], e["id"], midnight, e["start_ts"],
         e["peak_w"] * 0.75, e["peak_w"] * 1.25),
    ).fetchone()[0]
    out = {"device": e["device_id"]}
    ctx = device_context(conn, e["device_id"])
    if ctx:
        out.update(ctx)
    out["baseline_w"] = round(e["baseline_w"])
    out["peak_w"] = round(e["peak_w"])
    out["local_time"] = start.strftime("%H:%M")
    out["similar_events_today"] = similar
    if now_ms - e["end_ts"] < SETTLE_MS:
        out["running_for_s"] = max(1, round((now_ms - e["start_ts"]) / 1000))
        out["still_running"] = True
    else:
        out["duration_s"] = max(1, round((e["end_ts"] - e["start_ts"]) / 1000) + 1)
    return out


def tidy(text):
    """Drop the preamble and 'Sentence 1:' labels small models add anyway."""
    text = " ".join(text.split())
    text = re.sub(r"^(here (are|is)[^:]*:)\s*", "", text, flags=re.I)
    text = re.sub(r"\bsentence [12]\s*:\s*", "", text, flags=re.I)
    return text.strip().strip('"')


def build_messages_v1(payload):
    return [
        {"role": "system", "content": SYSTEM_V1},
        {"role": "user", "content": json.dumps(payload)},
    ]


def build_messages_v2(payload):
    messages = [{"role": "system", "content": SYSTEM_V2}]
    for p, a in FEWSHOT:
        messages.append({"role": "user", "content": json.dumps(p)})
        messages.append({"role": "assistant", "content": json.dumps(a)})
    messages.append({"role": "user", "content": json.dumps(payload)})
    return messages


_NUM_RE = re.compile(r"-?\d+(?:\.\d+)?")


def _allowed_numbers(payload):
    allowed = set()
    for key, value in payload.items():
        if isinstance(value, bool):
            continue
        if isinstance(value, (int, float)):
            allowed.add(round(value))
        elif key == "local_time" and isinstance(value, str) and ":" in value:
            h, m = value.split(":")[:2]
            allowed.add(int(h))
            allowed.add(int(m))
    return allowed


def faithful(summary, payload):
    """Every number in summary must be one already in the input, +/-1 for rounding."""
    allowed = _allowed_numbers(payload)
    for n in (float(x) for x in _NUM_RE.findall(summary)):
        if not any(abs(n - a) <= 1 for a in allowed):
            return False
    return True


def valid_summary(summary, payload):
    if not summary or not summary.strip():
        return False
    sentences = [s for s in re.split(r"(?<=[.!?])\s+", summary.strip()) if s]
    if len(sentences) > 2:
        return False
    return faithful(summary, payload)


def parse_structured(text):
    data = json.loads(text)
    required = {"appliance", "confidence", "verdict", "summary"}
    if not required.issubset(data):
        raise ValueError(f"missing field(s): {required - set(data)}")
    if data["confidence"] not in ("low", "medium", "high"):
        raise ValueError(f"bad confidence: {data['confidence']}")
    if data["verdict"] not in ("normal", "check"):
        raise ValueError(f"bad verdict: {data['verdict']}")
    data["summary"] = tidy(str(data["summary"]))
    return data


def fallback_data(e, payload):
    severity = payload.get("peak_w", e["peak_w"]) - payload.get("baseline_w", e["baseline_w"])
    return {
        "appliance": "unknown",
        "confidence": "low",
        "verdict": "check" if severity > 500 else "normal",
        "summary": template(e),
    }


def explain_event(conn, e, now_ms, model=None):
    """Ask Llama for a structured explanation, validate, retry once, else fall back.
    Writes the `explanations` row and `events.explanation`. Returns the dict written
    (appliance/confidence/verdict/summary) plus model/latency_ms/fallback.
    """
    payload = facts(conn, e, now_ms)
    data, latency_ms, fallback = None, 0, 0
    used_model = model or llm.MODEL

    for attempt in range(2):  # first try default temp, retry at temperature 0
        try:
            messages = build_messages_v2(payload)
            options = {"temperature": 0} if attempt == 1 else None
            text, latency_ms = llm.chat(
                messages, model=model, format=RESPONSE_SCHEMA, timeout=TIMEOUT_S, options=options
            )
            candidate = parse_structured(text)
            if not valid_summary(candidate["summary"], payload):
                raise ValueError(f"rejected summary (invented number or >2 sentences): {candidate['summary']!r}")
            data = candidate
            break
        except Exception as err:
            print(f"event {e['id']}: llama attempt {attempt + 1} failed ({err})")

    if data is None:
        data = fallback_data(e, payload)
        fallback = 1
        latency_ms = 0

    write_explanation(conn, e["id"], data, used_model, latency_ms, fallback)
    return data


def write_explanation(conn, event_id, data, model, latency_ms, fallback):
    now = int(time.time() * 1000)
    conn.execute(
        "INSERT INTO explanations (event_id, appliance, confidence, verdict, summary, model,"
        " prompt_version, latency_ms, fallback, created_ts) VALUES (?,?,?,?,?,?,?,?,?,?)"
        " ON CONFLICT(event_id) DO UPDATE SET appliance=excluded.appliance,"
        " confidence=excluded.confidence, verdict=excluded.verdict, summary=excluded.summary,"
        " model=excluded.model, prompt_version=excluded.prompt_version,"
        " latency_ms=excluded.latency_ms, fallback=excluded.fallback, created_ts=excluded.created_ts",
        (event_id, data["appliance"], data["confidence"], data["verdict"], data["summary"],
         model, PROMPT_VERSION, latency_ms, fallback, now),
    )
    conn.execute("UPDATE events SET explanation = ? WHERE id = ?", (data["summary"], event_id))
    conn.commit()


def main():
    conn = connect()
    hb = Heartbeat(conn, "explain")
    print(f"explaining with {llm.MODEL} at {llm.OLLAMA_URL} (prompt {PROMPT_VERSION}); loading model")
    try:
        llm.chat(
            [{"role": "user", "content": "warm up"}], timeout=180,
        )
        print("model loaded")
    except Exception as err:
        print(f"model warm-up failed ({err}); events will get template lines until Ollama answers")
    hb.tick({"model": llm.MODEL}, force=True)
    while True:
        hb.tick({"model": llm.MODEL})
        now = int(time.time() * 1000)
        e = conn.execute(
            "SELECT * FROM events WHERE explanation IS NULL AND (end_ts < ? OR start_ts < ?)"
            " ORDER BY id LIMIT 1",
            (now - SETTLE_MS, now - EARLY_MS),
        ).fetchone()
        if not e:
            time.sleep(1)
            continue
        data = explain_event(conn, e, now)
        print(f"event {e['id']}: [{data['appliance']}/{data['confidence']}/{data['verdict']}] {data['summary']}")


if __name__ == "__main__":
    main()
