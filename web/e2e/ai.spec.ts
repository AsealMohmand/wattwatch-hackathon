// End-to-end tests for FE-2's AI surface (/ai/assistant, /ai/insights,
// /ai/model) against the seeded demo backend on :8091 (the same backend
// console.spec.ts uses). /api/assistant and the model-train endpoints are
// intercepted with page.route so these tests never depend on Ollama being
// warm or on a real training run finishing — per the plan (F2-6). The
// model/llm/insights/incidents data the demo DB doesn't carry yet (ML's v2
// work lands separately) is mocked the same way, so these tests exercise
// the real, positive-data rendering path deterministically rather than
// only the "AI module not available yet" empty states.
import { expect, test } from "./fixtures";

const BASE = "http://127.0.0.1:8091";
const DIR = "e2e/screenshots";

function sseBody(frames: { event: string; data: unknown }[]): string {
  return frames.map((f) => `event: ${f.event}\ndata: ${JSON.stringify(f.data)}\n\n`).join("");
}

const DONE = { latency_ms: 420, model: "llama3.2:3b", context_keys: ["devices", "totals", "price"] };
const ANSWER_FRAMES = [
  { event: "token", data: { t: "The kettle " } },
  { event: "token", data: { t: "used the most energy today, " } },
  { event: "token", data: { t: "about 1.2 kWh." } },
  { event: "done", data: DONE },
];

const MODEL_REPORT = {
  version: 1,
  trained_at: Date.now() - 3600_000,
  feature_set: "v2",
  features: ["log_w", "d_ratio_2m", "std_ratio_2m", "ratio_10m", "diff_2m"],
  rows: 5400,
  // Spans a day boundary so the FB-2 "Window" stat has to be date-aware,
  // not just a time-of-day range.
  window: { start_ts: Date.now() - 28 * 3600_000, end_ts: Date.now() - 3600_000 },
  threshold: -0.12,
  contamination: 0.01,
  // 7 boundaries for 6 bins -- the real, non-buggy shape (edges.length ===
  // counts.length + 1). A dedicated test below covers the real backend's
  // observed *swapped* shape (FB-1).
  score_hist: { edges: [-0.3, -0.2, -0.1, 0, 0.1, 0.2, 0.3], counts: [2, 5, 40, 120, 60, 8] },
  train_score_pctl: { p0_1: -0.28, p1: -0.22, p5: -0.15, p50: 0.05 },
  backtest: {
    idle_hours: 2.5,
    false_alarm_events: 1,
    false_alarms_per_hour: 0.4,
    injections: [
      { step_w: 150, duration_s: 60, detected: true, latency_s: 3.2 },
      { step_w: 300, duration_s: 60, detected: true, latency_s: 2.1 },
      { step_w: 800, duration_s: 60, detected: true, latency_s: 1.4 },
      // 0 s is the real demo API's observed value for every injection
      // (detection landed in the same 1 Hz reading) -- FB-3 renders it as
      // "<1 s" instead of the misleading "0.0 s".
      { step_w: 1500, duration_s: 60, detected: true, latency_s: 0 },
    ],
    rule_injections: [
      { step_w: 150, duration_s: 60, detected: false, latency_s: null },
      { step_w: 300, duration_s: 60, detected: true, latency_s: 4.0 },
      { step_w: 800, duration_s: 60, detected: true, latency_s: 1.1 },
      { step_w: 1500, duration_s: 60, detected: true, latency_s: 0.5 },
    ],
  },
  candidates: [
    { feature_set: "v1", threshold: -0.08, false_alarms_per_hour: 1.8, detection_rate: 0.75 },
    { feature_set: "v2", threshold: -0.12, false_alarms_per_hour: 0.4, detection_rate: 0.95 },
  ],
  chosen_reason: "v2 at threshold -0.12 gives the highest detection rate at or below one false alarm per hour.",
};

