"""Ask WattWatch: a chat assistant grounded only in this home's own data.

`build_context` assembles a compact JSON snapshot (devices, nodes, incidents,
alerts, energy totals, settings, model status) from the same tables the
console API reads. `answer_stream` sends that snapshot plus the question to
Llama and streams the reply token by token, so `POST /api/assistant` can
relay it over SSE without buffering the whole answer first.
"""

import json
import time
from typing import Iterator

import store
import llm

SITE_DEFAULT = "Home"
CO2_DEFAULT = 0.39
NODE_ONLINE_MS = 30_000


def _round_w(x):
    """Watts, and amps -- whole numbers. None stays None (missing, not zero)."""
    return None if x is None else round(x)


def _round_kwh(x):
    """kWh, cost and kg CO2 -- 2 decimals, so the LLM is quoting '1.07', not a
    13-digit-adjacent float like 1.0735004764565215 that it tends to mangle or
    truncate into a nonsense number when it writes prose around it.
    """
    return None if x is None else round(x, 2)


def _local_time(ts_ms):
    """HH:MM local, never a raw epoch number -- the model has no use for epoch ms
    and tends to quote it verbatim as if it were a sensible number in prose.
    """
    return None if ts_ms is None else time.strftime("%H:%M", time.localtime(ts_ms / 1000))


def _local_dt(ts_ms):
    return None if ts_ms is None else time.strftime("%Y-%m-%d %H:%M", time.localtime(ts_ms / 1000))

SYSTEM_PROMPT = (
    "You are WattWatch's assistant, answering questions about one home's power usage. "
    "Answer only from the JSON context you are given below; never use outside knowledge or "
    "assumptions about the house. Quote numbers exactly as given in the context -- do not "
    "recompute, round differently, or invent one. If the context doesn't have what's needed "
    "to answer, say plainly what's missing. Keep the answer to 120 words or fewer, plain text, "
    "no markdown, no headers."
)


def _settings(conn):
    s = store.get_settings(conn)
    s.setdefault("site_name", SITE_DEFAULT)
    s.setdefault("co2_kg_per_kwh", CO2_DEFAULT)
    return s


def _month_start_ms(now_ms):
    t = time.localtime(now_ms / 1000)
    first = time.struct_time((t.tm_year, t.tm_mon, 1, 0, 0, 0, 0, 0, t.tm_isdst))
    return int(time.mktime(first) * 1000)


def _model_status():
    import detect_iforest

    try:
        if detect_iforest.MODEL_PATH.exists():
            import joblib

            bundle = joblib.load(detect_iforest.MODEL_PATH)
            # bundle["trained_at"] is unix seconds (detect_iforest/tune_iforest write it that
            # way); format for the LLM here rather than hand it a raw epoch number.
            trained_at = bundle.get("trained_at")
            return {
                "trained": True,
                "trained_at": time.strftime("%Y-%m-%d %H:%M", time.localtime(trained_at)) if trained_at else None,
                "feature_set": bundle.get("feature_set"),
                "threshold": round(bundle["threshold"], 3) if bundle.get("threshold") is not None else None,
            }
    except Exception:
        pass
    return {"trained": False, "trained_at": None, "feature_set": None, "threshold": None}


def _nodes(conn, now_ms):
    try:
        rows = conn.execute("SELECT * FROM node_status ORDER BY node_id, port").fetchall()
    except Exception:
        return []
    nodes = {}
    for r in rows:
        n = nodes.setdefault(r["node_id"], {
            "node_id": r["node_id"], "fw": r["fw"], "boots": r["boots"], "online": False, "ports": [],
        })
        online = r["last_ts"] is not None and now_ms - r["last_ts"] <= NODE_ONLINE_MS
        n["online"] = n["online"] or online
        n["ports"].append({
            "port": r["port"], "device_id": r["device_id"], "online": online,
            "irms_raw_a": None if r["irms_raw_a"] is None else round(r["irms_raw_a"], 2),
            "over_limit": bool(r["over_limit"]),
        })
    return list(nodes.values())


def _devices(conn, now_ms, price):
    out = []
    for d in store.device_rows(conn, now_ms):
        detail = store.device_detail(conn, d["device_id"], now_ms) or {}
        stats = detail.get("stats", {})
        week_ago = now_ms - 7 * 86_400_000
        kwh_7d = store.kwh(conn, d["device_id"], week_ago, now_ms)
        out.append({
            "device_id": d["device_id"], "name": d["name"], "kind": d["kind"],
            "online": d["online"], "watts": _round_w(d["watts"]),
            "kwh_today": _round_kwh(d["kwh_today"]), "cost_today": _round_kwh(d["kwh_today"] * price),
            "kwh_7d": _round_kwh(kwh_7d), "cost_7d": _round_kwh(kwh_7d * price),
            "peak_w_24h": _round_w(stats.get("peak_w_24h")), "baseline_w": _round_w(stats.get("baseline_w")),
        })
    return out


