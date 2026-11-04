"""Read-mostly JSON API for the WattWatch console, plus the few actions a
browser can safely do (ack/resolve alerts, edit device metadata, rules,
settings, topology layout). Serves the built web console from ../web/dist.

    python api.py --port 8080
"""

import asyncio
import csv
import io
import json
import mimetypes
import os
import queue
import sys
import threading
import time
from pathlib import Path

import requests

# Windows' mimetypes registry resolves ".js" to "text/plain" on some
# machines (no browser-correct entry in HKEY_CLASSES_ROOT), which makes
# Chromium refuse the built site's `<script type="module">` with a strict
# MIME-type error. Force the correct types before StaticFiles ever guesses
# at a response, instead of relying on the OS registry.
mimetypes.add_type("text/javascript", ".js")
mimetypes.add_type("text/javascript", ".mjs")
mimetypes.add_type("font/woff2", ".woff2")
mimetypes.add_type("font/woff", ".woff")
from fastapi import Body, FastAPI, HTTPException, Response
from fastapi.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

import db
import store
from heartbeat import Heartbeat

# 127.0.0.1, not localhost: see explain.py for why (Windows IPv6-first lookup).
OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://127.0.0.1:11434")
OLLAMA_MODEL = os.environ.get("OLLAMA_MODEL", "llama3.2:3b")
PROBE_TTL_S = 10  # cache the Ollama reachability probe so /api/health polling doesn't hammer it

RULE_KINDS = {"spike", "anomaly", "over_power", "offline", "daily_energy", "always_on", "hardware_limit"}
SEVERITIES = {"info", "warning", "critical"}
ALL_SERVICES = ["ingest", "detect", "explain", "alerts", "api", "digest"]


def now_ms():
    return int(time.time() * 1000)


class _ModelInfo:
    """Isolation Forest status for /api/health, reloaded only when the file changes.

    Uses the same path the detector loads (ENERGY_MODEL, else hub/model.joblib).
    Read-only: the file is only ever loaded, never written, here.
    """

    def __init__(self):
        self.mtime = None
        self.info = {"trained": False, "trained_at": None, "threshold": None}

    def get(self):
        from detect_iforest import MODEL_PATH

        try:
            mtime = MODEL_PATH.stat().st_mtime
        except OSError:
            self.mtime = None
            self.info = {"trained": False, "trained_at": None, "threshold": None}
            return self.info
        if mtime != self.mtime:
            try:
                import joblib

                bundle = joblib.load(MODEL_PATH)
                self.info = {"trained": True, "trained_at": bundle.get("trained_at"),
                             "threshold": bundle.get("threshold")}
                self.mtime = mtime
            except Exception:  # mid-write by `detect_iforest.py train`; retry next poll
                pass
        return self.info


model_info = _ModelInfo()


class _OllamaProbe:
    def __init__(self):
        self.ts = 0.0
        self.reachable = False

    def check(self):
        if time.time() - self.ts < PROBE_TTL_S:
            return self.reachable
        try:
            requests.get(f"{OLLAMA_URL}/api/tags", timeout=1)
            self.reachable = True
        except Exception:
            self.reachable = False
        self.ts = time.time()
        return self.reachable


def _alert_row(r, detectors, ai=None):
    return {
        "id": r["id"], "rule_id": r["rule_id"], "device_id": r["device_id"],
        "device_name": r["device_name"] or r["device_id"], "kind": r["kind"],
        "severity": r["severity"], "title": r["title"], "detail": r["detail"],
        "event_id": r["event_id"], "value": r["value"], "status": r["status"],
        "opened_ts": r["opened_ts"], "updated_ts": r["updated_ts"],
        "acked_ts": r["acked_ts"], "resolved_ts": r["resolved_ts"],
        "detectors": detectors, "ai": ai,
    }


def _audit(conn, action, target=None, detail=None):
    conn.execute(
        "INSERT INTO audit_log (ts, actor, action, target, detail) VALUES (?, 'local admin', ?, ?, ?)",
        (now_ms(), action, target, detail),
    )
    conn.commit()


def _rule_row(r):
    return {
        "id": r["id"], "name": r["name"], "kind": r["kind"], "device_id": r["device_id"],
        "threshold": r["threshold"], "duration_s": r["duration_s"], "severity": r["severity"],
        "enabled": bool(r["enabled"]),
    }


def _peak_w(conn, device_id, since_ms, until_ms):
    q = "SELECT MAX(watts) FROM readings WHERE ts >= ? AND ts < ?"
    args = [since_ms, until_ms]
    if device_id:
        q += " AND device_id = ?"
        args.append(device_id)
    row = conn.execute(q, args).fetchone()
    return row[0] or 0.0


