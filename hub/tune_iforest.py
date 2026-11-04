"""Picks the Isolation Forest feature set and threshold, then writes
`model.joblib` and `model_report.json` atomically.

    python tune_iforest.py --db energy.db --out-model model.joblib --out-report model_report.json
    python tune_iforest.py --db energy.db --out-model model.joblib --out-report model_report.json --minutes 60

Method:
1. Snapshot the DB read-only (sqlite backup API) so this never holds a write
   lock on a live `energy.db`.
2. Split each device's readings by time: first 70% train, last 30% held-out
   (treated as idle for the false-alarm count).
3. Train an IsolationForest per feature set (v1, v2 -- see detect_iforest.py).
4. For a grid of score-percentile thresholds, replay the held-out slice
   through the real `IForestDetector` + `EventTracker` (5 s gap merge) and
   count false-alarm events/hour, then inject synthetic +150/+300/+800/+1500 W,
   60 s steps into copies of the held-out slice and measure forest detection
   + latency (same real classes) plus the `RuleDetector`'s.
5. Pick the (feature_set, threshold) with the highest injection detection
   rate at <= 1 false-alarm event/hour (ties: fewer false alarms).
"""

import argparse
import os
import sqlite3
import tempfile
import time
from pathlib import Path

import numpy as np
import pandas as pd

import db as dbmod
from detect_iforest import FEATURE_SETS, MODEL_PATH, REPORT_PATH, features, score_series
from detect_rule import RuleDetector
from events import EventTracker

CONTAMINATION = 0.01
THRESHOLD_PCTLS = [0.1, 0.5, 1.0, 1.5, 2.0]
INJECTION_STEPS_W = [150, 300, 800, 1500]
INJECTION_DURATION_S = 60
INJECTION_START_OFFSET_S = 60
INJECTION_SLICE_SPAN_S = 200  # offset + duration + tail; keeps injection replays short
MIN_ROWS = 600


def _noop(pct, msg):
    pass


def _snapshot(db_path):
    """Read-only backup of db_path into a fresh scratch sqlite file. Returns
    (conn, tmp_dir) -- caller should close conn when done; tmp_dir is removed
    by the OS temp cleanup (best-effort, not critical for a short-lived tool).
    """
    tmp_dir = Path(tempfile.mkdtemp(prefix="tune_iforest_"))
    dest_path = tmp_dir / "snapshot.db"
    src = sqlite3.connect(f"file:{Path(db_path).as_posix()}?mode=ro", uri=True)
    dest = sqlite3.connect(dest_path)
    try:
        src.backup(dest)
    finally:
        src.close()
    return dest, tmp_dir


def _load_readings(conn, minutes=None):
    q = "SELECT ts, device_id, watts FROM readings ORDER BY ts"
    df = pd.read_sql_query(q, conn)
    if minutes and len(df):
        cutoff = df["ts"].max() - minutes * 60_000
        df = df[df["ts"] >= cutoff]
    return df.reset_index(drop=True)


def _excluded_rule_spans(ts, watts):
    """Rule-flagged event spans (start_ts, end_ts) over one device's series, via the real
    RuleDetector + EventTracker merge (same 5 s gap the live pipeline uses) -- used to drop
    spikes out of the training slice so the model isn't taught to call its own target
    events "normal".
    """
    if len(ts) == 0:
        return []
    rows = _replay_events(ts, watts, RuleDetector().step, "rule")
    return [(r["start_ts"], r["end_ts"]) for r in rows]


def _exclude_spans(g, spans):
    if not spans:
        return g
    ts = g["ts"].to_numpy()
    mask = np.zeros(len(g), dtype=bool)
    for start, end in spans:
        mask |= (ts >= start) & (ts <= end)
    return g[~mask]


