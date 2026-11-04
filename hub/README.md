# WattWatch hub

An unnoticed power spike at home, a space heater left on or a failing appliance, shows up on the bill a month later. WattWatch catches it live: a plug node streams power readings to a PC once a second, two detectors flag spikes within seconds, a local Llama 3.2 model explains each one in plain words, and a web console shows it all. Everything runs at home; no cloud.

Built for the *Build for Your World* theme. Video: **TODO: link**.

Part of the WattWatch monorepo: see also [`firmware`](../firmware) (the plug node) and [`web`](../web) (the console this hub serves).

## Architecture

```
 Plug node ──1 reading/s──▶ ingest.py ──▶ SQLite energy.db ◀──▶ detect.py (rule + Isolation Forest)
 ESP32+ADS1115       serial or HTTP        readings, events,  ◀──▶ explain.py (Llama 3.2, structured)
                                           alerts, telemetry  ◀──▶ alerts.py (rules -> alerts)
                                                  ▲           ◀──▶ digest.py (daily AI digest)
                                                  │
                         web console ◀── api.py (REST + SSE stream, serves ../web/dist)
```

Ingest is the only process that writes readings; the detector and explainer only write events; the API reads everything and writes only console state (device names, alert status, rules, settings, audit log). SQLite runs in WAL mode, so any part can crash and restart without losing data. Every process reports a heartbeat, shown on the console's System page.

## Setup

Windows PC with Python 3.12, Node 20+ and [Ollama](https://ollama.com):

```powershell
python -m venv .venv; .venv\Scripts\activate
pip install -r requirements.txt
ollama pull llama3.2:3b
cd ..\web; npm install; npm run build; cd ..\hub     # builds the console the API serves
python run_all.py --serial COM4                       # or plain `python run_all.py` for Wi-Fi POSTs
```

Then open **http://127.0.0.1:8080**. Close the Arduino Serial Monitor first: only one program can hold the COM port. `run_all.py` starts ingest, detect, explain, alerts, digest and the API, and restarts any that exit.

After 30–60 minutes of normal readings, train the Isolation Forest from the console (**Model lab → Retrain model**) or from the shell; the running detector picks it up without a restart:

```powershell
python tune_iforest.py --db energy.db --out-model model.joblib --out-report model_report.json
```

No hardware? `python simulate.py --auto 90` posts fake readings with a kettle switching on every 90 s, and `python seed_demo.py --db demo.db --follow` builds a three-device demo site that keeps streaming.

Tests: `pip install -r requirements-dev.txt` then `python -m pytest tests -q`.

| Setting | Default | Purpose |
|---|---|---|
| `OLLAMA_MODEL` | `llama3.2:3b` | `llama3.2:1b` if the CPU is slow |
| `OLLAMA_URL` | `http://127.0.0.1:11434` | |
| `ENERGY_DB` | `./energy.db` | |
| `CT_CAL` | `1.0` | multiplier on the node's `irms_raw_a`, from a known-load check |
| `IFOREST_THRESHOLD` | saved with the model (0) | flag when the score is below this |

## How detection works

**Layer 1, rule** (`detect_rule.py`). Rolling median and MAD of watts over the last 120 unflagged seconds. A second is flagged when the robust z-score `(watts − median) / (1.4826 × MAD)` exceeds 6 **and** watts are more than 200 W above the median. The absolute floor stops idle-noise false alarms when MAD is near zero, but it also means a step under ~200 W (e.g. a 150 W appliance from an ~80 W baseline) never trips the rule layer -- that gap is exactly what the forest layer is for. Because flagged seconds stay out of the baseline, a long kettle boil does not end its own event.

**Layer 2, Isolation Forest** (`detect_iforest.py`, tuned by `tune_iforest.py`). scikit-learn `IsolationForest(n_estimators=200, contamination=0.01, random_state=0)`. Two feature sets are trained and backtested (`detect_iforest.FEATURE_SETS`):

- **v1** (absolute): `watts`, 1 s change, 30 s rolling mean, 30 s rolling std, watts ÷ 10-min median.
- **v2** (scale-relative): `log1p(watts)`, 1 s delta ÷ 2-min median, 30 s std ÷ 2-min median, watts ÷ 10-min median, watts − 2-min median. Built so the same shape of event scores similarly whether the baseline is 80 W or 800 W.

`tune_iforest.run` snapshots the DB (sqlite backup API, never a live write lock), splits each device's readings 70/30 by row count (so ingest gaps don't skew the split) and drops rule-flagged spans from the training half, trains both feature sets on the first 70%, then backtests a threshold grid (score percentiles 0.1-2%) against the held-out 30% by replaying it through the real `IForestDetector` + `EventTracker` (5 s merge) and counting false-alarm events/hour. It also injects synthetic +150/+300/+800/+1500 W, 60 s steps into copies of the held-out slice and measures detection + latency for both the forest and the rule layer. The config with the highest injection detection rate at ≤ 1 false alarm/hour wins (ties: fewer false alarms); see "Test results" below for the numbers from the live DB. `IForestDetector`/`detect.py` honor whichever `feature_set` the loaded `model.joblib` bundle names, so the live detector hot-loads a new feature set without a restart.

