import os from "node:os";
import path from "node:path";
import { defineConfig, devices } from "@playwright/test";

// Scratch DBs live outside the repo; override with WATTWATCH_E2E_DIR.
const SCRATCH = (process.env.WATTWATCH_E2E_DIR || path.join(os.tmpdir(), "wattwatch-e2e")) + "/";

// Three independent backends, each serving the built site (../web/dist)
// over its own hub/api.py (+ hub/alerts.py where noted) against its own
// scratch DB:
//   8091 - seeded demo data, live-following (console.spec.ts)
//   8092 - empty DB, never seeded (empty.spec.ts)
//   8093 - one device, mostly-stale sparse data (sparse.spec.ts)
// None ever touches hub/energy.db or hub/model.joblib (serve.mjs pins
// ENERGY_DB/ENERGY_MODEL at scratch paths). Specs use absolute URLs rather
// than `baseURL` since the backends live on different ports.
export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: !!process.env.CI,
  retries: 0,
  workers: 1,
  reporter: [["list"]],
  timeout: 30_000,
  expect: { timeout: 10_000 },
  use: {
    trace: "retain-on-failure",
  },
  projects: [
    {
      name: "desktop",
      use: { ...devices["Desktop Chrome"], viewport: { width: 1280, height: 800 } },
    },
    {
      name: "mobile",
      use: { ...devices["Pixel 7"] },
    },
  ],
  webServer: [
    {
      command: `node e2e/serve.mjs --port 8091 --db "${SCRATCH}e2e.db" --seed --hours 24 --alerts`,
      url: "http://127.0.0.1:8091/api/health",
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `node e2e/serve.mjs --port 8092 --db "${SCRATCH}e2e-empty.db"`,
      url: "http://127.0.0.1:8092/api/health",
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
    {
      command: `node e2e/serve.mjs --port 8093 --db "${SCRATCH}e2e-sparse.db" --sparse`,
      url: "http://127.0.0.1:8093/api/health",
      timeout: 60_000,
      reuseExistingServer: false,
      stdout: "pipe",
      stderr: "pipe",
    },
  ],
});