def _split(df):
    """Split by row count over contiguous segments, per device: the first 70% of rows
    train, the last 30% are held out. Counting rows rather than elapsed time means a gap
    (any stretch with no readings, however long) never shifts where the cut falls --
    splitting by elapsed time instead let a ~90 min live ingest gap put the 70% cutoff
    *inside* the gap, so training got only ~26% of the rows (829 of 3,193) instead of 70%.
    Rows inside a rule-flagged span are excluded from the training half (held-out keeps
    them -- false-alarm counting needs the real idle/active mix), so the model is not
    trained on its own target spikes as if they were normal.
    """
    train_parts, held_parts = [], []
    for _, g in df.groupby("device_id"):
        g = g.sort_values("ts").reset_index(drop=True)
        cut = int(round(0.7 * len(g)))
        train_g, held_g = g.iloc[:cut], g.iloc[cut:]
        spans = _excluded_rule_spans(train_g["ts"].to_numpy(), train_g["watts"].to_numpy(float))
        train_parts.append(_exclude_spans(train_g, spans))
        held_parts.append(held_g)
    train = pd.concat(train_parts).sort_values("ts").reset_index(drop=True)
    held = pd.concat(held_parts).sort_values("ts").reset_index(drop=True)
    return train, held


def _train_model(df, feature_set):
    from sklearn.ensemble import IsolationForest

    X = pd.concat([
        features(g["ts"].to_numpy(), g["watts"].to_numpy(), feature_set)
        for _, g in df.groupby("device_id")
    ])
    model = IsolationForest(n_estimators=200, contamination=CONTAMINATION, random_state=0).fit(X.values)
    return model, X


def _replay_events(ts, watts, step_fn, method, device_id="backtest"):
    """Step a detector over (ts, watts) and merge flags into events via the real
    EventTracker (5 s gap), on a throwaway in-memory DB. Returns the event rows.
    Used for RuleDetector, which is already O(window) per step (small deque).
    """
    conn = dbmod.connect(":memory:")
    tracker = EventTracker(conn, device_id, method)
    for t, w in zip(ts, watts):
        # numpy scalars serialize as BLOB in sqlite3 (no adapter registered); cast to
        # native Python types so start_ts/end_ts come back as int, not bytes.
        t, w = int(t), float(w)
        flagged, score, base = step_fn(t, w)
        tracker.update(t, w, flagged, score, base)
    rows = conn.execute(
        "SELECT * FROM events WHERE device_id = ? AND method = ? ORDER BY start_ts", (device_id, method)
    ).fetchall()
    conn.close()
    return rows


def _forest_pass(ts, watts, model, feature_set, threshold):
    """Vectorized equivalent of stepping IForestDetector.step over every reading:
    same decision_function scores (proved equal in test_ml_score_series_matches_detector)
    without IForestDetector's O(n) feature recompute on every single step. Returns
    (flagged, scores, baseline) arrays; flagged is False for the first MIN_SAMPLES-1
    readings, matching the live detector's warmup gate.
    """
    from detect_iforest import MIN_SAMPLES

    scores = score_series({"model": model, "feature_set": feature_set}, ts, watts)
    s = pd.Series(np.asarray(watts, float), index=pd.to_datetime(np.asarray(ts), unit="ms"))
    baseline = s.rolling("600s").median().to_numpy()
    flagged = scores < threshold
    flagged[: MIN_SAMPLES - 1] = False
    return flagged, scores, baseline


def _merge_from_arrays(ts, watts, flagged, scores, baseline, method, device_id="backtest"):
    conn = dbmod.connect(":memory:")
    tracker = EventTracker(conn, device_id, method)
    for i in range(len(ts)):
        tracker.update(int(ts[i]), float(watts[i]), bool(flagged[i]), float(scores[i]), float(baseline[i]))
    rows = conn.execute(
        "SELECT * FROM events WHERE device_id = ? AND method = ? ORDER BY start_ts", (device_id, method)
    ).fetchall()
    conn.close()
    return rows


def _false_alarms_per_hour(held, model, feature_set, threshold):
    total_events, total_ms = 0, 0
    for _, g in held.groupby("device_id"):
        if len(g) < 2:
            continue
        g = g.sort_values("ts")
        ts, watts = g["ts"].to_numpy(), g["watts"].to_numpy(float)
        flagged, scores, baseline = _forest_pass(ts, watts, model, feature_set, threshold)
        rows = _merge_from_arrays(ts, watts, flagged, scores, baseline, "iforest")
        total_events += len(rows)
        total_ms += int(ts[-1] - ts[0])
    idle_hours = total_ms / 3_600_000 if total_ms else 0.0
    fa_per_hour = total_events / idle_hours if idle_hours > 0 else 0.0
    return total_events, idle_hours, fa_per_hour