`python tune_iforest.py --db energy.db --out-model model.joblib --out-report model_report.json [--minutes N]` writes `model.joblib` and `model_report.json` atomically (temp file + `os.replace`); the running `detect.py` picks up the new model by `mtime`, no restart needed. `python detect_iforest.py scores` still works for an ad hoc percentile check.

**Events.** Flagged seconds less than 5 s apart merge into one event with start, end, peak W, baseline W, score and method. The explainer (`explain.py`) picks up events with no explanation and asks Llama for a structured verdict (see "AI" below), falling back to a template line on failure so the dashboard is never blank.

## Test results

**r1 fix (BK-3):** the original run below split train/held-out by *time*: the live stream's ~90 min ingest gap put the 70% time cutoff inside the gap itself, so training got only 829 of 3,193 rows (26%) instead of 70%. `tune_iforest._split` now splits by **row count** per device (a gap, however long, adds no rows either side, so it can't shift the cut) and excludes any rule-flagged span from the training half, so the model is never taught to call its own target spikes "normal". Retrained against the same live `energy.db` (still 3,193 readings; no new ingestion since the original run):

| Candidate | False alarms / hour | Injection detection rate |
|---|---|---|
| v1, threshold -0.055 (**chosen**) | 0.00 | 100% |
| v2, various thresholds | 0.00-1.40 | 0-100% |

**Chosen: feature set v1, threshold -0.055, trained on 2,235 rows (70% of 3,193).** 0 false-alarm events over 0.27 idle hours; 100% injection detection on the forest, ~0 s latency on every magnitude:

| step | Isolation Forest | Rule |
|---|---|---|
| +150 W / 60 s | detected, 0.0 s | **missed** (under the rule's 200 W floor) |
| +300 W / 60 s | detected, 0.0 s | detected, 0.0 s |
| +800 W / 60 s | detected, 0.0 s | detected, 0.0 s |
| +1500 W / 60 s | detected, 0.0 s | detected, 0.0 s |

The rule's absolute 200 W floor is by design (it keeps idle noise from false-triggering), but it means the forest is strictly more sensitive to small steps -- the +150 W case is exactly the gap the second layer closes. Full detail (score histogram, training percentiles, every candidate) is in `model_report.json`.

`model.joblib`/`model_report.json` were replaced atomically (snapshot of `energy.db` read-only via the sqlite backup API, write to a `.tmp`, then `os.replace`) -- no partial file was ever on disk. The live hub was not ingesting at the time of this retrain (no fresh readings, no `service_status` rows), so there was no running `detect.py` to hot-load the model or to flood-check; re-verify read-only for a few minutes once ingestion resumes.

```powershell
python tune_iforest.py --db energy.db --out-model model.joblib --out-report model_report.json
```

## AI

**Structured explainer, prompt v2** (`explain.py`). Each event gets a JSON reply from Llama (`format` is an Ollama JSON schema): `{appliance, confidence: low|medium|high, verdict: normal|check, summary}`. The prompt includes the device's name/kind/room/rated_w when known (from the `devices` table), local time, duration (or `running_for_s` + `still_running`), and how many similar events happened earlier today, plus 3 few-shot examples. `summary` must be at most two sentences, and every number in it must already appear in the input (±1 for rounding) -- a reply that invents a number is rejected, retried once at temperature 0, then replaced with the old template line (`fallback=1`). Every event gets a row in `explanations` (structured) and keeps writing `events.explanation` (the `summary`) for compatibility. Prompt v1 (the original two-sentence, unstructured prompt) is kept only so `eval_explain.py` can score it against v2.

**Eval harness** (`eval_explain.py`, `eval/cases.json`). 20 hand-written cases (kettle, toaster, microwave, hair dryer, a 30-min space heater, a 150 W fridge compressor, an unknown 250 W step at 03:00, a 3 kW load, a 60 W step, still-running cases, a named device, repeated events) scored across the matrix {prompt v1, v2} x {`llama3.2:1b`, `llama3.2:3b`} for format validity, number faithfulness, appliance accuracy (case-insensitive substring of any expected value) and verdict accuracy, composited as `0.35*appliance + 0.25*verdict + 0.25*faithful + 0.15*format` (ties within 0.02 broken by lower p95 latency). Results, from the live Ollama instance:

| Model | Prompt | Appliance | Verdict | Faithful | Format | p50 ms | p95 ms | Composite |
|---|---|---|---|---|---|---|---|---|
| llama3.2:1b | v1 | 0.30 | 0.70 | 0.80 | 1.00 | 329 | 2015 | 0.630 |
| llama3.2:1b | v2 | 0.35 | 0.70 | 0.70 | 1.00 | 1218 | 1531 | 0.623 |
| llama3.2:3b | v1 | 0.40 | 0.50 | 1.00 | 1.00 | 1828 | 2421 | 0.665 |
| **llama3.2:3b** | **v2** | **0.70** | **0.65** | **0.90** | **1.00** | **2078** | **2920** | **0.783** |

`llama3.2:3b` with prompt v2 wins clearly (0.783 vs. the next best 0.665) and is `llm.MODEL`'s default. Re-run with `python eval_explain.py`; writes `eval/explain_report.json`.

**Ask WattWatch** (`assistant.py`). `build_context(conn, now_ms)` assembles one JSON snapshot -- site name, every device's today/7-day kWh/cost/peak/baseline, node health, the last 10 incidents with their AI summaries, open alerts, hourly kWh today, yesterday/month-to-date totals, the price/CO2 settings and model status -- and `answer_stream` streams Llama's reply token by token (`llm.chat_stream`), grounded only in that context (120 words max, quotes numbers verbatim, says what's missing rather than guessing).

**Daily digest** (`digest.py`). `generate` builds the same context, asks Llama for a 3-5 sentence summary, and inserts an `insights` row titled e.g. `Today so far: 1.9 kWh, $0.28`. `python digest.py` regenerates whenever today has none yet, or the last one is over 60 min old; it raises on an LLM failure so a bad digest never overwrites the last good one.

## Console (WattWatch)

A read-mostly JSON API (`api.py`, FastAPI) and an alert worker (`alerts.py`) sit on top of the
same `energy.db`, in their own tables (`devices`, `alert_rules`, `alerts`, `settings`,
`topology`). Neither ever writes `readings` or `events`.

```powershell
python api.py --port 8080      # http://127.0.0.1:8080
python alerts.py                # evaluates alert_rules every 2 s
```

`run_all.py` starts both alongside ingest/detect/explain. The console itself lives in
`../web` (Vite + React): `npm run build` there produces `web/dist`, which `api.py` serves at
`/`; without a build, `api.py` returns `{"detail": "web/dist not built; ..."}` at `/`. In
development, run `npm run dev` in `../web` instead (proxies `/api` to `api.py`).

`seed_demo.py` builds a demo/test database (three devices, 24 h of 1 Hz readings, events with
explanations) for tests and local console development without touching the live `energy.db`:

```powershell
python seed_demo.py --db demo.db --hours 24
python seed_demo.py --db demo.db --hours 24 --follow   # then keep appending live data
```

`--follow` seeds as usual and then keeps running: it appends one reading/second to every
device except the (deliberately offline) Fridge, with idle noise and a kettle boil (1480 W,
90 s) every 4 min, writing a matching `rule` + `iforest` event for each boil so `alerts.py`
has something live to alert on. Appending starts within ~1 s of launch. It is meant to be
spawned as a long-running background process (e.g. by a dev/e2e harness) and exits cleanly
on `SIGTERM`, `SIGINT`, or if the process that spawned it goes away (polled, not signal-based,
since a plain `kill`/`TerminateProcess` on Windows cannot deliver a catchable signal).

Alert rule kinds, evaluated once per pass of `alerts.py`:

| kind | triggers when | resolves |
|---|---|---|
| `spike` | a `rule`-method event opens (no existing alert for that event+rule) | never (user acks/resolves); severity bumps to `critical` if `peak_w > 1.25 * rated_w` |
| `anomaly` | an `iforest`-method event opens, unless a `rule` event on the same device overlaps it (per the incidents merge rule below) -- that incident already has a spike alert | never (user acks/resolves) |
| `over_power` | every reading in the last `duration_s` is above `threshold` | latest reading drops to/below `threshold` |
| `offline` | no reading for longer than `settings.offline_after_s` | a fresh reading arrives |
| `daily_energy` | kWh so far today exceeds `threshold` | never (one alert per device per local day) |
| `always_on` | the minimum watts over the last `duration_s` (≥ 90 % reading coverage) stays above `threshold` | the minimum drops to/below `threshold` |

A spike/anomaly alert's `opened_ts` is the triggering event's `start_ts` (when the spike
happened), not the time the worker pass ran -- otherwise every alert reads "opened Ns ago"
with the same N after any restart.

**Incidents.** `GET /api/incidents` (`store.incidents`) merges `events` rows on the same
device whose `[start_ts, end_ts]` ranges overlap or sit within 10 s of each other into one
incident, so a kettle boil that both the rule and the Isolation Forest flag shows up once
instead of twice. Each incident reports `methods` (which detector(s) caught it), separate
`rule_score`/`iforest_score`, and an `explanation` (the rule event's if present, else the
iforest event's). `/api/alerts` exposes the same idea per alert as `detectors`: a spike
alert lists `"iforest"` too when an overlapping iforest event exists, even though no second
alert was opened for it.

Tests: `pip install -r requirements-dev.txt`, then `pytest tests -q`. Tests never touch
`energy.db`; they run against a `tmp_path` SQLite file via `ENERGY_DB`.

## Limits

- `watts` is apparent power: current × an assumed 120 V. Power factor is ignored.
- One plug node.
- The thresholds were tuned on one home's appliances.