def _build_topology(conn, now_ms):
    settings = store.get_settings(conn)
    devices = store.device_rows(conn, now_ms)
    overrides = {r["node_id"]: r for r in conn.execute("SELECT * FROM topology").fetchall()}

    nodes = {}

    def node(node_id, kind, label, parent):
        if node_id not in nodes:
            o = overrides.get(node_id)
            nodes[node_id] = {
                "id": node_id, "kind": kind,
                "label": (o["label"] if o and o["label"] else label),
                "parent": parent, "status": "offline", "watts": None, "device_id": None,
                "x": o["x"] if o else None, "y": o["y"] if o else None,
            }
        return nodes[node_id]

    node("hub", "hub", "Hub PC", None)
    for d in devices:
        if "/" in d["device_id"]:
            prefix, port = d["device_id"].split("/", 1)
            node_id, port_id = f"node:{prefix}", f"port:{d['device_id']}"
            node(node_id, "node", prefix, "hub")
            node(port_id, "port", port, node_id)
            appliance_parent = port_id
        else:
            node_id = f"node:{d['device_id']}"
            node(node_id, "node", d["device_id"], "hub")
            appliance_parent = node_id
        appliance = node(f"dev:{d['device_id']}", "appliance", d["name"], appliance_parent)
        appliance["device_id"] = d["device_id"]
        appliance["watts"] = d["watts"]
        appliance["status"] = "online" if d["online"] else "offline"

    # Bottom-up status: port <- appliance, node <- port/appliance, hub <- node.
    for kind in ("port", "node"):
        for n in nodes.values():
            if n["kind"] != kind:
                continue
            children = [c for c in nodes.values() if c["parent"] == n["id"]]
            n["status"] = "online" if any(c["status"] == "online" for c in children) else "offline"
    hub_children = [c for c in nodes.values() if c["parent"] == "hub"]
    nodes["hub"]["status"] = "online" if any(c["status"] == "online" for c in hub_children) else "offline"

    return list(nodes.values())


class _ThreadConn:
    """One SQLite connection per worker thread, behind a connection-like facade.

    FastAPI runs sync routes on a thread pool; a single shared connection lets
    one request's cursor clobber another's mid-query (sporadic 500s).
    """

    def __init__(self, path):
        self.path = path
        self.local = threading.local()

    def __getattr__(self, name):
        c = getattr(self.local, "conn", None)
        if c is None:
            c = self.local.conn = db.connect(self.path)
        return getattr(c, name)


