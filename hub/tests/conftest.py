import os
import sys
import tempfile
import time
from pathlib import Path

import pytest

# Point the model path (and its report) away from the live hub/model.joblib before any hub
# module reads it, and away from hub/model_report.json so one test file's real training run
# (e.g. the Isolation Forest tuning tests) can't leak a report into another file's "not
# trained yet" assertions by writing to the shared on-disk default.
_model_tmp = Path(tempfile.mkdtemp())
os.environ["ENERGY_MODEL"] = str(_model_tmp / "model.joblib")
os.environ.setdefault("ENERGY_MODEL_REPORT", str(_model_tmp / "model_report.json"))
# /api/stream polls in a `while True`; bound it in tests so a stream test can never hang the
# suite even if its own read loop never finds what it's looking for -- a handful of fast
# iterations is enough for any test to see what it needs, then the generator returns on its own.
os.environ.setdefault("WATTWATCH_STREAM_POLL_S", "0.05")
os.environ.setdefault("WATTWATCH_STREAM_MAX_ITERS", "20")
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import db
import store


@pytest.fixture
def conn(tmp_path):
    c = db.connect(tmp_path / "t.db")
    store.init(c)
    return c


@pytest.fixture
def db_path(tmp_path):
    return tmp_path / "t.db"


@pytest.fixture
def client(db_path):
    from fastapi.testclient import TestClient
    import api
    return TestClient(api.create_app(db_path))


def add_readings(conn, device_id, start_ms, watts_list):
    conn.executemany(
        "INSERT INTO readings VALUES (?,?,?,?)",
        [(start_ms + i * 1000, device_id, w / 120, w) for i, w in enumerate(watts_list)],
    )
    conn.commit()
