"""Evaluates the explainer's prompt x model matrix against `eval/cases.json`
and writes `eval/explain_report.json`. The chosen (model, prompt) pair becomes
`llm.MODEL`'s default.

    python eval_explain.py
    python eval_explain.py --cases eval/cases.json --out eval/explain_report.json
"""

import argparse
import json
import re
import time
from pathlib import Path

import explain
import llm

CASES_PATH = Path(__file__).with_name("eval") / "cases.json"
REPORT_PATH = Path(__file__).with_name("eval") / "explain_report.json"
MODELS = ["llama3.2:1b", "llama3.2:3b"]
PROMPTS = ["v1", "v2"]
TIMEOUT_S = 30


def _sentences(text):
    return [s for s in re.split(r"(?<=[.!?])\s+", text.strip()) if s]


def _matches_any(text, candidates):
    t = text.lower()
    return any(c.lower() in t for c in candidates)


def _verdict_from_text(text):
    """Heuristic verdict read for the free-text v1 prompt (no structured field)."""
    t = text.lower()
    if any(k in t for k in ("worth checking", "worth a check", "should check", "check it")):
        return "check"
    if "normal" in t:
        return "normal"
    if "check" in t:
        return "check"
    return "normal"


def run_case_v1(case, model):
    messages = explain.build_messages_v1(case["input"])
    try:
        text, latency_ms = llm.chat(messages, model=model, timeout=TIMEOUT_S)
    except Exception as err:
        return {"latency_ms": 0, "format_ok": False, "appliance_ok": False,
                "verdict_ok": False, "faithful_ok": False, "error": str(err)}
    fmt_ok = bool(text.strip()) and len(_sentences(text)) <= 2
    return {
        "latency_ms": latency_ms,
        "format_ok": fmt_ok,
        "appliance_ok": _matches_any(text, case["expected_appliance_any"]),
        "verdict_ok": _verdict_from_text(text) == case["expected_verdict"],
        "faithful_ok": explain.faithful(text, case["input"]),
    }


def run_case_v2(case, model):
    messages = explain.build_messages_v2(case["input"])
    try:
        text, latency_ms = llm.chat(messages, model=model, format=explain.RESPONSE_SCHEMA, timeout=TIMEOUT_S)
        data = explain.parse_structured(text)
    except Exception as err:
        return {"latency_ms": 0, "format_ok": False, "appliance_ok": False,
                "verdict_ok": False, "faithful_ok": False, "error": str(err)}
    fmt_ok = bool(data["summary"].strip()) and len(_sentences(data["summary"])) <= 2
    return {
        "latency_ms": latency_ms,
        "format_ok": fmt_ok,
        "appliance_ok": _matches_any(data["appliance"], case["expected_appliance_any"]),
        "verdict_ok": data["verdict"] == case["expected_verdict"],
        "faithful_ok": explain.faithful(data["summary"], case["input"]),
    }


def run(cases, models=MODELS, prompts=PROMPTS, progress=lambda *a: None):
    variants = []
    for model in models:
        for prompt in prompts:
            run_case = run_case_v1 if prompt == "v1" else run_case_v2
            results = []
            for case in cases:
                r = run_case(case, model)
                results.append(r)
                progress(model, prompt, case["id"], r)
            n = len(results)
            appliance = sum(r["appliance_ok"] for r in results) / n
            verdict = sum(r["verdict_ok"] for r in results) / n
            faithful = sum(r["faithful_ok"] for r in results) / n
            fmt = sum(r["format_ok"] for r in results) / n
            latencies = sorted(r["latency_ms"] for r in results)
            p50 = latencies[len(latencies) // 2]
            p95_idx = min(len(latencies) - 1, int(round(len(latencies) * 0.95)) - 1 if len(latencies) >= 2 else 0)
            p95 = latencies[max(0, p95_idx)]
            composite = 0.35 * appliance + 0.25 * verdict + 0.25 * faithful + 0.15 * fmt
            variants.append({
                "model": model, "prompt_version": prompt,
                "appliance_accuracy": appliance, "verdict_accuracy": verdict,
                "faithfulness": faithful, "format_validity": fmt,
                "latency_p50_ms": p50, "latency_p95_ms": p95, "composite": round(composite, 4),
            })

    best = max(variants, key=lambda v: v["composite"])
    ties = [v for v in variants if best["composite"] - v["composite"] <= 0.02]
    chosen = min(ties, key=lambda v: v["latency_p95_ms"])

    return {"run_ts": int(time.time()), "cases": len(cases), "variants": variants, "chosen": chosen}


def write_report(report, path=REPORT_PATH):
    path = Path(path)
    path.write_text(json.dumps(report, indent=2), encoding="utf-8", newline="\n")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--cases", default=str(CASES_PATH))
    ap.add_argument("--out", default=str(REPORT_PATH))
    args = ap.parse_args()
    cases = json.loads(Path(args.cases).read_text())

    def progress(model, prompt, case_id, r):
        tag = "ok" if r.get("format_ok") else f"FAIL {r.get('error', '')}"
        print(f"  {model:14s} {prompt}  {case_id:30s} {tag}")

    report = run(cases, progress=progress)
    write_report(report, Path(args.out))
    c = report["chosen"]
    print(f"chosen: {c['model']} / prompt {c['prompt_version']} (composite {c['composite']:.3f}, "
          f"p95 {c['latency_p95_ms']} ms)")


if __name__ == "__main__":
    main()