// The real /api/model report (curl'd from the :8090 demo API) came back
// with `edges` and `counts` swapped: `edges` held one-per-bin integer
// counts (ascending because they were really the counts) and `counts` held
// the N+1 ascending score boundaries. This is that shape, shrunk to 6 bins
// -- the FB-1 fix must detect and correct it by array length, not by field
// name, so the tallest bar still lands inside the true (float) score range
// instead of the bogus integer one.
const SWAPPED_SCORE_HIST = {
  edges: [50, 120, 900, 1200, 300, 40],
  counts: [-0.1, -0.05, 0, 0.05, 0.1, 0.15, 0.2],
};
const MODEL_REPORT_SWAPPED = { ...MODEL_REPORT, score_hist: SWAPPED_SCORE_HIST };

const LLM_STATUS = {
  model: "llama3.2:3b",
  reachable: true,
  prompt_version: "v2",
  eval: {
    chosen: "llama3.2:3b",
    variants: [
      { prompt_version: "v1", model: "llama3.2:1b", score: 0.71, p50_ms: 180, p95_ms: 260 },
      { prompt_version: "v2", model: "llama3.2:3b", score: 0.91, p50_ms: 410, p95_ms: 640 },
    ],
  },
};

const NOW = Date.now();

const DIGEST_ONE = {
  id: 1,
  kind: "daily_digest",
  created_ts: NOW - 30 * 60_000,
  period_start: NOW - 24 * 3600_000,
  period_end: NOW,
  title: "Today so far: 1.9 kWh, $0.28",
  body: "Most of today's energy went to the kettle, which ran twice this morning. Nothing unusual is running right now.",
  model: "llama3.2:3b",
  latency_ms: 980,
};

const DIGEST_TWO = {
  ...DIGEST_ONE,
  id: 2,
  created_ts: NOW,
  title: "Today so far: 2.4 kWh, $0.36",
  body: "A third kettle boil just finished. Spending is tracking slightly above yesterday.",
};

const INCIDENT_WITH_AI = {
  id: "evt-ai-1",
  device_id: "ww-01/ch0",
  device_name: "Kettle",
  start_ts: NOW - 10 * 60_000,
  end_ts: NOW - 8 * 60_000,
  duration_s: 120,
  peak_w: 1480,
  baseline_w: 12,
  methods: ["rule"],
  rule_score: null,
  iforest_score: null,
  explanation: "Power jumped from 12 W to 1480 W for 120 s.",
  event_ids: [1],
  ai: {
    appliance: "Kettle",
    confidence: "high",
    verdict: "normal",
    summary: "The kettle ran for 2 minutes, in line with its usual boil. Nothing to check.",
    model: "llama3.2:3b",
    latency_ms: 510,
    fallback: false,
  },
};

const INCIDENT_NO_AI = {
  id: "evt-plain-1",
  device_id: "ww-01/ch1",
  device_name: "Space heater",
  start_ts: NOW - 40 * 60_000,
  end_ts: NOW - 10 * 60_000,
  duration_s: 1800,
  peak_w: 1450,
  baseline_w: 8,
  methods: ["rule", "iforest"],
  rule_score: null,
  iforest_score: -0.18,
  explanation: "Power jumped from 8 W to 1450 W for 1800 s.",
  event_ids: [2, 3],
  ai: null,
};

const INCIDENT_FALLBACK = {
  id: "evt-fallback-1",
  device_id: "ww-01/ch2",
  device_name: "Microwave",
  start_ts: NOW - 60 * 60_000,
  end_ts: NOW - 58 * 60_000,
  duration_s: 120,
  peak_w: 1100,
  baseline_w: 9,
  methods: ["rule"],
  rule_score: null,
  iforest_score: null,
  explanation: "Power jumped from 9 W to 1100 W for 120 s.",
  event_ids: [4],
  ai: {
    appliance: "Microwave",
    confidence: "medium",
    verdict: "normal",
    summary: "Power jumped from 9 W to 1100 W for about 2 minutes.",
    model: "llama3.2:3b",
    latency_ms: 20_000,
    fallback: true,
  },
};

