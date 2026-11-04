import os
from pathlib import Path

import joblib


def test_health_reports_model_from_detector_path(client):
    path = Path(os.environ["ENERGY_MODEL"])
    path.unlink(missing_ok=True)
    assert client.get("/api/health").json()["iforest"]["trained"] is False

    joblib.dump({"model": None, "threshold": -0.02, "trained_at": 1762228800}, path)
    body = client.get("/api/health").json()["iforest"]
    assert body == {"trained": True, "trained_at": 1762228800, "threshold": -0.02}
    path.unlink()
