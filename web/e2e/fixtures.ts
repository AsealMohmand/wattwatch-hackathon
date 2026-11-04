// Shared fixture: fails any test that logs a console.error or throws a
// pageerror while the page is open. Every spec imports `test`/`expect` from
// here instead of `@playwright/test` directly.
import { test as base, expect } from "@playwright/test";

// Chromium logs "Failed to load resource: ... 404/409/422" to the console
// itself, as a DevTools network diagnostic, for *any* non-2xx fetch --
// independent of app code and not something a catch block can suppress.
// The API intentionally returns those codes (unknown device -> 404, ack an
// already-acked alert -> 409, bad settings patch -> 422) and the pages
// handle them (e.g. "Device not found."); that diagnostic line is not a
// defect. Nothing in src/ calls console.error/warn directly (checked), so
// every other console.error here is a real signal (React warnings, our own
// code, etc.) and still fails the test.
const BENIGN_RESOURCE_ERROR = /^console\.error: Failed to load resource: the server responded with a status of \d+/;

export const test = base.extend<{ failOnConsoleErrors: void }>({
  failOnConsoleErrors: [
    async ({ page }, use) => {
      const errors: string[] = [];
      page.on("console", (msg) => {
        if (msg.type() === "error") errors.push(`console.error: ${msg.text()}`);
      });
      page.on("pageerror", (err) => {
        errors.push(`pageerror: ${err.message}`);
      });
      await use();
      const real = errors.filter((e) => !BENIGN_RESOURCE_ERROR.test(e));
      expect(real, real.join("\n")).toEqual([]);
    },
    { auto: true },
  ],
});

export { expect };
