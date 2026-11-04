// End-to-end tests against the seeded demo backend on :8091 (hub/api.py +
// hub/alerts.py over a scratch DB seeded by seed_demo.py, started by
// e2e/serve.mjs via playwright.config.ts's webServer). Every test fails on
// any console.error or pageerror (see ./fixtures.ts).
import { expect, test } from "./fixtures";
import { deviceColor } from "../src/lib/chartPalette";

const BASE = "http://127.0.0.1:8091";

test.describe("overview", () => {
  test("shows non-zero total watts, 3 device cards, and a rendered power chart", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await expect(page.getByTestId("device-card")).toHaveCount(3);

    const wattsText = await page.getByTestId("stat-total-w").locator(".font-mono-nums").first().innerText();
    const watts = Number(wattsText.replace(/,/g, ""));
    expect(watts).toBeGreaterThan(0);

    await expect(page.getByTestId("power-chart").locator("svg").first()).toBeVisible();
  });

});

test.describe("analytics", () => {
  // r1 finding #8 / FA-4: a device's series now uses the same palette
  // color everywhere -- these stacked bars, the donut and both legends --
  // instead of copper shades here colliding with device hues in the donut
  // for the same device. Copper stays reserved for single-series totals.
  test("stacked kWh bars render in the device palette color, matching the legend", async ({ page }) => {
    await page.goto(`${BASE}/analytics`);
    const chart = page.getByTestId("analytics-stacked-bars");
    await expect(chart).toBeVisible();
    const bar = chart.locator("path.recharts-rectangle").first();
    await expect(bar).toBeVisible();
    await expect(page.getByTestId("analytics-bars-legend")).toBeVisible();

    const { barFill, deviceRgb } = await page.evaluate((hex: string) => {
      const el = document.querySelector('[data-testid="analytics-stacked-bars"] path.recharts-rectangle') as SVGPathElement;
      const fill = getComputedStyle(el).fill;
      const probe = document.createElement("div");
      probe.style.color = hex;
      document.body.appendChild(probe);
      const rgb = getComputedStyle(probe).color;
      probe.remove();
      return { barFill: fill, deviceRgb: rgb };
    }, deviceColor(0));

    expect(barFill).toBe(deviceRgb);
  });

  test("heatmap, donut and export links render", async ({ page }) => {
    await page.goto(`${BASE}/analytics`);
    await expect(page.getByTestId("analytics-heatmap")).toBeVisible();
    await expect(page.getByTestId("heatmap-cell").first()).toBeVisible();
    await expect(page.getByText("Share by device")).toBeVisible();
    await expect(page.getByTestId("breakdown-table")).toBeVisible();
    await expect(page.getByTestId("export-readings-csv")).toHaveAttribute("href", /export\/readings\.csv/);
    await expect(page.getByTestId("export-events-csv")).toHaveAttribute("href", /export\/events\.csv/);
  });
});

