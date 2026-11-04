// Orchestrates one e2e backend: seeds a fresh scratch DB (or leaves it empty),
// starts hub/api.py and (optionally) hub/alerts.py against it, waits for
// /api/health, and kills every child when this process exits.
//
// Usage: node e2e/serve.mjs --port 8091 --db <scratch>/e2e.db --seed --hours 24 --alerts
//    or: node e2e/serve.mjs --port 8093 --db <scratch>/e2e-sparse.db --sparse
//
// --sparse builds a one-device, mostly-stale scratch DB via
// web/e2e/seed_sparse.py (for sparse.spec.ts) instead of seeding the full
// demo scenario.
//
// --seed runs `seed_demo.py --follow`: it builds the initial --hours of
// history, then keeps appending a reading a second (idle noise + a kettle
// boil every 4 min) to every device but the offline Fridge until this
// process kills it. That's what keeps the status pill reading "Live" in
// screenshots instead of "Stale" — there's no need to (and this script no
// longer does) raise offline_after_s to paper over data going stale mid-run.
//
// Never touches hub/energy.db or hub/model.joblib: the
// DB path is always a scratch file passed on the command line, and
// ENERGY_MODEL is pointed at a scratch path so the health route's model
// probe never opens the live model file.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const args = process.argv.slice(2);
function argVal(name, def) {
  const i = args.indexOf(`--${name}`);
  return i === -1 ? def : args[i + 1];
}
function hasFlag(name) {
  return args.includes(`--${name}`);
}

const PORT = argVal("port", "8091");
const DB = argVal("db");
const HOURS = argVal("hours", "24");
const SEED = hasFlag("seed");
const SPARSE = hasFlag("sparse");
const ALERTS = hasFlag("alerts");

if (!DB) {
  console.error("serve.mjs: --db <path> is required");
  process.exit(1);
}

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HUB = path.resolve(HERE, "..", "..", "hub");
// Scratch files live outside the repo; override with WATTWATCH_E2E_DIR.
const SCRATCH = process.env.WATTWATCH_E2E_DIR || path.join(os.tmpdir(), "wattwatch-e2e");
mkdirSync(SCRATCH, { recursive: true });
// Python with hub/requirements.txt installed; override with WATTWATCH_PYTHON.
const PY = process.env.WATTWATCH_PYTHON || (process.platform === "win32" ? "python" : "python3");
const MODEL = path.join(SCRATCH, `e2e-model-${PORT}.joblib`);
const MODEL_REPORT = path.join(SCRATCH, `e2e-model-report-${PORT}.json`);

// Fresh DB every run, including any WAL/SHM siblings from a previous run.
for (const suffix of ["", "-wal", "-shm"]) {
  const p = DB + suffix;
  if (existsSync(p)) rmSync(p);
}

const env = {
  ...process.env,
  ENERGY_DB: DB,
  ENERGY_MODEL: MODEL,
  ENERGY_MODEL_REPORT: MODEL_REPORT,
};

const children = [];

function spawnChild(label, scriptArgs) {
  const child = spawn(PY, scriptArgs, { cwd: HUB, env, stdio: "inherit" });
  child.on("exit", (code, signal) => {
    console.log(`serve.mjs: ${label} exited (code=${code} signal=${signal})`);
  });
  children.push(child);
  return child;
}

if (SPARSE) {
  // A one-shot, quick build (web/e2e/seed_sparse.py, not hub code) --
  // unlike --seed's --follow loop this finishes and exits on its own, so
  // it's run synchronously rather than tracked as a long-lived child.
  console.log(`serve.mjs: building the sparse scratch DB at ${DB}`);
  const res = spawnSync(PY, [path.join(HERE, "seed_sparse.py"), "--db", DB], { cwd: HERE, stdio: "inherit" });
  if (res.status !== 0) {
    console.error("serve.mjs: seed_sparse.py failed");
    process.exit(1);
  }
} else if (SEED) {
  console.log(`serve.mjs: seeding ${DB} (${HOURS}h) and following with live demo data`);
  spawnChild("seed", [path.join(HUB, "seed_demo.py"), "--db", DB, "--hours", HOURS, "--follow"]);
  // The initial --hours backfill is a synchronous part of this same
  // process, bounded at < 10s per hub/README; wait past that margin
  // before starting the API so the first page load never races an empty
  // DB. The --follow loop that runs after keeps appending in the
  // background once the API is up.
  await new Promise((r) => setTimeout(r, 12_000));
}

spawnChild("api", [path.join(HUB, "api.py"), "--port", PORT]);
if (ALERTS) {
  spawnChild("alerts", [path.join(HUB, "alerts.py")]);
}

let cleaned = false;
function cleanup() {
  if (cleaned) return;
  cleaned = true;
  for (const c of children) {
    try {
      if (!c.killed) c.kill();
    } catch {
      // already gone
    }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => {
  cleanup();
  process.exit(0);
});
process.on("SIGTERM", () => {
  cleanup();
  process.exit(0);
});

const healthUrl = `http://127.0.0.1:${PORT}/api/health`;
const deadline = Date.now() + 30_000;

async function waitForHealth() {
  while (Date.now() < deadline) {
    try {
      const res = await fetch(healthUrl);
      if (res.ok) {
        console.log(`serve.mjs: ${healthUrl} is up`);
        return true;
      }
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  console.error(`serve.mjs: ${healthUrl} did not come up in time`);
  cleanup();
  process.exit(1);
  return false;
}

// `--follow` keeps feeding real readings for the run's duration (idle noise
// plus a kettle boil every 4 min on every device but the offline Fridge),
// so the default offline_after_s needs no e2e-only override: Kettle/heater
// stay genuinely live and the status pill reads "Live", not "Stale".
await waitForHealth();
