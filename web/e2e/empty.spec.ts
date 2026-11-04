// Every page against a genuinely empty DB (no devices, no readings, no
// events, no alerts beyond the seeded default rules) on :8092. Confirms
// Review Focus #2: every endpoint and every page handles an empty DB
// cleanly, with no console errors.
import { expect, test } from "./fixtures";

const BASE = "http://127.0.0.1:8092";

test("overview renders empty states", async ({ page }) => {
  await page.goto(`${BASE}/`);
  await expect(page.getByTestId("home-chart-empty")).toBeVisible();
  await expect(page.getByTestId("empty-state").first()).toBeVisible();
  await expect(page.getByText("No devices yet.")).toBeVisible();
  await expect(page.getByText("No alerts.")).toBeVisible();
  await expect(page.getByTestId("home-digest-empty")).toBeVisible();
  await expect(page.getByTestId("home-node-health-empty")).toBeVisible();
});

test("live renders empty states", async ({ page }) => {
  await page.goto(`${BASE}/live`);
  await expect(page.getByText("No devices yet.")).toBeVisible();
  await expect(page.getByTestId("live-chart-empty")).toBeVisible();
  await expect(page.getByTestId("live-ticker-empty")).toBeVisible();
  await expect(page.getByTestId("live-raw-empty")).toBeVisible();
});

test("nodes renders empty state", async ({ page }) => {
  await page.goto(`${BASE}/nodes`);
  await expect(page.getByText("No nodes yet.")).toBeVisible();
});

test("analytics renders empty states", async ({ page }) => {
  await page.goto(`${BASE}/analytics`);
  await expect(page.getByTestId("analytics-bars-empty")).toBeVisible();
  await expect(page.getByTestId("analytics-heatmap-empty")).toBeVisible();
  await expect(page.getByTestId("analytics-donut-empty")).toBeVisible();
});

test("system renders with no audit entries", async ({ page }) => {
  await page.goto(`${BASE}/system`);
  await expect(page.getByTestId("service-grid")).toBeVisible();
  await expect(page.getByTestId("audit-empty")).toBeVisible();
});

test("devices page renders empty state", async ({ page }) => {
  await page.goto(`${BASE}/devices`);
  await expect(page.getByText("No devices yet.")).toBeVisible();
});

test("device profile for an unknown id renders not-found", async ({ page }) => {
  await page.goto(`${BASE}/devices/does-not-exist`);
  await expect(page.getByText("Device not found.")).toBeVisible();
});

test("alerts page renders empty state", async ({ page }) => {
  await page.goto(`${BASE}/alerts`);
  await expect(page.getByText("No alerts.")).toBeVisible();
});

test("topology page renders just the hub on an empty DB", async ({ page }) => {
  // _build_topology (hub/api.py) always emits the "hub" node, even with
  // zero devices registered -- there's always a physical hub PC. So an
  // empty DB's topology isn't an "empty state"; it's a canvas with exactly
  // one node.
  await page.goto(`${BASE}/topology`);
  await expect(page.getByTestId("topology-canvas")).toBeVisible();
  await expect(page.locator(".react-flow__node")).toHaveCount(1);
  await expect(page.getByTestId("topology-node").filter({ hasText: "Hub PC" })).toBeVisible();
});

test("settings page renders with defaults and seeded default rules", async ({ page }) => {
  await page.goto(`${BASE}/settings`);
  await expect(page.getByTestId("settings-form")).toBeVisible();
  await expect(page.getByTestId("settings-price")).toHaveValue("0.15");
  await expect(page.getByTestId("settings-site-name")).toHaveValue("Home");
  await expect(page.getByTestId("rules-table")).toBeVisible();
  // Six v1 default rules plus v2's seeded "Hardware limit" rule.
  await expect(page.getByTestId("rule-row")).toHaveCount(7);
  await expect(page.getByTestId("settings-integrations")).toBeVisible();
});

test("not found route renders", async ({ page }) => {
  await page.goto(`${BASE}/nope-not-a-route`);
  await expect(page.getByTestId("page-notfound")).toBeVisible();
});
