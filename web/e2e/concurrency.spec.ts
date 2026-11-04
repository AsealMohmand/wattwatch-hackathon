// Fires 50 parallel GETs spread across the read endpoints the console
// polls most often, against the seeded backend on :8091. The per-thread
// SQLite connection fix in hub/api.py (_ThreadConn) exists specifically so
// this never produces a sporadic 500 under concurrent load.
import { expect, test } from "@playwright/test";

const BASE = "http://127.0.0.1:8091";
const PATHS = ["/api/overview", "/api/alerts", "/api/devices", "/api/topology"];

test("50 parallel requests across overview/alerts/devices/topology all return 200", async ({ request }) => {
  const calls = Array.from({ length: 50 }, (_, i) => request.get(`${BASE}${PATHS[i % PATHS.length]}`));
  const responses = await Promise.all(calls);
  const statuses = responses.map((r) => r.status());
  expect(statuses.every((s) => s === 200), `statuses: ${statuses.join(",")}`).toBe(true);
});
