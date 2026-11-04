# WattWatch

An unnoticed power spike at home, a space heater left on or a failing appliance, shows up on the bill a month later. WattWatch catches it live: a plug node streams power readings to a PC once a second, two detectors flag spikes within seconds, a local Llama 3.2 model explains each one in plain words, and a web console shows it all. Everything runs at home; no cloud.

Built for the *Build for Your World* theme. Video: **TODO: link**.

## Layout

| Folder | What it is |
|---|---|
| [`firmware/`](firmware) | Plug node sketch: Arduino Nano ESP32 + ADS1115 + CT clamp, true RMS on the node, JSON over USB serial |
| [`hub/`](hub) | Python hub: ingest, rule + Isolation Forest detectors, Llama 3.2 explainer, alerts, daily digest, FastAPI (REST + SSE) |
| [`web/`](web) | React + Vite console: live power, devices, nodes, alerts, energy, topology, assistant, model lab |

Each folder has its own README with setup and details.

## Quick start (Windows)

Needs Python 3.12, Node 20+ and [Ollama](https://ollama.com).

```powershell
ollama pull llama3.2:3b

cd web
npm install
npm run build

cd ..\hub
python -m venv .venv; .venv\Scripts\activate
pip install -r requirements.txt
python run_all.py --serial COM4     # live plug node on COM4
```

No hardware: run `python run_all.py` (ingest over HTTP on :8000), then `python simulate.py --auto 90` in a second terminal.

Open http://127.0.0.1:8080.

## Tests

```powershell
cd hub; python -m pytest tests -q      # 74 tests
cd web; npm run e2e                    # 113 Playwright tests
```