test.describe("live", () => {
  test("device tiles, strip chart and raw telemetry render; pause stops the ticker", async ({ page }) => {
    await page.goto(`${BASE}/live`);
    await expect(page.getByTestId("live-device-tile")).toHaveCount(3);
    await expect(page.getByTestId("live-raw-table")).toBeVisible();
    await expect(page.getByTestId("live-pause-toggle")).toBeVisible();
    await page.getByTestId("live-pause-toggle").click();
    await expect(page.getByTestId("live-pause-toggle")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("live-pause-toggle").click();
  });
});

test.describe("nodes", () => {
  test("node list shows ww-01 and ww-02; node detail shows ports and mapped devices", async ({ page }) => {
    await page.goto(`${BASE}/nodes`);
    await expect(page.getByTestId("node-card")).toHaveCount(2);

    await page.getByTestId("node-card").filter({ hasText: "ww-01" }).click();
    await expect(page).toHaveURL(`${BASE}/nodes/ww-01`);
    await expect(page.getByTestId("node-port-panel")).toHaveCount(2);
    await expect(page.getByTestId("node-devices-table")).toBeVisible();
  });
});

test.describe("shell", () => {
  test("/detection redirects to /ai/model", async ({ page }) => {
    await page.goto(`${BASE}/detection`);
    await expect(page).toHaveURL(`${BASE}/ai/model`);
  });

  test("command palette opens on Ctrl/Cmd+K and navigates to Live", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await page.keyboard.press("Control+k");
    const palette = page.getByTestId("command-palette");
    await expect(palette).toBeVisible();
    await page.getByTestId("command-palette-input").fill("Live");
    // Scoped to the palette: the sidebar's own "Live" nav link is also
    // visible underneath the overlay at desktop width, so an unscoped
    // text locator would match two elements.
    await palette.getByText("Live", { exact: true }).click();
    await expect(page).toHaveURL(`${BASE}/live`);
  });

  test("notification drawer opens from the bell and can mark all read", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await page.getByTestId("notification-bell").click();
    await expect(page.getByTestId("notification-drawer")).toBeVisible();
    await page.getByTestId("notification-mark-all-read").click();
    await expect(page.getByTestId("notification-unread-count")).toHaveCount(0);
  });

  test("user menu toggles theme", async ({ page }) => {
    await page.goto(`${BASE}/`);
    await page.getByTestId("user-menu-trigger").click();
    await page.getByTestId("user-menu-theme").click();
    await expect(page.locator("html")).not.toHaveClass(/dark/);
    await page.getByTestId("user-menu-trigger").click();
    await page.getByTestId("user-menu-theme").click();
    await expect(page.locator("html")).toHaveClass(/dark/);
  });
});

test.describe("devices", () => {
  test("table has 3 rows; Kettle row navigates to its profile", async ({ page }) => {
    await page.goto(`${BASE}/devices`);
    await expect(page.getByTestId("device-row")).toHaveCount(3);

    await page.getByTestId("device-row").filter({ hasText: "Kettle" }).click();
    await expect(page).toHaveURL(`${BASE}/devices/ww-01%2Fch0`);
    await expect(page.getByTestId("device-name-input")).toHaveValue("Kettle");
  });
});

test.describe("device profile", () => {
  test("rename device, reload, name persists, then rename back", async ({ page }) => {
    await page.goto(`${BASE}/devices/ww-01%2Fch0`);
    const nameInput = page.getByTestId("device-name-input");
    await expect(nameInput).toHaveValue("Kettle");

    await nameInput.fill("Kitchen kettle");
    await nameInput.press("Enter");
    await expect(page.getByTestId("device-name-input")).toHaveValue("Kitchen kettle");

    await page.reload();
    await expect(page.getByTestId("device-name-input")).toHaveValue("Kitchen kettle");

    await nameInput.fill("Kettle");
    await nameInput.press("Enter");
    await expect(page.getByTestId("device-name-input")).toHaveValue("Kettle");
    await page.reload();
    await expect(page.getByTestId("device-name-input")).toHaveValue("Kettle");
  });
});

test.describe("alerts", () => {
  test("lists a spike and the fridge offline alert; opened times differ; one alert per boil; ack then resolve", async ({
    page,
  }) => {
    await page.goto(`${BASE}/alerts`);

    // Alerts worker loops every 2s; give it a few passes to open the spike
    // and offline alerts against the freshly seeded DB.
    await expect(async () => {
      const rows = page.getByTestId("alert-row");
      expect(await rows.count()).toBeGreaterThan(0);
    }).toPass({ timeout: 20_000 });

    const spikeRows = page.getByTestId("alert-row").filter({ hasText: "Spike" });
    const firstSpike = spikeRows.first();
    await expect(firstSpike).toBeVisible({ timeout: 20_000 });

    // r1 finding #1: alert opened_ts used to be worker-restart time, so
    // every spike alert showed the same "opened 24s ago". It's now the
    // event's own start_ts, so distinct boils across the seeded 24h of
    // history show distinct opened times.
    const spikeCount = await spikeRows.count();
    if (spikeCount > 1) {
      // Desktop renders the opened time on a `<td title=...>`; the mobile
      // stacked-row layout (under 768px) puts the same title on a plain
      // `<div>` instead, so match on the attribute alone.
      const openedTitles = await spikeRows.evaluateAll((rows) =>
        rows.map((r) => r.querySelector("[title]")?.getAttribute("title")),
      );
      expect(new Set(openedTitles).size).toBeGreaterThan(1);
    }

    // r1 finding #2: a kettle boil used to raise two alerts (rule spike +
    // ML anomaly); the anomaly alert is now suppressed when it overlaps a
    // rule event on the same device, and the surviving spike alert carries
    // a "Rule + ML" chip instead.
    await expect(firstSpike.getByTestId("detectors-chip")).toBeVisible();

    const offlineRow = page.getByTestId("alert-row").filter({ hasText: "Fridge offline" });
    await expect(offlineRow.first()).toBeVisible({ timeout: 20_000 });

    await firstSpike.click();
    const drawer = page.getByTestId("alert-drawer");
    await expect(drawer).toBeVisible();
    const alertId = await firstSpike.getAttribute("data-alert-id");

    await drawer.getByTestId("alert-ack").click();
    await expect(page.locator(`[data-testid="alert-row"][data-alert-id="${alertId}"]`)).toHaveAttribute(
      "data-status",
      "acknowledged",
    );

    await drawer.getByTestId("alert-resolve").click();
    // Resolved leaves the default "Active" filter (open + acknowledged).
    await expect(page.locator(`[data-testid="alert-row"][data-alert-id="${alertId}"]`)).toHaveCount(0);
  });
});

