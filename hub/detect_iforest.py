"""Layer 2: Isolation Forest over per-second features. Carries the ML claim.

Tune with `tune_iforest.py` (picks the feature set and threshold from a
backtest + injection sweep); this module loads whatever bundle that writes
and scores live readings with it.

    python detect_iforest.py train                 # quick manual train, all readings so far
    python detect_iforest.py train --minutes 60    # only the last hour
    python detect_iforest.py scores --minutes 30   # print score percentiles to pick a threshold

Two feature sets (`FEATURE_SETS`):

  v1 (absolute): watts, 1 s change in watts, 30 s rolling mean, 30 s rolling
  std, and watts / 10-minute median.

  v2 (scale-relative, so the same shape of event scores similarly whether the
  baseline is 80 W or 800 W): log1p(watts), the 1 s delta divided by the
  2-min median, the 30 s std divided by the 2-min median, watts / 10-min
  median, and watts - 2-min median.

A second is flagged when the model's decision_function falls below
`bundle["threshold"]` (or IFOREST_THRESHOLD, if set).
"""

import argparse
import os
import time
from collections import deque
from pathlib import Path

import joblib
import numpy as np
import pandas as pd

from db import connect

MODEL_PATH = Path(os.environ.get("ENERGY_MODEL", Path(__file__).with_name("model.joblib")))
REPORT_PATH = Path(os.environ.get("ENERGY_MODEL_REPORT", Path(__file__).with_name("model_report.json")))

FEATURE_SETS = {
    "v1": ["watts", "d_watts", "mean_30s", "std_30s", "ratio_10m"],
    "v2": ["log_w", "d_ratio_2m", "std_ratio_2m", "ratio_10m", "diff_2m"],
}
BUFFER_MS = 600_000
MIN_SAMPLES = 30


def _raw(ts_ms, watts):
    """Every candidate feature column, time-indexed. `features()` selects a subset."""
    s = pd.Series(np.asarray(watts, float), index=pd.to_datetime(np.asarray(ts_ms), unit="ms"))
    med_2m = s.rolling("120s").median().clip(lower=1.0)
    med_10m = s.rolling("600s").median().clip(lower=1.0)
    d_watts = s.diff().fillna(0.0)
    std_30s = s.rolling("30s").std().fillna(0.0)
    return pd.DataFrame({
        "watts": s,
        "d_watts": d_watts,
        "mean_30s": s.rolling("30s").mean(),
        "std_30s": std_30s,
        "ratio_10m": s / med_10m,
        "log_w": np.log1p(s.clip(lower=0.0)),
        "d_ratio_2m": d_watts / med_2m,
        "std_ratio_2m": std_30s / med_2m,
        "diff_2m": s - med_2m,
    })


def features(ts_ms, watts, feature_set: str = "v1") -> pd.DataFrame:
    """Feature frame for a time-ordered series of readings."""
    if feature_set not in FEATURE_SETS:
        raise ValueError(f"unknown feature_set: {feature_set}")
    return _raw(ts_ms, watts)[FEATURE_SETS[feature_set]]


def score_series(bundle: dict, ts_ms, watts) -> np.ndarray:
    """decision_function per reading, using bundle['feature_set']. For plotting/backtest,
    not the live loop (which scores incrementally via IForestDetector.step).
    """
    feature_set = bundle.get("feature_set", "v1")
    X = features(ts_ms, watts, feature_set)
    return bundle["model"].decision_function(X.values)


def load_readings(conn, minutes=None, device_id=None):
    q, args = "SELECT ts, device_id, watts FROM readings WHERE 1=1", []
    if minutes:
        q += " AND ts >= ?"
        args.append(int(time.time() * 1000) - minutes * 60_000)
    if device_id:
        q += " AND device_id = ?"
        args.append(device_id)
    return pd.read_sql_query(q + " ORDER BY ts", conn, params=args)


def train(minutes=None, device_id=None, threshold=0.0, feature_set="v1"):
    """Quick manual train (no backtest/report) -- for ad hoc tuning at the shell.
    `tune_iforest.run` is the path that writes model_report.json.
    """
    from sklearn.ensemble import IsolationForest

    df = load_readings(connect(), minutes, device_id)
    if len(df) < 600:
        raise SystemExit(f"only {len(df)} readings; need at least 10 min (30-60 min recommended)")
    X = pd.concat([features(g.ts, g.watts, feature_set) for _, g in df.groupby("device_id")])
    model = IsolationForest(n_estimators=200, contamination=0.01, random_state=0).fit(X.values)
    scores = model.decision_function(X.values)
    joblib.dump(
        {"model": model, "threshold": threshold, "feature_set": feature_set,
         "features": FEATURE_SETS[feature_set], "trained_rows": len(X), "trained_at": int(time.time())},
        MODEL_PATH,
    )
    print(f"trained on {len(X)} rows ({len(X) / 60:.0f} min) -> {MODEL_PATH}")
    print_percentiles(scores)


def print_percentiles(scores):
    for p in (0.1, 0.5, 1, 5, 50):
        print(f"  p{p:<4} score {np.percentile(scores, p):+.4f}")
    print("flag when score < threshold (saved threshold is used unless IFOREST_THRESHOLD is set)")


class IForestDetector:
    method = "iforest"

    def __init__(self, bundle):
        self.model = bundle["model"]
        self.feature_set = bundle.get("feature_set", "v1")
        self.threshold = float(os.environ.get("IFOREST_THRESHOLD", bundle.get("threshold", 0.0)))
        self.buf = deque()  # (ts, watts), last 10 min

    @staticmethod
    def load():
        return IForestDetector(joblib.load(MODEL_PATH)) if MODEL_PATH.exists() else None

    def step(self, ts, watts):
        """Return (flagged, score, baseline_w) for one reading."""
        self.buf.append((ts, watts))
        while ts - self.buf[0][0] > BUFFER_MS:
            self.buf.popleft()
        if len(self.buf) < MIN_SAMPLES:
            return False, 0.0, None
        t, w = zip(*self.buf)
        f = features(t, w, self.feature_set).iloc[[-1]].values
        score = float(self.model.decision_function(f)[0])
        baseline = float(np.median(w[:-1]))
        return score < self.threshold, score, baseline


def main():
    ap = argparse.ArgumentParser()
    sub = ap.add_subparsers(dest="cmd", required=True)
    t = sub.add_parser("train")
    t.add_argument("--minutes", type=int)
    t.add_argument("--device")
    t.add_argument("--threshold", type=float, default=0.0)
    t.add_argument("--feature-set", default="v1", choices=list(FEATURE_SETS))
    s = sub.add_parser("scores")
    s.add_argument("--minutes", type=int, default=30)
    s.add_argument("--device")
    args = ap.parse_args()

    if args.cmd == "train":
        train(args.minutes, args.device, args.threshold, args.feature_set)
    else:
        bundle = joblib.load(MODEL_PATH)
        df = load_readings(connect(), args.minutes, args.device)
        X = pd.concat([features(g.ts, g.watts, bundle.get("feature_set", "v1")) for _, g in df.groupby("device_id")])
        print(f"{len(X)} rows, last {args.minutes} min")
        print_percentiles(bundle["model"].decision_function(X.values))


if __name__ == "__main__":
    main()