test.describe("assistant", () => {
  test("streams an answer, shows model/latency and data used, and recovers from an error via retry", async ({ page }) => {
    let callCount = 0;
    await page.route("**/api/assistant", async (route) => {
      callCount += 1;
      if (callCount === 1) {
        await route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ detail: "The local model isn't reachable right now." }) });
      } else {
        await route.fulfill({ status: 200, contentType: "text/event-stream", body: sseBody(ANSWER_FRAMES) });
      }
    });

    await page.goto(`${BASE}/ai/assistant`);
    await expect(page.getByTestId("assistant-empty")).toBeVisible();

    await page.getByTestId("suggested-prompt").filter({ hasText: "most energy" }).click();

    // First call was mocked to fail -- the UI should show the error inline
    // with a retry action, not hang or crash.
    await expect(page.getByTestId("chat-error")).toBeVisible();
    await expect(page.getByTestId("chat-error")).toContainText("reachable");

    await page.getByTestId("chat-retry").click();

    const assistantMsg = page.getByTestId("chat-message-assistant").last();
    await expect(assistantMsg).toContainText("1.2 kWh");
    await expect(assistantMsg.getByTestId("ai-meta")).toContainText("llama3.2:3b");
    await expect(assistantMsg.getByTestId("ai-meta")).toContainText("420");

    await assistantMsg.getByText(/Data used/).click();
    await expect(assistantMsg).toContainText("Price per kWh");
  });

  test("the stop button ends a streaming answer without an error", async ({ page }) => {
    await page.route("**/api/assistant", async (route) => {
      // Hold the response open long enough to click Stop before it resolves.
      await new Promise((r) => setTimeout(r, 2000));
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: sseBody(ANSWER_FRAMES) });
    });

    await page.goto(`${BASE}/ai/assistant`);
    await page.getByTestId("assistant-input").fill("Explain the last spike");
    await page.getByTestId("assistant-send").click();

    await expect(page.getByTestId("assistant-stop")).toBeVisible();
    await page.getByTestId("assistant-stop").click();

    await expect(page.getByTestId("assistant-send")).toBeVisible();
    await expect(page.getByTestId("chat-error")).toHaveCount(0);
  });
});