test.describe("device profile incidents", () => {
  test("Kettle profile lists incidents with method chips and an explanation", async ({ page }) => {
    await page.goto(`${BASE}/devices/ww-01%2Fch0`);
    await expect(page.getByText("Incidents", { exact: true })).toBeVisible();

    await expect(async () => {
      const rows = page.getByTestId("device-incidents-list").locator("li");
      expect(await rows.count()).toBeGreaterThan(0);
    }).toPass({ timeout: 20_000 });

    const firstIncident = page.getByTestId("device-incidents-list").locator("li").first();
    await expect(firstIncident.getByTestId("method-chip").first()).toBeVisible();
    await expect(firstIncident.getByTestId("device-incident-explanation")).toBeVisible();
  });
});

test.describe("topology", () => {
  test("shows hub + 2 nodes + 3 ports + 3 appliances; offline appliance styled offline; Kettle navigates", async ({
    page,
  }) => {
    await page.goto(`${BASE}/topology`);
    await expect(page.locator(".react-flow__node")).toHaveCount(9);

    const fridgeNode = page.getByTestId("topology-node").filter({ hasText: "Fridge" });
    await expect(fridgeNode).toHaveAttribute("data-status", "offline");

    await page.getByTestId("topology-node").filter({ hasText: "Kettle" }).click();
    await expect(page).toHaveURL(`${BASE}/devices/ww-01%2Fch0`);
  });
});