def _primary_slice(held):
    """The held-out device with the most rows, as (ts, watts) -- the slice
    synthetic injections are copied into. Truncated to INJECTION_SLICE_SPAN_S
    (offset + duration + tail) so the injection replays stay cheap.
    """
    best = max((g for _, g in held.groupby("device_id")), key=len)
    best = best.sort_values("ts")
    ts, watts = best["ts"].to_numpy(), best["watts"].to_numpy(float)
    mask = (ts - ts[0]) <= INJECTION_SLICE_SPAN_S * 1000
    return ts[mask], watts[mask]


def _inject(ts, watts, step_w, duration_s=INJECTION_DURATION_S, start_offset_s=INJECTION_START_OFFSET_S):
    watts = watts.copy()
    t0 = ts[0]
    offset_ms = min(start_offset_s * 1000, int((ts[-1] - ts[0]) * 0.3))
    start_idx = int(np.searchsorted(ts, t0 + offset_ms))
    start_idx = min(start_idx, len(ts) - 2)
    inj_start_ts = ts[start_idx]
    end_idx = int(np.searchsorted(ts, inj_start_ts + duration_s * 1000))
    watts[start_idx:end_idx] += step_w
    return ts, watts, int(inj_start_ts)


def _injection_result(ts, watts, inj_start_ts, duration_s, step_fn, method):
    rows = _replay_events(ts, watts, step_fn, method)
    window_end = inj_start_ts + duration_s * 1000 + 5000
    matches = [r for r in rows if inj_start_ts - 2000 <= r["start_ts"] <= window_end]
    if not matches:
        return False, None
    first = min(matches, key=lambda r: r["start_ts"])
    return True, max(0.0, (first["start_ts"] - inj_start_ts) / 1000)


def _forest_injections(base_ts, base_watts, model, feature_set, threshold):
    out, hits = [], 0
    for step_w in INJECTION_STEPS_W:
        ts, watts, inj_start = _inject(base_ts, base_watts, step_w)
        flagged, scores, baseline = _forest_pass(ts, watts, model, feature_set, threshold)
        rows = _merge_from_arrays(ts, watts, flagged, scores, baseline, "iforest")
        window_end = inj_start + INJECTION_DURATION_S * 1000 + 5000
        matches = [r for r in rows if inj_start - 2000 <= r["start_ts"] <= window_end]
        detected = bool(matches)
        latency_s = max(0.0, (min(r["start_ts"] for r in matches) - inj_start) / 1000) if matches else None
        hits += int(detected)
        out.append({"step_w": step_w, "duration_s": INJECTION_DURATION_S, "detected": detected, "latency_s": latency_s})
    return out, hits / len(INJECTION_STEPS_W)


def _rule_injections(base_ts, base_watts):
    out = []
    for step_w in INJECTION_STEPS_W:
        ts, watts, inj_start = _inject(base_ts, base_watts, step_w)
        rule = RuleDetector()
        detected, latency_s = _injection_result(ts, watts, inj_start, INJECTION_DURATION_S, rule.step, "rule")
        out.append({"step_w": step_w, "duration_s": INJECTION_DURATION_S, "detected": detected, "latency_s": latency_s})
    return out


