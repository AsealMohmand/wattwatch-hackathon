"""Receive plug-node readings and write them to SQLite.

HTTP mode (default):  python ingest.py              -> POST http://<pc-ip>:8000/ingest
Serial mode:          python ingest.py --serial COM4 -> JSON or CSV lines at 115200 baud

A reading is {"ts"?, "device_id", "irms_a", "watts"}. `ts` (Unix ms) is stamped
with arrival time when missing, null or zero, so the node needs no NTP sync.

The WattWatch serial firmware (firmware/current.ino) sends one JSON line per ADC
port per second with `irms_raw_a` (uncalibrated amps) and `port`. Those become
device `ww-01/ch0` with irms_a = irms_raw_a * CT_CAL. Set CT_CAL once you have
checked a known load (kettle rating plate / reading); it defaults to 1.0.
"""

import argparse
import json
import os
import time
from typing import Any

from db import connect
from heartbeat import Heartbeat

VOLTS = 120.0
CT_CAL = float(os.environ.get("CT_CAL", "1.0"))


def now_ms():
    return int(time.time() * 1000)


def normalize(r):
    """Validate one reading dict; return a row tuple or raise ValueError."""
    try:
        device_id = str(r.get("device_id") or "plug-1")
        if r.get("port"):
            device_id = f"{device_id}/{r['port']}"
        if r.get("irms_a") is not None:
            irms_a = float(r["irms_a"])
        elif r.get("irms_raw_a") is not None:
            irms_a = float(r["irms_raw_a"]) * CT_CAL
        else:
            irms_a = None
        watts = float(r["watts"]) if r.get("watts") is not None else None
    except (TypeError, ValueError) as e:
        raise ValueError(f"bad field: {e}") from None
    if irms_a is None and watts is None:
        raise ValueError("need irms_a or watts")
    if irms_a is None:
        irms_a = watts / VOLTS
    if watts is None:
        watts = irms_a * VOLTS
    if irms_a < 0 or watts < 0:
        raise ValueError("negative reading")
    ts = r.get("ts")
    ts = int(ts) if ts else now_ms()
    if ts < 10**12:  # node sent seconds, or millis() since boot: use arrival time
        ts = now_ms()
    return ts, device_id, irms_a, watts


def insert(conn, rows):
    conn.executemany(
        "INSERT INTO readings (ts, device_id, irms_a, watts) VALUES (?, ?, ?, ?)", rows
    )
    conn.commit()


# ------------------------------------------------------------- telemetry (v2)

def telemetry(r):
    """Firmware fields from one raw reading dict, or None when none are present
    (plain CSV lines and bare HTTP {"device_id","irms_a"/"watts"} posts carry none
    of this, so they never create a node_status row).
    """
    if not isinstance(r, dict):
        return None
    if r.get("fw") is None and r.get("boot_id") is None and r.get("n_samples") is None:
        return None
    node_id = str(r.get("device_id") or "plug-1")
    port = str(r["port"]) if r.get("port") else ""
    device_id = f"{node_id}/{port}" if port else node_id
    return {
        "node_id": node_id,
        "port": port,
        "device_id": device_id,
        "fw": r.get("fw"),
        "boot_id": r.get("boot_id"),
        "uptime_ms": r.get("uptime_ms"),
        "n_samples": r.get("n_samples"),
        "irms_raw_a": r.get("irms_raw_a"),
        "peak_raw_a": r.get("peak_raw_a"),
        "over_limit": 1 if r.get("over_limit") else 0,
    }


TELEMETRY_SAMPLE_EVERY = 10  # every Nth reading per port also lands in node_telemetry


def upsert_node_status(conn, t, ts):
    """Upsert `node_status` for one telemetry reading; sample every Nth into
    `node_telemetry`. `boots` increments only when boot_id changes from what we
    had (and both are known) -- a first sighting is boot 1, not a new boot.
    """
    row = conn.execute(
        "SELECT * FROM node_status WHERE node_id = ? AND port = ?", (t["node_id"], t["port"])
    ).fetchone()
    if row is None:
        readings = 1
        boots = 1
        conn.execute(
            "INSERT INTO node_status (node_id, port, device_id, fw, boot_id, uptime_ms,"
            " n_samples, irms_raw_a, peak_raw_a, over_limit, first_seen_ts, last_ts,"
            " boots, readings) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (t["node_id"], t["port"], t["device_id"], t["fw"], t["boot_id"], t["uptime_ms"],
             t["n_samples"], t["irms_raw_a"], t["peak_raw_a"], t["over_limit"], ts, ts,
             boots, readings),
        )
    else:
        readings = row["readings"] + 1
        boots = row["boots"]
        if t["boot_id"] is not None and row["boot_id"] is not None and t["boot_id"] != row["boot_id"]:
            boots += 1
        conn.execute(
            "UPDATE node_status SET device_id = ?, fw = ?, boot_id = ?, uptime_ms = ?,"
            " n_samples = ?, irms_raw_a = ?, peak_raw_a = ?, over_limit = ?, last_ts = ?,"
            " boots = ?, readings = ? WHERE node_id = ? AND port = ?",
            (t["device_id"], t["fw"], t["boot_id"], t["uptime_ms"], t["n_samples"],
             t["irms_raw_a"], t["peak_raw_a"], t["over_limit"], ts, boots, readings,
             t["node_id"], t["port"]),
        )
    if readings % TELEMETRY_SAMPLE_EVERY == 0:
        conn.execute(
            "INSERT INTO node_telemetry (ts, node_id, port, uptime_ms, n_samples,"
            " irms_raw_a, peak_raw_a, over_limit) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
            (ts, t["node_id"], t["port"], t["uptime_ms"], t["n_samples"],
             t["irms_raw_a"], t["peak_raw_a"], t["over_limit"]),
        )
    conn.commit()


