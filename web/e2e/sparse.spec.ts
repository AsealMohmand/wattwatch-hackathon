// Against a backend with one device (ww-01/ch0), 15 minutes of ~78 W
// readings that ended 55 minutes ago, and no events (hub/api.py + this
// spec's own seed_sparse.py fixture on :8093, started by e2e/serve.mjs via
// playwright.config.ts's webServer). Confirms r1 findings #3/#4/#10 (a
// stale-but-real reading is never shown as current, and an unnamed device
// points the user at fixing that), adjusted for v2: Home's power chart is
// now a fixed last-24h view (no 10m/1h/24h range picker), so 55-minutes-old
// data still renders directly rather than tripping a "stale window" state
// -- that state still exists where a range picker does (DeviceProfile,
// owned by FE-2). Every test fails on any console.error or pageerror (see
// ./fixtures.ts).
import { expect, test } from "./fixtures";

const BASE = "http://127.0.0.1:8093";

test.describe("sparse data", () => {
  test("overview: Last seen callout, 24h chart still renders; profile: unnamed callout", async ({ page }, testInfo) => {
    await page.goto(`${BASE}/`);

    await expect(page.getByTestId("device-card")).toHaveCount(1);
    await expect(page.getByTestId("device-card-last-seen")).toContainText("Last seen");
    await expect(page.getByTestId("power-chart")).toBeVisible();
    await page.waitForTimeout(250);
    await page.screenshot({ path: `e2e/screenshots/${testInfo.project.name}-sparse-overview.png`, fullPage: true });

    await page.goto(`${BASE}/devices/ww-01%2Fch0`);
    await expect(page.getByTestId("unnamed-device-callout")).toBeVisible();
    await expect(page.getByTestId("device-last-seen")).toContainText("Last seen");
    await page.waitForTimeout(250);
    await page.screenshot({ path: `e2e/screenshots/${testInfo.project.name}-sparse-profile.png`, fullPage: true });
  });
});