def build_context(conn, now_ms: int) -> dict:
    """Compact JSON snapshot the assistant and digest are grounded in. Every
    number here must be safe to quote verbatim in an answer.
    """
    settings = _settings(conn)
    price = settings.get("price_per_kwh", 0.15)
    currency = settings.get("currency", "$")
    co2 = settings["co2_kg_per_kwh"]

    day_start = store.day_start_ms(now_ms)
    yesterday_start = day_start - 86_400_000
    month_start = _month_start_ms(now_ms)

    kwh_today = store.kwh(conn, None, day_start, now_ms)
    kwh_yesterday = store.kwh(conn, None, yesterday_start, day_start)
    # Yesterday from 00:00 to the same clock time as now -- lets a caller compare today's
    # partial total against an equally partial yesterday, instead of against the whole day.
    time_of_day_ms = now_ms - day_start
    kwh_yesterday_same_time = store.kwh(conn, None, yesterday_start, yesterday_start + time_of_day_ms)
    kwh_mtd = store.kwh(conn, None, month_start, now_ms)

    hourly = []
    rows = conn.execute(
        "SELECT CAST((ts - ?) / 3600000 AS INTEGER) AS hr, SUM(watts) AS w"
        " FROM readings WHERE ts >= ? GROUP BY hr ORDER BY hr",
        (day_start, day_start),
    ).fetchall()
    for r in rows:
        if r["hr"] is None:
            continue
        hourly.append({"hour": int(r["hr"]), "kwh": _round_kwh((r["w"] or 0.0) / 3_600_000)})

    incidents = store.incidents(conn, None, None, 10)
    open_alerts = conn.execute(
        "SELECT id, device_id, kind, severity, title, status, opened_ts FROM alerts"
        " WHERE status IN ('open', 'acknowledged') ORDER BY opened_ts DESC LIMIT 20"
    ).fetchall()

    return {
        # Local "HH:MM" / ISO date, never epoch ms -- the model has no use for a raw
        # timestamp and tends to quote it verbatim as if it were a sensible number.
        "now_local": _local_time(now_ms),
        "today": _local_dt(day_start)[:10],
        "site_name": settings["site_name"],
        "currency": currency,
        "price_per_kwh": round(price, 4),
        "co2_kg_per_kwh": round(co2, 3),
        "devices": _devices(conn, now_ms, price),
        "nodes": _nodes(conn, now_ms),
        "incidents": [
            {
                "id": i["id"], "device_id": i["device_id"], "device_name": i["device_name"],
                "local_time": _local_time(i["start_ts"]), "duration_s": i["duration_s"],
                "peak_w": _round_w(i["peak_w"]), "baseline_w": _round_w(i["baseline_w"]),
                "methods": i["methods"], "explanation": i["explanation"],
            }
            for i in incidents
        ],
        "open_alerts": [
            {
                "id": r["id"], "device_id": r["device_id"], "kind": r["kind"],
                "severity": r["severity"], "title": r["title"], "status": r["status"],
                "opened_local": _local_time(r["opened_ts"]),
            }
            for r in open_alerts
        ],
        "hourly_kwh_today": hourly,
        "kwh_today": _round_kwh(kwh_today),
        "kwh_yesterday": _round_kwh(kwh_yesterday),
        "kwh_yesterday_same_time": _round_kwh(kwh_yesterday_same_time),
        "kwh_mtd": _round_kwh(kwh_mtd),
        "cost_today": _round_kwh(kwh_today * price),
        "cost_mtd": _round_kwh(kwh_mtd * price),
        "co2_kg_today": _round_kwh(kwh_today * co2),
        "co2_kg_mtd": _round_kwh(kwh_mtd * co2),
        "model": _model_status(),
    }


def answer_stream(conn, question: str, history: list[dict], now_ms: int) -> Iterator[tuple[str, dict]]:
    """Yields ('token', {'t': str}) per chunk, then exactly one
    ('done', {latency_ms, model, context_keys}) or ('error', {message}).
    """
    context = build_context(conn, now_ms)
    messages = [{"role": "system", "content": SYSTEM_PROMPT + "\n\nContext:\n" + json.dumps(context)}]
    for h in history or []:
        role, content = h.get("role"), h.get("content")
        if role in ("user", "assistant") and content:
            messages.append({"role": role, "content": content})
    messages.append({"role": "user", "content": question})

    t0 = time.monotonic()
    try:
        for piece in llm.chat_stream(messages):
            yield "token", {"t": piece}
        latency_ms = int((time.monotonic() - t0) * 1000)
        yield "done", {"latency_ms": latency_ms, "model": llm.MODEL, "context_keys": sorted(context.keys())}
    except Exception as err:
        yield "error", {"message": str(err)}