# ---------------------------------------------------------------- HTTP mode

def make_app(port=8000):
    from fastapi import Body, FastAPI, HTTPException, Response

    app = FastAPI(title="energy-hub ingest")
    conn = connect()
    hb = Heartbeat(conn, "ingest")

    @app.post("/ingest", status_code=204)
    def ingest(payload: Any = Body(...)):
        items = payload if isinstance(payload, list) else [payload]
        try:
            rows = [normalize(r) for r in items]
        except (ValueError, AttributeError) as e:
            raise HTTPException(status_code=422, detail=str(e))
        insert(conn, rows)
        for raw, row in zip(items, rows):
            t = telemetry(raw)
            if t:
                upsert_node_status(conn, t, row[0])
        hb.tick({"mode": "http", "port": port})
        return Response(status_code=204)

    @app.get("/health")
    def health():
        row = conn.execute("SELECT MAX(ts) AS ts, COUNT(*) AS n FROM readings").fetchone()
        return {"last_ts": row["ts"], "readings": row["n"]}

    return app


# -------------------------------------------------------------- serial mode

def parse_line(line):
    """Accept a JSON object, `device_id,irms_a,watts` or `ts,device_id,irms_a,watts`.

    Returns (row, raw) where `raw` is the firmware dict for a JSON line (so the
    caller can pull telemetry out of it) or None for a plain CSV line. Returns
    (None, None) for headers, `#` diagnostics and anything else unparseable.
    """
    if line.startswith("{"):
        try:
            raw = json.loads(line)
            return normalize(raw), raw
        except (ValueError, AttributeError):
            return None, None
    parts = [p.strip() for p in line.split(",")]
    try:
        if len(parts) == 3:
            return normalize({"device_id": parts[0], "irms_a": parts[1], "watts": parts[2]}), None
        if len(parts) == 4:
            return normalize(
                {"ts": parts[0], "device_id": parts[1], "irms_a": parts[2], "watts": parts[3]}
            ), None
    except ValueError:
        return None, None
    return None, None


SILENT_WARN_S = 10


def open_serial(port, baud):
    """Open the port the way the Nano ESP32's native USB needs.

    Its core (USBCDC.cpp) drops every Serial write unless the host has DTR set,
    and an RTS-high step on open starts its reboot-to-bootloader handshake. So
    set DTR on and RTS off before opening, instead of pyserial's default of both on.
    """
    import serial

    ser = serial.Serial()
    ser.port, ser.baudrate, ser.timeout = port, baud, 2
    ser.dtr = True
    ser.rts = False
    ser.open()
    ser.reset_input_buffer()
    return ser


def run_serial(port, baud):
    import serial

    conn = connect()
    hb = Heartbeat(conn, "ingest")
    print(f"reading {port} @ {baud}, CT_CAL={CT_CAL}")
    count = 0
    while True:
        try:
            with open_serial(port, baud) as ser:
                print(f"{port} open; waiting for lines")
                echoed = 0
                last_rx = opened = time.time()
                warned = 0.0
                while True:
                    line = ser.readline().decode("utf-8", errors="replace").strip()
                    if not line:
                        quiet = time.time() - last_rx
                        if quiet > SILENT_WARN_S and time.time() - warned > 30:
                            warned = time.time()
                            print(f"no data from {port} for {quiet:.0f} s. Press the board's reset "
                                  "button or replug its USB cable; ingest keeps the port open.")
                        hb.tick({"mode": "serial", "port": port})
                        continue
                    last_rx = time.time()
                    if echoed < 3:
                        echoed += 1
                        print(f"rx {time.time() - opened:.1f}s: {line[:120]}")
                    row, fw_raw = parse_line(line)
                    if row:
                        insert(conn, [row])
                        count += 1
                        t = telemetry(fw_raw) if fw_raw else None
                        if t:
                            upsert_node_status(conn, t, row[0])
                        if count == 1 or count % 60 == 0:
                            print(f"{count} readings; last {row[1]} {row[2]:.3f} A {row[3]:.0f} W")
                    else:
                        print(f"skip: {line!r}")
                    hb.tick({"mode": "serial", "port": port})
        except serial.SerialException as e:
            print(f"serial error: {e}; retrying in 2 s"
                  " (close the Arduino Serial Monitor: only one program can hold the port)")
            time.sleep(2)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--serial", metavar="PORT", help="read from a serial port, e.g. COM4")
    ap.add_argument("--baud", type=int, default=115200)
    ap.add_argument("--host", default="0.0.0.0")
    ap.add_argument("--port", type=int, default=8000)
    args = ap.parse_args()

    if args.serial:
        run_serial(args.serial, args.baud)
    else:
        import uvicorn

        uvicorn.run(make_app(args.port), host=args.host, port=args.port, log_level="warning")


if __name__ == "__main__":
    main()