def create_app(db_path):
    store.init(db.connect(db_path))
    conn = _ThreadConn(db_path)
    lock = threading.Lock()
    probe = _OllamaProbe()

    _api_hb = Heartbeat(db.connect(db_path), "api")
    _api_hb.tick(force=True)  # report "running" immediately, don't wait for the first loop tick

    def _heartbeat_loop():
        while True:
            time.sleep(5)
            _api_hb.tick(force=True)

    threading.Thread(target=_heartbeat_loop, daemon=True).start()

    app = FastAPI(title="WattWatch API")
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    # ---------------------------------------------------------------- health

    @app.get("/api/health")
    def health():
        row = conn.execute("SELECT COUNT(*) AS n, MAX(ts) AS t FROM readings").fetchone()
        iforest = model_info.get()
        return {
            "ok": True, "now_ms": now_ms(), "readings": row["n"], "last_reading_ts": row["t"],
            "iforest": iforest,
            "llm": {"model": OLLAMA_MODEL, "reachable": probe.check()},
        }

    # -------------------------------------------------------------- overview

    @app.get("/api/overview")
    def overview():
        with lock:
            store.sync_devices(conn)
        ts = now_ms()
        settings = store.get_settings(conn)
        day_start = store.day_start_ms(ts)
        rows = store.device_rows(conn, ts)
        total_w = sum(r["watts"] or 0.0 for r in rows if r["online"])
        kwh_today = store.kwh(conn, None, day_start, ts)
        events_today = conn.execute(
            "SELECT COUNT(*) FROM events WHERE start_ts >= ?", (day_start,)
        ).fetchone()[0]
        open_alerts = conn.execute(
            "SELECT COUNT(*) FROM alerts WHERE status IN ('open','acknowledged')"
        ).fetchone()[0]
        critical_alerts = conn.execute(
            "SELECT COUNT(*) FROM alerts WHERE status IN ('open','acknowledged') AND severity='critical'"
        ).fetchone()[0]
        return {
            "now_ms": ts, "total_w": total_w,
            "devices_online": sum(1 for r in rows if r["online"]), "devices_total": len(rows),
            "kwh_today": kwh_today, "cost_today": kwh_today * settings["price_per_kwh"],
            "currency": settings["currency"], "events_today": events_today,
            "open_alerts": open_alerts, "critical_alerts": critical_alerts,
        }

    # --------------------------------------------------------------- devices

    @app.get("/api/devices")
    def list_devices():
        with lock:
            store.sync_devices(conn)
        return store.device_rows(conn, now_ms())

    @app.get("/api/devices/{device_id:path}")
    def get_device(device_id: str):
        with lock:
            store.sync_devices(conn)
        row = store.device_detail(conn, device_id, now_ms())
        if row is None:
            raise HTTPException(404, "device not found")
        return row

    @app.patch("/api/devices/{device_id:path}")
    def patch_device(device_id: str, patch: dict = Body(...)):
        with lock:
            try:
                row = store.update_device(conn, device_id, patch)
            except ValueError as e:
                raise HTTPException(422, str(e))
            if row is not None:
                _audit(conn, "patch_device", device_id, json.dumps(patch))
        if row is None:
            raise HTTPException(404, "device not found")
        return row

    # -------------------------------------------------------------- readings

    @app.get("/api/readings")
    def readings(device_id: str, since_ms: int = None, until_ms: int = None, max_points: int = 600):
        ts = now_ms()
        until = until_ms if until_ms is not None else ts
        since = since_ms if since_ms is not None else until - 600_000
        bucket = max(1000, -(-(until - since) // max_points))
        # Bucket relative to `since`, not absolute epoch: an absolute `(ts/bucket)*bucket`
        # can split the window's first/last slivers into one extra group when `since` does
        # not fall on a bucket boundary, breaking the <= max_points guarantee.
        rows = conn.execute(
            "SELECT ((ts - ?) / ?) * ? AS b, AVG(watts), MAX(watts) FROM readings"
            " WHERE device_id = ? AND ts >= ? AND ts < ? GROUP BY b ORDER BY b",
            (since, bucket, bucket, device_id, since, until),
        ).fetchall()
        points = [{"ts": r[0] + since, "avg_w": r[1], "max_w": r[2]} for r in rows]
        last_row = conn.execute(
            "SELECT MAX(ts) AS t FROM readings WHERE device_id = ?", (device_id,)
        ).fetchone()
        last_ts = last_row["t"] if last_row else None
        return {"device_id": device_id, "bucket_ms": bucket, "points": points, "last_ts": last_ts}

    @app.get("/api/energy/daily")
    def energy_daily(device_id: str = None, days: int = 7):
        ts = now_ms()
        settings = store.get_settings(conn)
        today_start = store.day_start_ms(ts)
        out = []
        for i in range(days - 1, -1, -1):
            day_start = today_start - i * 86_400_000
            day_end = day_start + 86_400_000
            day_kwh = store.kwh(conn, device_id, day_start, day_end)
            out.append({
                "day": time.strftime("%Y-%m-%d", time.localtime(day_start / 1000)),
                "kwh": day_kwh, "cost": day_kwh * settings["price_per_kwh"],
                "peak_w": _peak_w(conn, device_id, day_start, day_end),
            })
        return out

    @app.get("/api/events")
    def list_events(device_id: str = None, method: str = None, since_ms: int = None, limit: int = 50):
        q, args = "SELECT * FROM events WHERE 1=1", []
        if device_id:
            q += " AND device_id = ?"
            args.append(device_id)
        if method:
            q += " AND method = ?"
            args.append(method)
        if since_ms:
            q += " AND start_ts >= ?"
            args.append(since_ms)
        q += " ORDER BY start_ts DESC LIMIT ?"
        args.append(limit)
        rows = conn.execute(q, args).fetchall()
        return [
            {
                "id": r["id"], "device_id": r["device_id"], "start_ts": r["start_ts"],
                "end_ts": r["end_ts"],
                "duration_s": max(1, round((r["end_ts"] - r["start_ts"]) / 1000) + 1),
                "peak_w": r["peak_w"], "baseline_w": r["baseline_w"], "score": r["score"],
                "method": r["method"], "explanation": r["explanation"],
                "ai": store.explanation_row(conn, r["id"]),
            }
            for r in rows
        ]

    @app.get("/api/incidents")
    def list_incidents(device_id: str = None, since_ms: int = None, limit: int = 50):
        return store.incidents(conn, device_id, since_ms, limit)

    @app.get("/api/explanations/{event_id}")
    def get_explanation(event_id: int):
        row = store.explanation_row(conn, event_id)
        if row is None:
            raise HTTPException(404, "no explanation for this event")
        return row

    # --------------------------------------------------------------- alerts

    @app.get("/api/alerts")
    def list_alerts(status: str = None, severity: str = None, device_id: str = None, limit: int = 100):
        q = ("SELECT alerts.*, devices.name AS device_name FROM alerts"
             " LEFT JOIN devices ON devices.device_id = alerts.device_id WHERE 1=1")
        args = []
        if status:
            if status == "active":
                q += " AND alerts.status IN ('open','acknowledged')"
            else:
                q += " AND alerts.status = ?"
                args.append(status)
        if severity:
            q += " AND alerts.severity = ?"
            args.append(severity)
        if device_id:
            q += " AND alerts.device_id = ?"
            args.append(device_id)
        q += " ORDER BY alerts.opened_ts DESC LIMIT ?"
        args.append(limit)
        rows = conn.execute(q, args).fetchall()
        return [_alert_row(r, store.alert_detectors(conn, r["event_id"]), store.explanation_row(conn, r["event_id"])) for r in rows]

    @app.get("/api/alerts/summary")
    def alerts_summary():
        ts = now_ms()
        open_n = conn.execute("SELECT COUNT(*) FROM alerts WHERE status='open'").fetchone()[0]
        acked = conn.execute("SELECT COUNT(*) FROM alerts WHERE status='acknowledged'").fetchone()[0]
        resolved_24h = conn.execute(
            "SELECT COUNT(*) FROM alerts WHERE status='resolved' AND resolved_ts >= ?", (ts - 86_400_000,)
        ).fetchone()[0]
        by_severity = {
            sev: conn.execute(
                "SELECT COUNT(*) FROM alerts WHERE status IN ('open','acknowledged') AND severity = ?",
                (sev,),
            ).fetchone()[0]
            for sev in SEVERITIES
        }
        return {"open": open_n, "acknowledged": acked, "resolved_24h": resolved_24h, "by_severity": by_severity}

    def _fetch_alert(id):
        return conn.execute(
            "SELECT alerts.*, devices.name AS device_name FROM alerts"
            " LEFT JOIN devices ON devices.device_id = alerts.device_id WHERE alerts.id = ?",
            (id,),
        ).fetchone()

    @app.post("/api/alerts/{id}/ack")
    def ack_alert(id: int):
        with lock:
            row = _fetch_alert(id)
            if row is None:
                raise HTTPException(404, "alert not found")
            if row["status"] != "open":
                raise HTTPException(409, "alert is not open")
            ts = now_ms()
            conn.execute(
                "UPDATE alerts SET status='acknowledged', acked_ts=?, updated_ts=? WHERE id=?", (ts, ts, id)
            )
            conn.commit()
            row = _fetch_alert(id)
            _audit(conn, "ack_alert", str(id))
        return _alert_row(row, store.alert_detectors(conn, row["event_id"]), store.explanation_row(conn, row["event_id"]))

    @app.post("/api/alerts/{id}/resolve")
    def resolve_alert(id: int):
        with lock:
            row = _fetch_alert(id)
            if row is None:
                raise HTTPException(404, "alert not found")
            if row["status"] not in ("open", "acknowledged"):
                raise HTTPException(409, "alert is not open or acknowledged")
            ts = now_ms()
            conn.execute(
                "UPDATE alerts SET status='resolved', resolved_ts=?, updated_ts=? WHERE id=?", (ts, ts, id)
            )
            conn.commit()
            row = _fetch_alert(id)
            _audit(conn, "resolve_alert", str(id))
        return _alert_row(row, store.alert_detectors(conn, row["event_id"]), store.explanation_row(conn, row["event_id"]))

    # ---------------------------------------------------------------- rules

    @app.get("/api/rules")
    def list_rules():
        rows = conn.execute("SELECT * FROM alert_rules ORDER BY id").fetchall()
        return [_rule_row(r) for r in rows]

    @app.post("/api/rules", status_code=201)
    def create_rule(body: dict = Body(...)):
        required = {"name", "kind", "duration_s", "severity", "enabled"}
        missing = required - set(body)
        if missing:
            raise HTTPException(422, f"missing field(s): {', '.join(sorted(missing))}")
        if body["kind"] not in RULE_KINDS:
            raise HTTPException(422, f"invalid kind: {body['kind']}")
        if body["severity"] not in SEVERITIES:
            raise HTTPException(422, f"invalid severity: {body['severity']}")
        with lock:
            cur = conn.execute(
                "INSERT INTO alert_rules (name, kind, device_id, threshold, duration_s, severity, enabled)"
                " VALUES (?, ?, ?, ?, ?, ?, ?)",
                (body["name"], body["kind"], body.get("device_id"), body.get("threshold"),
                 body["duration_s"], body["severity"], int(bool(body["enabled"]))),
            )
            conn.commit()
            row = conn.execute("SELECT * FROM alert_rules WHERE id = ?", (cur.lastrowid,)).fetchone()
            _audit(conn, "create_rule", str(cur.lastrowid))
        return _rule_row(row)

    @app.patch("/api/rules/{id}")
    def patch_rule(id: int, patch: dict = Body(...)):
        allowed = {"name", "kind", "device_id", "threshold", "duration_s", "severity", "enabled"}
        unknown = set(patch) - allowed
        if unknown:
            raise HTTPException(422, f"unknown field(s): {', '.join(sorted(unknown))}")
        if "kind" in patch and patch["kind"] not in RULE_KINDS:
            raise HTTPException(422, f"invalid kind: {patch['kind']}")
        if "severity" in patch and patch["severity"] not in SEVERITIES:
            raise HTTPException(422, f"invalid severity: {patch['severity']}")
        with lock:
            exists = conn.execute("SELECT 1 FROM alert_rules WHERE id = ?", (id,)).fetchone()
            if not exists:
                raise HTTPException(404, "rule not found")
            for key, value in patch.items():
                if key == "enabled":
                    value = int(bool(value))
                conn.execute(f"UPDATE alert_rules SET {key} = ? WHERE id = ?", (value, id))
            conn.commit()
            row = conn.execute("SELECT * FROM alert_rules WHERE id = ?", (id,)).fetchone()
            _audit(conn, "patch_rule", str(id), json.dumps(patch))
        return _rule_row(row)

    @app.delete("/api/rules/{id}", status_code=204)
    def delete_rule(id: int):
        with lock:
            exists = conn.execute("SELECT 1 FROM alert_rules WHERE id = ?", (id,)).fetchone()
            if not exists:
                raise HTTPException(404, "rule not found")
            conn.execute("DELETE FROM alert_rules WHERE id = ?", (id,))
            conn.commit()
            _audit(conn, "delete_rule", str(id))

    # ------------------------------------------------------------- topology

    @app.get("/api/topology")
    def topology():
        with lock:
            store.sync_devices(conn)
        return {"nodes": _build_topology(conn, now_ms())}

    @app.patch("/api/topology/{node_id:path}")
    def patch_topology(node_id: str, body: dict = Body(...)):
        allowed = {"label", "x", "y"}
        unknown = set(body) - allowed
        if unknown:
            raise HTTPException(422, f"unknown field(s): {', '.join(sorted(unknown))}")
        with lock:
            existing = conn.execute("SELECT * FROM topology WHERE node_id = ?", (node_id,)).fetchone()
            label = body.get("label", existing["label"] if existing else None)
            x = body.get("x", existing["x"] if existing else None)
            y = body.get("y", existing["y"] if existing else None)
            conn.execute(
                "INSERT INTO topology (node_id, label, x, y) VALUES (?, ?, ?, ?)"
                " ON CONFLICT(node_id) DO UPDATE SET label=excluded.label, x=excluded.x, y=excluded.y",
                (node_id, label, x, y),
            )
            conn.commit()
            _audit(conn, "patch_topology", node_id, json.dumps(body))
            store.sync_devices(conn)
            nodes = _build_topology(conn, now_ms())
        node = next((n for n in nodes if n["id"] == node_id), None)
        if node is None:
            raise HTTPException(404, "node not found")
        return node

    # -------------------------------------------------------------- settings

    @app.get("/api/settings")
    def get_settings_route():
        return store.get_settings(conn)

    @app.patch("/api/settings")
    def patch_settings_route(patch: dict = Body(...)):
        with lock:
            try:
                result = store.update_settings(conn, patch)
            except ValueError as e:
                raise HTTPException(422, str(e))
            _audit(conn, "patch_settings", None, json.dumps(patch))
        return result

    # ------------------------------------------------------------------ nodes

    @app.get("/api/nodes")
    def list_nodes():
        with lock:
            store.sync_devices(conn)
        return store.node_rows(conn, now_ms())

    @app.get("/api/nodes/{node_id:path}")
    def get_node(node_id: str):
        with lock:
            store.sync_devices(conn)
        row = store.node_detail(conn, node_id, now_ms())
        if row is None:
            raise HTTPException(404, "node not found")
        return row

    # ----------------------------------------------------------------system

    @app.get("/api/system")
    def system():
        ts = now_ms()
        rows = {r["service"]: r for r in conn.execute("SELECT * FROM service_status").fetchall()}
        services = []
        for name in ALL_SERVICES:
            r = rows.get(name)
            if r is None:
                services.append({
                    "service": name, "pid": None, "status": "down",
                    "heartbeat_age_s": None, "started_ts": None, "info": None,
                })
                continue
            age_s = (ts - r["heartbeat_ts"]) / 1000
            status = "running" if age_s < 15 else ("stale" if age_s < 60 else "down")
            services.append({
                "service": name, "pid": r["pid"], "status": status,
                "heartbeat_age_s": age_s, "started_ts": r["started_ts"],
                "info": json.loads(r["info"]) if r["info"] else None,
            })

        try:
            size_bytes = Path(db_path).stat().st_size
        except OSError:
            size_bytes = 0
        readings_n = conn.execute("SELECT COUNT(*) FROM readings").fetchone()[0]
        events_n = conn.execute("SELECT COUNT(*) FROM events").fetchone()[0]
        alerts_n = conn.execute("SELECT COUNT(*) FROM alerts").fetchone()[0]

        minute_ago = ts - 60_000
        readings_per_min = conn.execute(
            "SELECT COUNT(*) FROM readings WHERE ts >= ?", (minute_ago,)
        ).fetchone()[0]
        last_ts = conn.execute("SELECT MAX(ts) FROM readings").fetchone()[0]

        ollama_model = OLLAMA_MODEL
        try:
            import llm as llm_mod
            ollama_model = getattr(llm_mod, "MODEL", OLLAMA_MODEL)
        except ImportError:
            pass

        return {
            "services": services,
            "db": {"size_bytes": size_bytes, "readings": readings_n, "events": events_n, "alerts": alerts_n},
            "ingest": {"readings_per_min": readings_per_min, "last_ts": last_ts},
            "versions": {"api": "2", "python": sys.version.split()[0], "ollama_model": ollama_model},
            "now_ms": ts,
        }

    # ----------------------------------------------------------------- audit

    @app.get("/api/audit")
    def list_audit(limit: int = 100):
        rows = conn.execute("SELECT * FROM audit_log ORDER BY ts DESC LIMIT ?", (limit,)).fetchall()
        return [
            {"id": r["id"], "ts": r["ts"], "actor": r["actor"], "action": r["action"],
             "target": r["target"], "detail": r["detail"]}
            for r in rows
        ]

    # ------------------------------------------------------------- analytics

    @app.get("/api/analytics/summary")
    def analytics_summary():
        with lock:
            store.sync_devices(conn)
        ts = now_ms()
        settings = store.get_settings(conn)
        co2_factor = settings.get("co2_kg_per_kwh", 0.39)
        price = settings["price_per_kwh"]
        day_start = store.day_start_ms(ts)
        yesterday_start = day_start - 86_400_000
        month_start = store.month_start_ms(ts)

        kwh_today = store.kwh(conn, None, day_start, ts)
        kwh_yesterday = store.kwh(conn, None, yesterday_start, day_start)
        # Yesterday from 00:00 to the same clock time as now -- a fair "vs yesterday" delta,
        # unlike kwh_yesterday (the whole day) compared against a today that may be only a
        # few hours old.
        time_of_day_ms = ts - day_start
        kwh_yesterday_same_time = store.kwh(conn, None, yesterday_start, yesterday_start + time_of_day_ms)
        # Early in a demo DB's life, "yesterday" (and its same-time slice) can be almost
        # entirely empty, so the delta vs. a handful of readings produces a meaningless
        # swing (e.g. "+17928%"). Null out either figure when its window's coverage --
        # reading count / window seconds -- falls under 80%, rather than reporting a
        # number computed from next to no data.
        if store.window_coverage(conn, yesterday_start, yesterday_start + time_of_day_ms) < 0.8:
            kwh_yesterday_same_time = None
        if store.window_coverage(conn, yesterday_start, day_start) < 0.8:
            kwh_yesterday = None
        kwh_mtd = store.kwh(conn, None, month_start, ts)
        cost_today = kwh_today * price
        cost_mtd = kwh_mtd * price
        co2_kg_today = kwh_today * co2_factor
        co2_kg_mtd = kwh_mtd * co2_factor

        days_elapsed = max(1.0, (ts - month_start) / 86_400_000)
        total_days = store.days_in_month(ts)
        projected_month_kwh = kwh_mtd / days_elapsed * total_days
        projected_month_cost = projected_month_kwh * price

        # Total household watts at a point in time is one snapshot per device, summed
        # across devices -- NOT every raw 1 Hz row in the bucket summed together (that
        # would inflate the total ~5x for a 5 s bucket at 3 devices). Average each
        # device down to one value per bucket first, then sum across devices per bucket.
        since24 = ts - 86_400_000
        totals_24h = [
            r["w"] for r in conn.execute(
                "SELECT b, SUM(avg_w) AS w FROM ("
                "  SELECT (ts / 5000) * 5000 AS b, device_id, AVG(watts) AS avg_w"
                "  FROM readings WHERE ts >= ? GROUP BY b, device_id"
                ") GROUP BY b",
                (since24,),
            ).fetchall()
            if r["w"] is not None
        ]
        always_on_w = store.percentile(totals_24h, 5)
        rows = store.device_rows(conn, ts)
        current_total_w = sum(r["watts"] or 0.0 for r in rows if r["online"])
        active_w = max(0.0, current_total_w - always_on_w)

        peak_today_w, peak_today_ts = 0.0, None
        for r in conn.execute(
            "SELECT b, SUM(avg_w) AS w FROM ("
            "  SELECT (ts / 5000) * 5000 AS b, device_id, AVG(watts) AS avg_w"
            "  FROM readings WHERE ts >= ? GROUP BY b, device_id"
            ") GROUP BY b",
            (day_start,),
        ).fetchall():
            if r["w"] is not None and r["w"] > peak_today_w:
                peak_today_w = r["w"]
                peak_today_ts = r["b"]

        return {
            "kwh_today": kwh_today, "kwh_yesterday": kwh_yesterday,
            "kwh_yesterday_same_time": kwh_yesterday_same_time, "kwh_mtd": kwh_mtd,
            "cost_today": cost_today, "cost_mtd": cost_mtd,
            "projected_month_kwh": projected_month_kwh, "projected_month_cost": projected_month_cost,
            "co2_kg_today": co2_kg_today, "co2_kg_mtd": co2_kg_mtd,
            "always_on_w": always_on_w, "active_w": active_w,
            "peak_today_w": peak_today_w, "peak_today_ts": peak_today_ts,
            "currency": settings["currency"],
        }

    @app.get("/api/analytics/hourly")
    def analytics_hourly(days: int = 7, device_id: str = None):
        ts = now_ms()
        today_start = store.day_start_ms(ts)
        out = []
        for i in range(days - 1, -1, -1):
            day_start = today_start - i * 86_400_000
            day_str = time.strftime("%Y-%m-%d", time.localtime(day_start / 1000))
            for hour in range(24):
                hour_start = day_start + hour * 3_600_000
                if hour_start > ts:
                    kwh_val = 0.0
                else:
                    hour_end = min(hour_start + 3_600_000, ts)
                    kwh_val = store.kwh(conn, device_id, hour_start, hour_end)
                out.append({"day": day_str, "hour": hour, "kwh": kwh_val})
        return out

    @app.get("/api/analytics/breakdown")
    def analytics_breakdown(since_ms: int = None, until_ms: int = None):
        ts = now_ms()
        until = until_ms if until_ms is not None else ts
        since = since_ms if since_ms is not None else store.day_start_ms(ts)
        with lock:
            store.sync_devices(conn)
        settings = store.get_settings(conn)
        devices = conn.execute("SELECT device_id, name FROM devices ORDER BY device_id").fetchall()
        rows = []
        total = 0.0
        for d in devices:
            k = store.kwh(conn, d["device_id"], since, until)
            rows.append({
                "device_id": d["device_id"], "device_name": d["name"],
                "kwh": k, "cost": k * settings["price_per_kwh"],
            })
            total += k
        for r in rows:
            r["share"] = (r["kwh"] / total) if total > 0 else 0.0
        return rows

    # --------------------------------------------------------------- export

    @app.get("/api/export/readings.csv")
    def export_readings_csv(device_id: str = None, since_ms: int = None, until_ms: int = None):
        ts = now_ms()
        until = until_ms if until_ms is not None else ts
        since = since_ms if since_ms is not None else until - 86_400_000
        q, args = "SELECT ts, device_id, irms_a, watts FROM readings WHERE ts >= ? AND ts < ?", [since, until]
        if device_id:
            q += " AND device_id = ?"
            args.append(device_id)
        q += " ORDER BY ts"
        rows = conn.execute(q, args).fetchall()
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["ts", "device_id", "irms_a", "watts"])
        for r in rows:
            w.writerow([r["ts"], r["device_id"], r["irms_a"], r["watts"]])
        return Response(
            content=buf.getvalue(), media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=readings.csv"},
        )

    @app.get("/api/export/events.csv")
    def export_events_csv(since_ms: int = None):
        q, args = "SELECT * FROM events WHERE 1=1", []
        if since_ms is not None:
            q += " AND start_ts >= ?"
            args.append(since_ms)
        q += " ORDER BY start_ts"
        rows = conn.execute(q, args).fetchall()
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(["id", "device_id", "start_ts", "end_ts", "peak_w", "baseline_w", "score", "method", "explanation"])
        for r in rows:
            w.writerow([r["id"], r["device_id"], r["start_ts"], r["end_ts"], r["peak_w"],
                        r["baseline_w"], r["score"], r["method"], r["explanation"]])
        return Response(
            content=buf.getvalue(), media_type="text/csv",
            headers={"Content-Disposition": "attachment; filename=events.csv"},
        )

    # ----------------------------------------------------------------- model

    train_jobs = {}
    train_lock = threading.Lock()
    job_counter = {"n": 0}

    def _run_train_job(job_id, path):
        try:
            import detect_iforest
            import tune_iforest
        except ImportError as e:
            train_jobs[job_id].update(status="error", message=f"AI module not available yet: {e}")
            return
        train_jobs[job_id]["status"] = "running"

        def progress(pct, msg):
            train_jobs[job_id]["progress"] = pct
            train_jobs[job_id]["message"] = msg

        report_path = getattr(detect_iforest, "REPORT_PATH", None)
        try:
            report = tune_iforest.run(
                path, detect_iforest.MODEL_PATH, report_path, progress=progress
            )
            train_jobs[job_id].update(status="done", progress=100, message="done", report=report)
        except Exception as e:
            train_jobs[job_id].update(status="error", message=str(e))

    @app.get("/api/model")
    def model_status():
        try:
            import detect_iforest
        except ImportError:
            return {"exists": False, "report": None, "model_mtime": None}
        model_path = Path(detect_iforest.MODEL_PATH)
        report_path = getattr(detect_iforest, "REPORT_PATH", None)
        report = None
        if report_path and Path(report_path).exists():
            try:
                report = json.loads(Path(report_path).read_text())
            except Exception:
                report = None
        exists = model_path.exists()
        model_mtime = int(model_path.stat().st_mtime) if exists else None
        return {"exists": exists, "report": report, "model_mtime": model_mtime}

    @app.get("/api/model/scores")
    def model_scores(device_id: str, since_ms: int = None):
        try:
            from detect_iforest import MODEL_PATH, score_series
            import joblib
        except ImportError:
            raise HTTPException(503, "AI module not available yet")
        model_path = Path(MODEL_PATH)
        if not model_path.exists():
            raise HTTPException(503, "model not trained yet")
        ts = now_ms()
        since = since_ms if since_ms is not None else ts - 3_600_000
        rows = conn.execute(
            "SELECT ts, watts FROM readings WHERE device_id = ? AND ts >= ? ORDER BY ts",
            (device_id, since),
        ).fetchall()
        if not rows:
            return {"threshold": None, "points": []}
        bundle = joblib.load(model_path)
        ts_list = [r["ts"] for r in rows]
        watts_list = [r["watts"] for r in rows]
        scores = score_series(bundle, ts_list, watts_list)
        points = [{"ts": t, "score": float(s)} for t, s in zip(ts_list, scores)]
        if len(points) > 600:
            step = len(points) / 600
            points = [points[int(i * step)] for i in range(600)]
        return {"threshold": bundle.get("threshold"), "points": points}

    @app.post("/api/model/train", status_code=202)
    def start_train():
        try:
            import detect_iforest  # noqa: F401
            import tune_iforest  # noqa: F401
        except ImportError:
            raise HTTPException(503, "AI module not available yet")
        with train_lock:
            if any(j["status"] in ("queued", "running") for j in train_jobs.values()):
                raise HTTPException(409, "a training job is already running")
            job_counter["n"] += 1
            job_id = str(job_counter["n"])
            train_jobs[job_id] = {
                "job_id": job_id, "status": "queued", "progress": 0, "message": "queued", "report": None,
            }
        threading.Thread(target=_run_train_job, args=(job_id, db_path), daemon=True).start()
        with lock:
            _audit(conn, "train_model", job_id)
        return {"job_id": job_id}

    @app.get("/api/model/train/{job_id}")
    def get_train_job(job_id: str):
        job = train_jobs.get(job_id)
        if job is None:
            raise HTTPException(404, "job not found")
        return job

    # --------------------------------------------------------------- insights

    @app.get("/api/insights")
    def list_insights(limit: int = 20):
        rows = conn.execute(
            "SELECT * FROM insights ORDER BY created_ts DESC LIMIT ?", (limit,)
        ).fetchall()
        return [
            {"id": r["id"], "kind": r["kind"], "created_ts": r["created_ts"],
             "period_start": r["period_start"], "period_end": r["period_end"],
             "title": r["title"], "body": r["body"], "model": r["model"], "latency_ms": r["latency_ms"]}
            for r in rows
        ]

    @app.post("/api/insights/digest")
    def generate_digest():
        try:
            import digest
        except ImportError:
            raise HTTPException(503, "AI module not available yet")
        with lock:
            try:
                result = digest.generate(conn, now_ms())
            except Exception as e:
                raise HTTPException(503, f"LLM unreachable: {e}")
            _audit(conn, "generate_digest")
        return result

    # ------------------------------------------------------------- assistant

    @app.post("/api/assistant")
    async def assistant_route(body: dict = Body(...)):
        payload = body or {}
        question = payload.get("question", "")
        history = payload.get("history") or []
        try:
            import assistant
        except ImportError:
            raise HTTPException(503, "AI module not available yet")
        if not probe.check():
            raise HTTPException(503, "LLM unreachable")

        q: "queue.Queue" = queue.Queue()
        sentinel = object()

        def worker():
            try:
                for kind, data in assistant.answer_stream(conn, question, history, now_ms()):
                    q.put((kind, data))
            except Exception as e:
                q.put(("error", {"message": str(e)}))
            finally:
                q.put(sentinel)

        threading.Thread(target=worker, daemon=True).start()

        async def gen():
            while True:
                item = await run_in_threadpool(q.get)
                if item is sentinel:
                    break
                kind, data = item
                yield f"event: {kind}\ndata: {json.dumps(data)}\n\n"

        return StreamingResponse(gen(), media_type="text/event-stream")

    # ------------------------------------------------------------------- llm

    @app.get("/api/llm")
    def llm_status():
        model = OLLAMA_MODEL
        try:
            import llm as llm_mod
            model = getattr(llm_mod, "MODEL", OLLAMA_MODEL)
        except ImportError:
            pass
        prompt_version = None
        try:
            import explain as explain_mod
            prompt_version = getattr(explain_mod, "PROMPT_VERSION", None)
        except ImportError:
            pass
        eval_data = None
        eval_path = Path(__file__).resolve().parent / "eval" / "explain_report.json"
        if eval_path.exists():
            try:
                parsed = json.loads(eval_path.read_text())
                eval_data = {"chosen": parsed.get("chosen"), "variants": parsed.get("variants")}
            except Exception:
                eval_data = None
        return {"model": model, "reachable": probe.check(), "prompt_version": prompt_version, "eval": eval_data}

    # ----------------------------------------------------------------- stream

    def _sse(event, data):
        return f"event: {event}\ndata: {json.dumps(data)}\n\n"

    STREAM_WINDOW_MS = 2 * 3_600_000  # only track events/alerts from the last 2 h (bounded memory)
    # Test-only knobs: a short, fast-polling stream that still terminates on its own, so a
    # stream test can never hang the suite even if its own read loop has a bug. Unset (the
    # default) means unbounded/1 s, i.e. real production behaviour.
    STREAM_POLL_S = float(os.environ.get("WATTWATCH_STREAM_POLL_S", "1"))
    STREAM_MAX_ITERS = int(os.environ.get("WATTWATCH_STREAM_MAX_ITERS", "0")) or None

    def _stream_new_readings(last_rowid):
        return conn.execute(
            "SELECT rowid, device_id, ts, watts FROM readings WHERE rowid > ? ORDER BY rowid LIMIT 500",
            (last_rowid,),
        ).fetchall()

    def _stream_max_rowid():
        row = conn.execute("SELECT COALESCE(MAX(rowid), 0) AS n FROM readings").fetchone()
        return row["n"]

    def _stream_recent_events(since_ms):
        rows = conn.execute(
            "SELECT * FROM events WHERE start_ts >= ? ORDER BY id", (since_ms,)
        ).fetchall()
        return [
            ({
                "id": r["id"], "device_id": r["device_id"], "start_ts": r["start_ts"], "end_ts": r["end_ts"],
                "duration_s": max(1, round((r["end_ts"] - r["start_ts"]) / 1000) + 1),
                "peak_w": r["peak_w"], "baseline_w": r["baseline_w"], "score": r["score"],
                "method": r["method"], "explanation": r["explanation"],
                "ai": store.explanation_row(conn, r["id"]),
            })
            for r in rows
        ]

    def _stream_recent_alerts(since_ms):
        rows = conn.execute(
            "SELECT alerts.*, devices.name AS device_name FROM alerts"
            " LEFT JOIN devices ON devices.device_id = alerts.device_id"
            " WHERE alerts.status IN ('open','acknowledged') OR alerts.updated_ts >= ?"
            " ORDER BY alerts.id",
            (since_ms,),
        ).fetchall()
        return [
            _alert_row(r, store.alert_detectors(conn, r["event_id"]), store.explanation_row(conn, r["event_id"]))
            for r in rows
        ]

    def _stream_status():
        ts = now_ms()
        minute_ago = ts - 60_000
        n = conn.execute("SELECT COUNT(*) FROM readings WHERE ts >= ?", (minute_ago,)).fetchone()[0]
        rows = conn.execute("SELECT heartbeat_ts FROM service_status").fetchall()
        services_ok = bool(rows) and all(ts - r["heartbeat_ts"] < 60_000 for r in rows)
        return {"ts": ts, "readings_per_min": n, "services_ok": services_ok}

    @app.get("/api/stream")
    async def stream():
        async def gen():
            last_rowid = await run_in_threadpool(_stream_max_rowid)
            seen_events = {}
            seen_alerts = {}
            last_status = 0.0
            last_ping = time.monotonic()
            iters = 0
            while True:
                rows = await run_in_threadpool(_stream_new_readings, last_rowid)
                for r in rows:
                    last_rowid = r["rowid"]
                    yield _sse("reading", {"device_id": r["device_id"], "ts": r["ts"], "watts": r["watts"]})

                since = now_ms() - STREAM_WINDOW_MS
                events = await run_in_threadpool(_stream_recent_events, since)
                live_ids = {e["id"] for e in events}
                for stale in set(seen_events) - live_ids:
                    del seen_events[stale]
                for e in events:
                    if seen_events.get(e["id"]) != e["explanation"]:
                        seen_events[e["id"]] = e["explanation"]
                        yield _sse("event", e)

                alerts_rows = await run_in_threadpool(_stream_recent_alerts, since)
                live_alert_ids = {a["id"] for a in alerts_rows}
                for stale in set(seen_alerts) - live_alert_ids:
                    del seen_alerts[stale]
                for a in alerts_rows:
                    state = (a["status"], a["updated_ts"])
                    if seen_alerts.get(a["id"]) != state:
                        seen_alerts[a["id"]] = state
                        yield _sse("alert", a)

                now_s = time.monotonic()
                if now_s - last_status >= 5:
                    last_status = now_s
                    status = await run_in_threadpool(_stream_status)
                    yield _sse("status", status)
                if now_s - last_ping >= 15:
                    last_ping = now_s
                    yield ": ping\n\n"

                iters += 1
                if STREAM_MAX_ITERS and iters >= STREAM_MAX_ITERS:
                    return
                await asyncio.sleep(STREAM_POLL_S)

        return StreamingResponse(gen(), media_type="text/event-stream")

    # ---------------------------------------------------------------- static

    web_dist = Path(os.environ.get("WEB_DIST", Path(__file__).resolve().parent.parent / "web" / "dist"))
    if web_dist.exists():
        app.mount("/assets", StaticFiles(directory=web_dist / "assets"), name="assets")

        @app.get("/{full_path:path}")
        def spa(full_path: str):
            if full_path.startswith("api"):
                raise HTTPException(404, "not found")
            # index.html must never be cached: it names the hashed asset bundle, so a
            # cached copy keeps serving the previous build after `npm run build`.
            return FileResponse(web_dist / "index.html", headers={"Cache-Control": "no-cache"})
    else:
        @app.get("/")
        def no_build():
            return {"detail": "web/dist not built; run npm run build in ../web"}

    return app


if __name__ == "__main__":
    import argparse

    import uvicorn

    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=8080)
    ap.add_argument("--host", default="0.0.0.0")
    args = ap.parse_args()
    uvicorn.run(create_app(db.DB_PATH), host=args.host, port=args.port, log_level="warning")
