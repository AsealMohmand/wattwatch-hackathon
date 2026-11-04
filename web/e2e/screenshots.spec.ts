// Full-page screenshots of every page, in both the desktop and mobile
// projects, against the seeded backend on :8091. Overview, Topology and
// Alerts are additionally captured in light theme (the app defaults to
// dark). Written to web/e2e/screenshots/<project>-<page>[-light].png.
//
// v2: the theme toggle moved from its own topbar button into the user
// menu (F1-1), so light/dark capture now opens that menu first instead of
// clicking a standalone "theme-toggle" button. /detection now redirects to
// /ai/model (FE-2's Model lab), so it's dropped from this list -- FE-2's
// own e2e/ai.spec.ts screenshots that page.
import { expect, test } from "./fixtures";

const BASE = "http://127.0.0.1:8091";
const DIR = "e2e/screenshots";

const PAGES: { name: string; path: string; ready: string }[] = [
  { name: "overview", path: "/", ready: "device-card" },
  { name: "live", path: "/live", ready: "live-device-tile" },
  { name: "devices", path: "/devices", ready: "devices-table" },
  { name: "device-profile", path: "/devices/ww-01%2Fch0", ready: "device-name-input" },
  { name: "nodes", path: "/nodes", ready: "node-card" },
  { name: "node-detail", path: "/nodes/ww-01", ready: "node-port-panel" },
  { name: "alerts", path: "/alerts", ready: "alerts-summary" },
  { name: "topology", path: "/topology", ready: "topology-canvas" },
  { name: "analytics", path: "/analytics", ready: "analytics-stacked-bars" },
  { name: "system", path: "/system", ready: "service-grid" },
  { name: "settings", path: "/settings", ready: "settings-form" },
];

const LIGHT_PAGES = new Set(["overview", "topology", "alerts"]);

async function toggleTheme(page: import("@playwright/test").Page) {
  await page.getByTestId("user-menu-trigger").click();
  await page.getByTestId("user-menu-theme").click();
}

for (const p of PAGES) {
  test(`screenshot: ${p.name}`, async ({ page }, testInfo) => {
    await page.goto(`${BASE}${p.path}`);
    await expect(page.getByTestId(p.ready).first()).toBeVisible({ timeout: 15_000 });
    await page.waitForTimeout(250); // let polling-driven skeletons settle
    await page.screenshot({ path: `${DIR}/${testInfo.project.name}-${p.name}.png`, fullPage: true });

    if (LIGHT_PAGES.has(p.name)) {
      await toggleTheme(page);
      await expect(page.locator("html")).not.toHaveClass(/dark/);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${DIR}/${testInfo.project.name}-${p.name}-light.png`, fullPage: true });

      await toggleTheme(page);
      await expect(page.locator("html")).toHaveClass(/dark/);
      await page.waitForTimeout(250);
      await page.screenshot({ path: `${DIR}/${testInfo.project.name}-${p.name}-dark.png`, fullPage: true });
    }
  });
}
