"""ML1: feature sets, score_series parity with the live detector, and
atomic writes from tune_iforest.run.
"""

import json

import joblib
import numpy as np
import pandas as pd
import pytest

import db
import tune_iforest
from detect_iforest import MIN_SAMPLES, IForestDetector, features, score_series

START_TS = 1_700_000_000_000


def test_ml_split_by_rows_across_gaps():
    """A long gap between two live sessions must not bias the 70/30 split: splitting by row
    count (not elapsed time) keeps the cut at 70% of the rows regardless of how much
    wall-clock time the gap ate. Regression for the real bug: a ~90 min live ingest gap put
    the old time-based cutoff inside the gap, so training got only ~26% of the rows (829 of
    3,193) instead of 70%.
    """
    device_id = "ww-01/ch0"
    seg1_n, seg2_n = 300, 700
    seg1_ts = [START_TS + i * 1000 for i in range(seg1_n)]
    gap_ms = 2 * 3600 * 1000  # a 2 h ingest gap between the two live sessions
    seg2_start = seg1_ts[-1] + 1000 + gap_ms
    seg2_ts = [seg2_start + i * 1000 for i in range(seg2_n)]
    ts = seg1_ts + seg2_ts
    watts = [80.0] * (seg1_n + seg2_n)  # flat idle noise -- no rule-flagged spans to exclude
    df = pd.DataFrame({"ts": ts, "device_id": [device_id] * len(ts), "watts": watts})

    train, held = tune_iforest._split(df)

    assert len(train) == 700
    assert len(held) == 300
    # Row-count split, not time-based: training reaches into segment 2 (a time-based 70%
    # cut over the full span, t0 to t1, would land inside the 2 h gap instead, leaving
    # training with only segment 1's 300 rows).
    assert train["ts"].max() >= seg2_start
    assert held["ts"].min() >= seg2_start


def test_ml_features_v2_scale_invariant():
    """The v2 ratio features (delta/2m-median, std/2m-median, watts/10m-median) depend
    only on shape, not absolute watts: the same relative step at 80 W and at 800 W
    (10x) must score near-identically on those columns.
    """
    n = 400
    ts = [START_TS + i * 1000 for i in range(n)]
    shape = np.concatenate([np.full(200, 1.0), np.full(200, 1.3)])  # a 30% step partway through
    low = (shape * 80).tolist()
    high = (shape * 800).tolist()

    f_low = features(ts, low, "v2")
    f_high = features(ts, high, "v2")

    for col in ("d_ratio_2m", "std_ratio_2m", "ratio_10m"):
        a = f_low[col].to_numpy()[50:]  # skip rolling warmup
        b = f_high[col].to_numpy()[50:]
        assert np.allclose(a, b, atol=0.05), f"{col} not scale-invariant: {a[:5]} vs {b[:5]}"


def test_ml_score_series_matches_detector():
    """score_series (vectorized, for the model lab chart) must agree with the live
    IForestDetector.step (incremental, 10-min buffer) once the buffer has warmed up.
    """
    from sklearn.ensemble import IsolationForest

    rng = np.random.default_rng(1)
    n = 300
    ts = [START_TS + i * 1000 for i in range(n)]
    watts = (80 + rng.normal(0, 2, n)).tolist()

    X = features(ts, watts, "v1")
    model = IsolationForest(n_estimators=50, random_state=0).fit(X.values)
    bundle = {"model": model, "threshold": 0.0, "feature_set": "v1"}

    batch_scores = score_series(bundle, ts, watts)
    detector = IForestDetector(bundle)
    step_scores = [detector.step(t, w)[1] for t, w in zip(ts, watts)]

    start = MIN_SAMPLES - 1
    assert np.allclose(batch_scores[start:], step_scores[start:], atol=1e-9)


def test_ml_tune_writes_atomically(tmp_path):
    db_path = tmp_path / "src.db"
    conn = db.connect(db_path)
    rng = np.random.default_rng(42)
    n = 900  # 15 min, idle noise only
    watts = 80 + rng.normal(0, 1.5, n)
    rows = [
        (START_TS + i * 1000, "dev/ch0", float(watts[i]) / 120, float(watts[i]))
        for i in range(n)
    ]
    conn.executemany("INSERT INTO readings VALUES (?,?,?,?)", rows)
    conn.commit()
    conn.close()

    model_out = tmp_path / "model.joblib"
    report_out = tmp_path / "model_report.json"
    report = tune_iforest.run(db_path, model_out, report_out)

    assert model_out.exists()
    assert report_out.exists()
    assert not any(p.name.endswith(".tmp") for p in tmp_path.iterdir())

    bundle = joblib.load(model_out)
    assert "model" in bundle and bundle["feature_set"] in ("v1", "v2")

    data = json.loads(report_out.read_text())
    assert data == report
    assert data["feature_set"] in ("v1", "v2")
    assert "chosen_reason" in data and isinstance(data["chosen_reason"], str)
    assert len(data["candidates"]) > 0
    assert "injections" in data["backtest"] and len(data["backtest"]["injections"]) == 4
    assert "rule_injections" in data["backtest"] and len(data["backtest"]["rule_injections"]) == 4

    # np.histogram returns (counts, edges): edges are N+1 ascending scores, counts N integers.
    hist = data["score_hist"]
    assert len(hist["edges"]) == len(hist["counts"]) + 1
    assert hist["edges"] == sorted(hist["edges"])
    assert all(isinstance(c, int) for c in hist["counts"])