def run(db_path, model_out, report_out, minutes=None, progress=_noop):
    progress(0, "snapshotting db")
    conn, tmp_dir = _snapshot(db_path)
    try:
        progress(5, "loading readings")
        df = _load_readings(conn, minutes)
        if len(df) < MIN_ROWS:
            raise SystemExit(f"only {len(df)} readings; need at least {MIN_ROWS}")

        progress(10, "splitting train/held-out")
        train, held = _split(df)
        base_ts, base_watts = _primary_slice(held)

        candidates = []
        models = {}
        rule_injections = _rule_injections(base_ts, base_watts)

        n_sets = len(FEATURE_SETS)
        for i, feature_set in enumerate(FEATURE_SETS):
            progress(15 + int(50 * i / n_sets), f"training {feature_set}")
            model, X_train = _train_model(train, feature_set)
            models[feature_set] = (model, X_train)
            train_scores = model.decision_function(X_train.values)

            for p in THRESHOLD_PCTLS:
                threshold = float(np.percentile(train_scores, p))
                progress(15 + int(50 * i / n_sets) + 2, f"backtest {feature_set} p{p}")
                _, _, fa_per_hour = _false_alarms_per_hour(held, model, feature_set, threshold)
                _, detection_rate = _forest_injections(base_ts, base_watts, model, feature_set, threshold)
                candidates.append({
                    "feature_set": feature_set, "threshold": threshold,
                    "false_alarms_per_hour": fa_per_hour, "detection_rate": detection_rate,
                })

        progress(70, "choosing configuration")
        within_budget = [c for c in candidates if c["false_alarms_per_hour"] <= 1.0]
        pool = within_budget or candidates
        chosen = max(pool, key=lambda c: (c["detection_rate"], -c["false_alarms_per_hour"]))
        feature_set, threshold = chosen["feature_set"], chosen["threshold"]
        model, X_train = models[feature_set]
        train_scores = model.decision_function(X_train.values)

        if within_budget:
            reason = (
                f"{feature_set} at threshold {threshold:.3f} has the highest injection detection rate "
                f"({chosen['detection_rate']*100:.0f}%) among configurations at or under 1 false alarm/hour "
                f"({chosen['false_alarms_per_hour']:.2f}/hr)."
            )
        else:
            reason = (
                f"no configuration stayed at or under 1 false alarm/hour; {feature_set} at threshold "
                f"{threshold:.3f} had the best detection rate ({chosen['detection_rate']*100:.0f}%) overall, "
                f"at {chosen['false_alarms_per_hour']:.2f} false alarms/hour."
            )

        progress(80, "final backtest + injections")
        false_alarm_events, idle_hours, fa_per_hour = _false_alarms_per_hour(held, model, feature_set, threshold)
        injections, _ = _forest_injections(base_ts, base_watts, model, feature_set, threshold)

        counts_arr, edges_arr = np.histogram(train_scores, bins=30)
        pctl = {
            "p0_1": float(np.percentile(train_scores, 0.1)),
            "p1": float(np.percentile(train_scores, 1)),
            "p5": float(np.percentile(train_scores, 5)),
            "p50": float(np.percentile(train_scores, 50)),
        }

        report = {
            "version": 1,
            # unix SECONDS, not ms -- unlike every other timestamp in this file (window.*
            # are readings.ts, which is ms). Matches detect_iforest.train's bundle (and the
            # /api/health iforest.trained_at contract this predates); kept as-is on purpose
            # rather than "fixed" to ms, since the model-status health check already expects
            # seconds here. Callers that put this in front of an LLM (assistant._model_status)
            # format it to a local string rather than passing the raw int either way.
            "trained_at": int(time.time()),
            "feature_set": feature_set,
            "features": FEATURE_SETS[feature_set],
            "rows": int(len(X_train)),
            "window": {"start_ts": int(train["ts"].min()), "end_ts": int(train["ts"].max())},
            "threshold": threshold,
            "contamination": CONTAMINATION,
            "score_hist": {"edges": edges_arr.tolist(), "counts": counts_arr.tolist()},
            "train_score_pctl": pctl,
            "backtest": {
                "idle_hours": idle_hours,
                "false_alarm_events": false_alarm_events,
                "false_alarms_per_hour": fa_per_hour,
                "injections": injections,
                "rule_injections": rule_injections,
            },
            "candidates": candidates,
            "chosen_reason": reason,
        }

        progress(90, "writing model + report")
        bundle = {
            "model": model, "threshold": threshold, "feature_set": feature_set,
            "features": FEATURE_SETS[feature_set], "trained_rows": int(len(X_train)),
            "trained_at": report["trained_at"],
        }
        _write_atomic_joblib(bundle, model_out)
        _write_atomic_json(report, report_out)
        progress(100, "done")
        return report
    finally:
        conn.close()


def _write_atomic_joblib(obj, path):
    import joblib

    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    joblib.dump(obj, tmp)
    os.replace(tmp, path)


def _write_atomic_json(obj, path):
    import json

    path = Path(path)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(obj, indent=2), encoding="utf-8", newline="\n")
    os.replace(tmp, path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--db", default=str(dbmod.DB_PATH))
    ap.add_argument("--out-model", default=str(MODEL_PATH))
    ap.add_argument("--out-report", default=str(REPORT_PATH))
    ap.add_argument("--minutes", type=int, default=None)
    args = ap.parse_args()

    def progress(pct, msg):
        print(f"[{pct:3d}%] {msg}")

    report = run(args.db, args.out_model, args.out_report, args.minutes, progress)
    print(f"chosen: {report['feature_set']} threshold={report['threshold']:.3f} -- {report['chosen_reason']}")


if __name__ == "__main__":
    main()
