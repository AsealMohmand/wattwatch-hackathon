"""Start every hub service (ingest, detect, explain, api, alerts, digest); Ctrl+C stops all.

    python run_all.py                 # ingest over HTTP on :8000
    python run_all.py --serial COM4   # ingest over USB serial instead

The console is then at http://127.0.0.1:8080 (build ../web first).
"""

import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).parent


def main():
    ingest = [sys.executable, "ingest.py", *sys.argv[1:]]
    cmds = {
        "ingest": ingest,
        "detect": [sys.executable, "detect.py"],
        "explain": [sys.executable, "explain.py"],
        "api": [sys.executable, "api.py"],
        "alerts": [sys.executable, "alerts.py"],
        "digest": [sys.executable, "digest.py"],
    }
    procs = {name: subprocess.Popen(cmd, cwd=HERE) for name, cmd in cmds.items()}
    print("WattWatch console: http://127.0.0.1:8080")
    try:
        while True:
            for name, p in procs.items():
                if p.poll() is not None:
                    print(f"{name} exited ({p.returncode}); restarting")
                    procs[name] = subprocess.Popen(cmds[name], cwd=HERE)
            time.sleep(2)
    except KeyboardInterrupt:
        pass
    finally:
        for p in procs.values():
            p.terminate()


if __name__ == "__main__":
    main()