test.describe("model lab", () => {
  test("renders the report, histogram, candidates and eval table, and completes a mocked retrain", async ({ page }, testInfo) => {
    await page.route("**/api/model", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ exists: true, report: MODEL_REPORT, model_mtime: Date.now() }) });
    });
    await page.route("**/api/model/scores*", async (route) => {
      const points = Array.from({ length: 20 }, (_, i) => ({ ts: NOW - (20 - i) * 60_000, score: i === 10 ? -0.2 : 0.05 }));
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ threshold: MODEL_REPORT.threshold, points }) });
    });
    await page.route("**/api/llm", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(LLM_STATUS) });
    });

    let jobCalls = 0;
    await page.route("**/api/model/train", async (route) => {
      if (route.request().method() === "POST") {
        await route.fulfill({ status: 202, contentType: "application/json", body: JSON.stringify({ job_id: "job-e2e" }) });
      }
    });
    await page.route("**/api/model/train/job-e2e", async (route) => {
      jobCalls += 1;
      const done = jobCalls >= 2;
      await route.fulfill({
        status: 200,
        contentType: "application/json",
        body: JSON.stringify({
          job_id: "job-e2e",
          status: done ? "done" : "running",
          progress: done ? 100 : 45,
          message: done ? "Training complete." : "Backtesting candidates…",
          report: done ? MODEL_REPORT : null,
        }),
      });
    });

    await page.goto(`${BASE}/ai/model`);

    await expect(page.getByTestId("iforest-summary")).toBeVisible();
    await expect(page.getByTestId("model-rows")).toContainText("5,400");
    await expect(page.getByTestId("score-histogram").locator("svg").first()).toBeVisible();
    await expect(page.getByTestId("live-score-chart").locator("svg").first()).toBeVisible();
    await expect(page.getByTestId("backtest-false-alarm-rate")).toContainText("0.4");
    await expect(page.getByTestId("injection-row")).toHaveCount(4);

    // FB-3: a 0 s injection latency reads as "<1 s", not a flat "0.0 s".
    await expect(page.getByTestId("injection-row").last()).toContainText("<1 s");

    // FB-1: the tallest bar's x (bin center) must fall inside the real
    // score range built from score_hist's boundaries, never a count value.
    const edgeMin = Number(await page.getByTestId("histogram-edge-min").textContent());
    const edgeMax = Number(await page.getByTestId("histogram-edge-max").textContent());
    const tallestX = Number(await page.getByTestId("histogram-tallest-x").textContent());
    expect(tallestX).toBeGreaterThanOrEqual(edgeMin);
    expect(tallestX).toBeLessThanOrEqual(edgeMax);
    // MODEL_REPORT's tallest bin (count 120) sits between edges 0 and 0.1.
    expect(tallestX).toBeCloseTo(0.05, 5);

    // Review fix #2: the y-axis tick values must read ascending in DOM order
    // (bottom of the chart to the top, 0 first) -- a width too narrow for a
    // wide count label used to clip its leading digit (e.g. "34000" render
    // as "4000"), which made the ticks look scrambled rather than monotonic.
    const yTicks = page.locator('[data-testid="score-histogram"] .recharts-yAxis-tick-labels .recharts-cartesian-axis-tick-value');
    const yTickCount = await yTicks.count();
    expect(yTickCount).toBeGreaterThan(1);
    const parseCompact = (text: string): number => {
      const m = text.trim().match(/^([\d.]+)([KM]?)$/i);
      if (!m) throw new Error(`unexpected y-axis tick text: "${text}"`);
      const mult = m[2].toUpperCase() === "K" ? 1_000 : m[2].toUpperCase() === "M" ? 1_000_000 : 1;
      return Number(m[1]) * mult;
    };
    const tickValues: number[] = [];
    for (let i = 0; i < yTickCount; i++) {
      tickValues.push(parseCompact((await yTicks.nth(i).textContent()) ?? ""));
    }
    for (let i = 1; i < tickValues.length; i++) {
      expect(tickValues[i]).toBeGreaterThanOrEqual(tickValues[i - 1]);
    }

    // FB-2: "Trained" is relative, with the full timestamp in a title, and
    // "Window" is a date-aware one-line range plus its duration -- neither
    // stat value wraps to a second line at this (1280px+) viewport.
    await expect(page.getByTestId("model-trained-at")).toContainText(/ago$/);
    await expect(page.getByTestId("model-trained-at").locator("xpath=..")).toHaveAttribute("title", /\d{4}-\d{2}-\d{2}/);
    await expect(page.getByTestId("model-window")).toContainText(/\d+\.\d h/);
    await expect(page.getByTestId("model-window")).toContainText(/to/);
    const trainedBox = await page.getByTestId("model-trained-at").boundingBox();
    const windowBox = await page.getByTestId("model-window").boundingBox();
    expect(trainedBox?.height ?? 0).toBeLessThan(100);
    expect(windowBox?.height ?? 0).toBeLessThan(130);

    const chosenCandidate = page.getByTestId("candidate-row").filter({ hasText: "v2" });
    await expect(chosenCandidate).toHaveAttribute("data-chosen", "true");
    await expect(page.getByTestId("chosen-reason")).toContainText("v2 at threshold");

    await expect(page.getByTestId("explainer-status")).toContainText("llama3.2:3b");
    await expect(page.getByTestId("explainer-status")).toContainText("Reachable");
    const chosenEval = page.getByTestId("eval-row").filter({ hasText: "llama3.2:3b" });
    await expect(chosenEval).toHaveAttribute("data-chosen", "true");

    await page.getByTestId("retrain-button").click();
    await expect(page.getByTestId("train-progress")).toBeVisible();
    await expect(page.getByTestId("retrain-button")).toContainText("Retrain model", { timeout: 15_000 });

    if (testInfo.project.name === "desktop") {
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${DIR}/desktop-ai-model.png`, fullPage: true });
    }
  });

  test("FB-1: a real report with edges/counts swapped still places the tallest bar in the true score range", async ({ page }) => {
    await page.route("**/api/model", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ exists: true, report: MODEL_REPORT_SWAPPED, model_mtime: Date.now() }) });
    });
    await page.route("**/api/model/scores*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ threshold: MODEL_REPORT_SWAPPED.threshold, points: [] }) });
    });
    await page.route("**/api/llm", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(LLM_STATUS) });
    });

    await page.goto(`${BASE}/ai/model`);
    await expect(page.getByTestId("score-histogram").locator("svg").first()).toBeVisible();

    const edgeMin = Number(await page.getByTestId("histogram-edge-min").textContent());
    const edgeMax = Number(await page.getByTestId("histogram-edge-max").textContent());
    const tallestX = Number(await page.getByTestId("histogram-tallest-x").textContent());

    // The true boundaries are SWAPPED_SCORE_HIST.counts (-0.1..0.2); the
    // bogus integer array (SWAPPED_SCORE_HIST.edges, up to 1200) must never
    // be mistaken for them.
    expect(edgeMin).toBeCloseTo(-0.1, 5);
    expect(edgeMax).toBeCloseTo(0.2, 5);
    expect(tallestX).toBeGreaterThanOrEqual(edgeMin);
    expect(tallestX).toBeLessThanOrEqual(edgeMax);
    expect(tallestX).toBeCloseTo(0.075, 5);
  });
});

test.describe("insights", () => {
  test("renders the digest timeline, generates a new digest, and shows structured + plain incident explanations", async ({ page }, testInfo) => {
    let generated = false;
    await page.route("**/api/insights/digest", async (route) => {
      generated = true;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(DIGEST_TWO) });
    });
    await page.route("**/api/insights*", async (route) => {
      const list = generated ? [DIGEST_TWO, DIGEST_ONE] : [DIGEST_ONE];
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(list) });
    });
    await page.route("**/api/incidents*", async (route) => {
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify([INCIDENT_WITH_AI, INCIDENT_NO_AI, INCIDENT_FALLBACK]) });
    });

    await page.goto(`${BASE}/ai/insights`);

    await expect(page.getByTestId("digest-card")).toHaveCount(1);
    await expect(page.getByTestId("digest-card").first()).toContainText("1.9 kWh");

    await page.getByTestId("generate-digest").click();
    await expect(page.getByTestId("digest-card")).toHaveCount(2, { timeout: 10_000 });
    await expect(page.getByTestId("digest-card").first()).toContainText("2.4 kWh");

    const rows = page.getByTestId("incident-explanation-row");
    await expect(rows).toHaveCount(3);

    const structuredRow = rows.filter({ hasText: "Kettle" });
    await expect(structuredRow.getByTestId("confidence-meter")).toBeVisible();
    await expect(structuredRow.getByTestId("verdict-chip")).toContainText("Normal");
    // FB-5: the meta row reads as labelled fields, not a middle-dot string.
    await expect(structuredRow).toContainText("Peak 1,480 W");
    await expect(structuredRow).toContainText("Duration 2m 0s");
    await expect(structuredRow).not.toContainText("·");

    // FB-5: with `ai` null, only the plain text explanation shows -- no
    // "(structured detail not available...)" aside.
    const plainRow = rows.filter({ hasText: "Space heater" });
    await expect(plainRow).toContainText(INCIDENT_NO_AI.explanation);
    await expect(plainRow).not.toContainText("structured detail");
    await expect(plainRow.getByTestId("confidence-meter")).toHaveCount(0);

    // FB-5: a structured explanation that fell back to the template gets a
    // muted, explicit note instead of a bare "Template fallback" chip.
    const fallbackRow = rows.filter({ hasText: "Microwave" });
    await expect(fallbackRow.getByTestId("ai-fallback-note")).toContainText("Template explanation. Llama didn't answer in time.");

    if (testInfo.project.name === "desktop") {
      await page.waitForTimeout(200);
      await page.screenshot({ path: `${DIR}/desktop-ai-insights.png`, fullPage: true });
    }
  });
});

test.describe("ai screenshots", () => {
  test("desktop-ai-assistant.png and mobile-ai-assistant.png", async ({ page }, testInfo) => {
    await page.route("**/api/assistant", async (route) => {
      await route.fulfill({ status: 200, contentType: "text/event-stream", body: sseBody(ANSWER_FRAMES) });
    });
    await page.goto(`${BASE}/ai/assistant`);
    await page.getByTestId("suggested-prompt").first().click();
    await expect(page.getByTestId("chat-message-assistant").last()).toContainText("1.2 kWh");
    await page.waitForTimeout(200);
    await page.screenshot({ path: `${DIR}/${testInfo.project.name}-ai-assistant.png`, fullPage: true });
  });
});
