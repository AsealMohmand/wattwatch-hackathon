"""SQLite access shared by every hub process.

Ingest is the only writer of `readings`; detectors and the explainer write
`events`; the API reads everything and writes only console state. WAL mode lets readers run while ingest writes.
"""

import os
import sqlite3
from pathlib import Path

DB_PATH = Path(os.environ.get("ENERGY_DB", Path(__file__).with_name("energy.db")))

SCHEMA = """
CREATE TABLE IF NOT EXISTS readings (
  ts        INTEGER NOT NULL,   -- Unix ms
  device_id TEXT    NOT NULL,
  irms_a    REAL    NOT NULL,
  watts     REAL    NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_readings ON readings(device_id, ts);

CREATE TABLE IF NOT EXISTS events (
  id          INTEGER PRIMARY KEY,
  device_id   TEXT    NOT NULL,
  start_ts    INTEGER NOT NULL,
  end_ts      INTEGER NOT NULL,
  peak_w      REAL    NOT NULL,
  baseline_w  REAL    NOT NULL,
  score       REAL,               -- detector score at peak
  method      TEXT    NOT NULL,   -- 'rule' or 'iforest'
  explanation TEXT                -- filled by Llama, may be NULL
);

-- v2: firmware telemetry (written by ingest), structured AI output (explain),
-- service heartbeats (every process), digests (digest), audit trail (api).
CREATE TABLE IF NOT EXISTS node_status (
  node_id TEXT NOT NULL, port TEXT NOT NULL, device_id TEXT NOT NULL,
  fw TEXT, boot_id TEXT, uptime_ms INTEGER, n_samples INTEGER,
  irms_raw_a REAL, peak_raw_a REAL, over_limit INTEGER NOT NULL DEFAULT 0,
  first_seen_ts INTEGER NOT NULL, last_ts INTEGER NOT NULL,
  boots INTEGER NOT NULL DEFAULT 1, readings INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (node_id, port)
);
CREATE TABLE IF NOT EXISTS node_telemetry (
  ts INTEGER NOT NULL, node_id TEXT NOT NULL, port TEXT NOT NULL,
  uptime_ms INTEGER, n_samples INTEGER, irms_raw_a REAL, peak_raw_a REAL, over_limit INTEGER
);
CREATE INDEX IF NOT EXISTS idx_node_telemetry ON node_telemetry(node_id, port, ts);
CREATE TABLE IF NOT EXISTS explanations (
  event_id INTEGER PRIMARY KEY, appliance TEXT, confidence TEXT, verdict TEXT,
  summary TEXT NOT NULL, model TEXT NOT NULL, prompt_version TEXT NOT NULL,
  latency_ms INTEGER, fallback INTEGER NOT NULL DEFAULT 0, created_ts INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS service_status (
  service TEXT PRIMARY KEY, pid INTEGER, started_ts INTEGER NOT NULL,
  heartbeat_ts INTEGER NOT NULL, info TEXT
);
CREATE TABLE IF NOT EXISTS insights (
  id INTEGER PRIMARY KEY, kind TEXT NOT NULL, created_ts INTEGER NOT NULL,
  period_start INTEGER, period_end INTEGER, title TEXT NOT NULL, body TEXT NOT NULL,
  model TEXT, latency_ms INTEGER
);
CREATE TABLE IF NOT EXISTS audit_log (
  id INTEGER PRIMARY KEY, ts INTEGER NOT NULL, actor TEXT NOT NULL,
  action TEXT NOT NULL, target TEXT, detail TEXT
);
"""


def connect(path=DB_PATH):
    conn = sqlite3.connect(path, timeout=10, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.executescript(SCHEMA)
    return conn