test.describe("settings", () => {
  test("rule kinds show human labels, thresholds show units, severities are capitalized", async ({ page }) => {
    await page.goto(`${BASE}/settings`);
    await expect(page.getByTestId("rules-table")).toBeVisible();

    // "Sustained high draw" (over_power) has an editable threshold with a
    // W unit suffix next to it.
    const overPowerRow = page.getByTestId("rule-row").filter({ hasText: "Sustained high draw" });
    await expect(overPowerRow).toBeVisible();
    await expect(overPowerRow.getByTestId("rule-threshold-input")).toBeVisible();
    await expect(overPowerRow).toContainText("W");

    // "Power spike" (spike) has no editable threshold -- it's fixed by the
    // detector, not a user-set number.
    const spikeRow = page.getByTestId("rule-row").filter({ hasText: "Power spike" });
    await expect(spikeRow).toBeVisible();
    await expect(spikeRow.getByTestId("rule-threshold-input")).toHaveCount(0);

    // Severity options read as words, not raw enum values.
    const severitySelect = page.getByTestId("rule-row").first().getByTestId("rule-severity-select");
    await expect(severitySelect.locator("option")).toHaveText(["Info", "Warning", "Critical"]);
  });

  test("changing price doubles overview cost; add then delete a rule", async ({ page }) => {
    await page.goto(`${BASE}/`);
    // Poll until the stat has loaded real data (not the loading
    // placeholder), parsing on each attempt rather than matching the
    // placeholder text directly -- avoids any fragility around the exact
    // dash glyph it uses.
    let before = 0;
    await expect(async () => {
      const text = await page.getByTestId("stat-cost-today").innerText();
      before = Number(text.replace(/[^0-9.]/g, ""));
      expect(before).toBeGreaterThan(0);
    }).toPass({ timeout: 10_000 });

    await page.goto(`${BASE}/settings`);
    const priceInput = page.getByTestId("settings-price");
    await priceInput.fill("0.30");
    await page.getByTestId("settings-save").click();
    await expect(page.getByText("Saved").first()).toBeVisible();

    await page.goto(`${BASE}/`);
    await expect(async () => {
      const afterText = await page.getByTestId("stat-cost-today").innerText();
      const after = Number(afterText.replace(/[^0-9.]/g, ""));
      expect(after).toBeGreaterThan(before * 1.8);
      expect(after).toBeLessThan(before * 2.2);
    }).toPass({ timeout: 10_000 });

    // Restore price so later runs (and the screenshot pass) see the default.
    await page.goto(`${BASE}/settings`);
    await page.getByTestId("settings-price").fill("0.15");
    await page.getByTestId("settings-save").click();
    await expect(page.getByText("Saved").first()).toBeVisible();

    const rulesBefore = await page.getByTestId("rule-row").count();
    await page.getByTestId("rule-add-open").click();
    const dialog = page.getByTestId("rule-add");
    await dialog.getByTestId("rule-add-name").fill("E2E test rule");
    await dialog.getByTestId("rule-add-kind").selectOption("always_on");
    await dialog.getByTestId("rule-add-threshold").fill("10");
    await dialog.getByTestId("rule-add-duration").fill("60");
    await dialog.getByTestId("rule-add-submit").click();
    await expect(dialog).toBeHidden();

    await expect(page.getByTestId("rule-row")).toHaveCount(rulesBefore + 1);
    const newRow = page.getByTestId("rule-row").filter({ hasText: "E2E test rule" });
    await expect(newRow).toBeVisible();

    await newRow.getByTestId("rule-delete").click();
    await expect(page.getByTestId("rule-row").filter({ hasText: "E2E test rule" })).toHaveCount(0);
    await expect(page.getByTestId("rule-row")).toHaveCount(rulesBefore);
  });
});

test.describe("system", () => {
  // Placed after "settings" above: that block's PATCH /api/settings and
  // rule add/delete, plus "alerts"'s ack/resolve earlier in this file,
  // each write an audit_log row via hub/api.py's `_audit()`, so by this
  // point in the run the log is realistically non-empty -- but this
  // doesn't assume it (a fresh backend with none of those run yet would
  // show the audit-empty state instead, which is equally correct).
  test("service grid, db stats and audit log render", async ({ page }) => {
    await page.goto(`${BASE}/system`);
    await expect(page.getByTestId("service-row").first()).toBeVisible();
    const audit = page.locator('[data-testid="audit-table"], [data-testid="audit-empty"]');
    await expect(audit.first()).toBeVisible();
  });
});

test.describe("mobile layout", () => {
  const pages = ["/", "/live", "/devices", "/nodes", "/alerts", "/topology", "/analytics", "/system", "/settings"];
  for (const path of pages) {
    test(`no horizontal scroll on ${path}`, async ({ page }, testInfo) => {
      await page.goto(`${BASE}${path}`);
      await page.waitForTimeout(300);
      const { scrollWidth, innerWidth } = await page.evaluate(() => ({
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
      }));
      expect(scrollWidth).toBeLessThanOrEqual(innerWidth);
      if (testInfo.project.name === "mobile") {
        await expect(page.getByTestId("bottom-tabs")).toBeVisible();
      }
    });
  }

  test("alerts: stacked row shows device and a relative opened time", async ({ page }, testInfo) => {
    test.skip(testInfo.project.name !== "mobile", "stacked alert rows only replace the table under 768px");

    await page.goto(`${BASE}/alerts`);
    await expect(async () => {
      expect(await page.getByTestId("alert-row").count()).toBeGreaterThan(0);
    }).toPass({ timeout: 20_000 });

    const firstRow = page.getByTestId("alert-row").first();
    await expect(firstRow).toContainText(/ago/);
  });
});
