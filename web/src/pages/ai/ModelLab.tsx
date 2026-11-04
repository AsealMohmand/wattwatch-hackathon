// Model lab (/ai/model) — F2-3. Merges the old Detection page: the tuned
// Isolation Forest's report (score histogram, live scores, backtest,
// candidates, retrain), the explainer's eval table, the two-layer
// explanation, and the incident table.
import { Activity, Brain, CheckCircle2, FlaskConical, Loader2, Play, XCircle } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { ApiError } from "../../api/client";
import type { InjectionResult, ModelCandidate, ModelReport } from "../../api/client";
import { useDevices, useHealth, useIncidents, useLlm, useModel, useModelScores, useTrainJob, useTrainModel } from "../../api/hooks";
import { EmptyState } from "../../components/EmptyState";
import { MethodChip } from "../../components/MethodChip";
import { Skeleton } from "../../components/Skeleton";
import { StatCard } from "../../components/StatCard";
import { formatDateTime, formatDuration, formatRelative, formatTime, formatWatts } from "../../lib/format";

const MIN_TRAIN_READINGS = 1800; // 30 min at 1 Hz, per the plan

/** The score histogram's y-axis reads reading *counts*, which on a real,
 * long-running DB climb into five digits (34000+). The axis's `width={32}`
 * was sized for four digits -- a tick label one digit longer than that
 * doesn't get wrapped or truncated with an ellipsis, it silently overflows
 * its allotted width and the leading digit renders past the chart's left
 * edge, invisible. "34000", "25500" and "17000" then read as "4000",
 * "5500" and "7000" -- a top-to-bottom sequence that *looks* like it's
 * ascending instead of descending, i.e. scrambled, even though the
 * underlying ticks were correctly ordered all along. Compact notation
 * ("34K") keeps every tick short regardless of how large counts grow, so
 * there's no width to run out of. */
const compactCount = new Intl.NumberFormat("en-US", { notation: "compact", maximumFractionDigits: 1 });

/** Every other timestamp in this app is Unix ms, but `model_report.json`'s
 * `trained_at` was observed coming back in Unix *seconds* (matching
 * `detect_iforest.py`'s own quick-train path, `int(time.time())`) against a
 * real trained model -- rendered literally that showed "1970". Any value
 * too small to be a plausible ms timestamp is treated as seconds. */
function toMs(ts: number): number {
  return ts < 1e12 ? ts * 1000 : ts;
}

/** "Nov 3 03:49" -- month + day + 24h time, no year (the window is always
 * recent). Local to this file: a compact, date-aware stamp the shared
 * `formatDateTime`/`formatTime` helpers don't produce on their own. */
function formatCompactDateTime(ts: number): string {
  const d = new Date(ts);
  const month = d.toLocaleDateString("en-US", { month: "short" });
  return `${month} ${d.getDate()} ${formatTime(ts).slice(0, 5)}`;
}

function formatWindowRange(startTs: number, endTs: number): string {
  return `${formatCompactDateTime(startTs)} to ${formatCompactDateTime(endTs)}`;
}

function formatWindowDuration(startTs: number, endTs: number): string {
  return `${Math.max(0, (endTs - startTs) / 3_600_000).toFixed(1)} h`;
}

/** `0.0 s` reads as "instant" being indistinguishable from "didn't measure" --
 * the real report has every injection detect inside the same 1 Hz reading,
 * so this renders as "<1 s" instead of a flat zero. */
function formatLatencySeconds(seconds: number | null | undefined): string {
  if (seconds == null) return "—";
  if (seconds === 0) return "<1 s";
  return `${seconds.toFixed(1)} s`;
}

export function ModelLab() {
  const health = useHealth();
  const model = useModel();
  const llm = useLlm();
  const devices = useDevices();
  const [deviceId, setDeviceId] = useState<string | null>(null);

  useEffect(() => {
    if (!deviceId && devices.data && devices.data.length > 0) setDeviceId(devices.data[0].device_id);
  }, [deviceId, devices.data]);

  const readingsNow = health.data?.readings ?? 0;
  const canTrain = readingsNow >= MIN_TRAIN_READINGS;
  const report = model.data?.report ?? null;

  return (
    <div data-testid="page-ai-modellab" className="flex flex-col gap-6">
      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <h2 className="text-sm font-medium text-text">Isolation forest</h2>
          <RetrainControl canTrain={canTrain} readingsNow={readingsNow} />
        </div>
        {model.isLoading ? (
          <Skeleton className="h-24 w-full" />
        ) : report ? (
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="iforest-summary">
            <div title={formatDateTime(toMs(report.trained_at))}>
              <StatCard testId="model-trained-at" label="Trained" value={formatRelative(toMs(report.trained_at))} />
            </div>
            <StatCard testId="model-rows" label="Rows" value={report.rows.toLocaleString()} />
            <div title={`${formatDateTime(report.window.start_ts)} to ${formatDateTime(report.window.end_ts)}`}>
              <StatCard
                testId="model-window"
                label="Window"
                value={formatWindowDuration(report.window.start_ts, report.window.end_ts)}
                sub={formatWindowRange(report.window.start_ts, report.window.end_ts)}
              />
            </div>
            <StatCard testId="model-feature-set" label="Feature set" value={report.feature_set} />
            <StatCard testId="model-threshold" label="Threshold" value={report.threshold.toFixed(3)} />
            <StatCard testId="model-contamination" label="Contamination" value={report.contamination.toFixed(3)} />
          </div>
        ) : (
          <EmptyState
            icon={FlaskConical}
            title="Not trained yet."
            detail="The model trains on 30 minutes of normal readings."
            testId="model-empty"
          />
        )}
        {report && (
          <p className="text-xs text-text-muted" data-testid="model-features-list">
            Features: {report.features.join(", ")}
          </p>
        )}
      </section>

      {report && (
        <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
          <div className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
            <h2 className="text-sm font-medium text-text">Score distribution</h2>
            <ScoreHistogram report={report} />
          </div>
          <div className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <h2 className="text-sm font-medium text-text">Live scores</h2>
              <select
                data-testid="score-device-select"
                value={deviceId ?? ""}
                onChange={(e) => setDeviceId(e.target.value)}
                className="rounded-md border border-border bg-bg px-2 py-1 text-xs text-text"
              >
                {(devices.data ?? []).map((d) => (
                  <option key={d.device_id} value={d.device_id}>
                    {d.name}
                  </option>
                ))}
              </select>
            </div>
            <LiveScoreChart deviceId={deviceId} />
          </div>
        </section>
      )}

      {report && (
        <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
          <h2 className="text-sm font-medium text-text">Backtest</h2>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
            <StatCard testId="backtest-idle-hours" label="Idle hours tested" value={report.backtest.idle_hours.toFixed(1)} />
            <StatCard testId="backtest-false-alarms" label="False-alarm events" value={String(report.backtest.false_alarm_events)} />
            <StatCard testId="backtest-false-alarm-rate" label="False alarms / hr" value={report.backtest.false_alarms_per_hour.toFixed(2)} />
          </div>
          <InjectionTable forest={report.backtest.injections} rule={report.backtest.rule_injections} />
        </section>
      )}

      {report && report.candidates.length > 0 && (
        <section className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
          <h2 className="text-sm font-medium text-text">Candidates considered</h2>
          <CandidatesTable candidates={report.candidates} chosenFeatureSet={report.feature_set} chosenThreshold={report.threshold} />
          <p className="text-xs text-text-muted" data-testid="chosen-reason">
            {report.chosen_reason}
          </p>
        </section>
      )}

      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
        <h2 className="text-sm font-medium text-text">Explainer</h2>
        {llm.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : llm.data ? (
          <>
            <div className="flex flex-wrap items-center gap-3 text-sm" data-testid="explainer-status">
              <span className="flex items-center gap-1.5 text-text">
                <Brain size={14} />
                {llm.data.model}
              </span>
              <span className={`flex items-center gap-1 text-xs ${llm.data.reachable ? "text-trace" : "text-critical"}`}>
                <span className={`h-1.5 w-1.5 rounded-full ${llm.data.reachable ? "bg-trace" : "bg-critical"}`} />
                {llm.data.reachable ? "Reachable" : "Unreachable"}
              </span>
              <span className="text-xs text-text-muted">Prompt {llm.data.prompt_version}</span>
            </div>
            {llm.data.eval ? <EvalTable evalData={llm.data.eval} /> : <p className="text-xs text-text-muted">No evaluation run yet.</p>}
          </>
        ) : (
          <EmptyState icon={Brain} title="Explainer status unavailable." detail="It will appear once the AI module is up." testId="explainer-empty" />
        )}
      </section>

      <section className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <div className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
          <h2 className="text-sm font-medium text-text">Layer 1, rule</h2>
          <p className="text-sm text-text-muted">
            A rolling median and spread of watts over the last two minutes of normal readings. A second is flagged when it sits far
            outside that spread and at least 200 W above the median — the floor that keeps idle noise from tripping it.
          </p>
        </div>
        <div className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
          <h2 className="text-sm font-medium text-text">Layer 2, Isolation forest</h2>
          <p className="text-sm text-text-muted">
            A model tuned against a held-out slice of real readings, scoring how unusual each second looks against recent normal
            use. It catches patterns the rule's fixed thresholds miss, and a local Llama model explains each one it flags.
          </p>
        </div>
      </section>

      <section className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
        <h2 className="text-sm font-medium text-text">Incidents, last 24h</h2>
        <IncidentsTable />
      </section>
    </div>
  );
}

function RetrainControl({ canTrain, readingsNow }: { canTrain: boolean; readingsNow: number }) {
  const [jobId, setJobId] = useState<string | undefined>(undefined);
  const [startError, setStartError] = useState<string | null>(null);
  const train = useTrainModel();
  const job = useTrainJob(jobId);

  function start() {
    setStartError(null);
    train.mutate(undefined, {
      onSuccess: (res) => setJobId(res.job_id),
      onError: (err: unknown) => {
        setStartError(
          err instanceof ApiError && err.status === 409 ? "A training run is already in progress." : "Couldn't start training. Try again in a moment.",
        );
      },
    });
  }

  const running = job.data?.status === "queued" || job.data?.status === "running";

  return (
    <div className="flex flex-col items-end gap-1.5">
      <button
        type="button"
        data-testid="retrain-button"
        disabled={!canTrain || running}
        onClick={start}
        className="flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 text-xs font-medium text-text transition-colors hover:border-trace disabled:cursor-not-allowed disabled:opacity-40"
      >
        {running ? <Loader2 size={13} className="animate-spin" /> : <Play size={13} />}
        {running ? "Training…" : "Retrain model"}
      </button>
      {!canTrain && (
        <p className="max-w-xs text-right text-xs text-text-muted" data-testid="retrain-disabled-hint">
          Needs at least 30 minutes of readings (1,800). {readingsNow.toLocaleString()} so far.
        </p>
      )}
      {startError && (
        <p className="text-xs text-critical" data-testid="retrain-start-error">
          {startError}
        </p>
      )}
      {job.data && (
        <div data-testid="train-progress" className="flex w-48 flex-col gap-1">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-surface-raised">
            <div className="h-full rounded-full bg-trace transition-all" style={{ width: `${job.data.progress}%` }} />
          </div>
          <span className="text-right text-xs text-text-muted">{job.data.message}</span>
        </div>
      )}
    </div>
  );
}

interface HistogramBin {
  x: number;
  label: string;
  count: number;
}

/** Turns `score_hist` into one bin per bar: x at the bin center, height the
 * count. A real trained report was observed with `edges` and `counts`
 * swapped -- the field named `edges` held one-per-bin integer counts
 * (91..37219, climbing because they were really the ascending `counts`
 * array) and the field named `counts` held the N+1 ascending score
 * boundaries (-0.126..0.349). That produced "bars climb steadily" with x
 * labels reading like counts ("249.00 ... 24981.00").
 *
 * Fixed by picking whichever of the two arrays is longer by exactly one as
 * the bin *boundaries* -- that's the only shape a histogram's edges can
 * have relative to its counts -- regardless of which JSON field it arrived
 * under, so this is correct whether or not the backend's naming is fixed.
 * Mismatched lengths with no clean off-by-one relationship can't be placed
 * reliably, so render nothing (same conservative guard as before). */
function buildHistogramBins(scoreHist: { edges: number[]; counts: number[] }): { bins: HistogramBin[]; edgeMin: number; edgeMax: number } {
  const a = scoreHist.edges;
  const b = scoreHist.counts;
  let boundaries: number[];
  let heights: number[];
  if (a.length === b.length + 1) {
    boundaries = a;
    heights = b;
  } else if (b.length === a.length + 1) {
    boundaries = b;
    heights = a;
  } else {
    return { bins: [], edgeMin: NaN, edgeMax: NaN };
  }
  const bins = heights.map((count, i) => {
    const lo = boundaries[i];
    const hi = boundaries[i + 1];
    const x = (lo + hi) / 2;
    return { x, label: x.toFixed(2), count };
  });
  return { bins, edgeMin: Math.min(...boundaries), edgeMax: Math.max(...boundaries) };
}

function ScoreHistogram({ report }: { report: ModelReport }) {
  const { bins, edgeMin, edgeMax } = useMemo(() => buildHistogramBins(report.score_hist), [report.score_hist]);

  const thresholdLabel = useMemo(() => {
    if (bins.length === 0) return undefined;
    let nearest = bins[0];
    for (const bin of bins) {
      if (Math.abs(bin.x - report.threshold) < Math.abs(nearest.x - report.threshold)) nearest = bin;
    }
    return nearest.label;
  }, [bins, report.threshold]);

  const tallest = useMemo(() => {
    if (bins.length === 0) return null;
    return bins.reduce((best, bin) => (bin.count > best.count ? bin : best), bins[0]);
  }, [bins]);

  if (bins.length === 0) {
    return <EmptyState icon={Activity} title="No score distribution recorded." testId="score-histogram-empty" />;
  }

  return (
    <div data-testid="score-histogram" className="h-56 w-full">
      {/* Test hooks (not visible UI): let e2e assert the tallest bar's x
       * falls inside the real edge range, without relying on pixel
       * geometry -- a direct check on the FB-1 bug's actual failure mode. */}
      <span className="sr-only" data-testid="histogram-tallest-x">
        {tallest?.x}
      </span>
      <span className="sr-only" data-testid="histogram-edge-min">
        {edgeMin}
      </span>
      <span className="sr-only" data-testid="histogram-edge-max">
        {edgeMax}
      </span>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={bins} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke="var(--color-border)" vertical={false} />
          <XAxis dataKey="label" stroke="var(--color-text-muted)" fontSize={10} tickLine={false} axisLine={false} minTickGap={20} />
          <YAxis
            stroke="var(--color-text-muted)"
            fontSize={10}
            tickLine={false}
            axisLine={false}
            width={36}
            tickFormatter={(v: number) => compactCount.format(v)}
          />
          <Tooltip
            formatter={(value) => [Number(value), "readings"]}
            labelFormatter={(label) => `score ${label}`}
            contentStyle={{ background: "var(--color-surface-raised)", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 12 }}
          />
          <Bar dataKey="count" fill="var(--color-info)" isAnimationActive={false} />
          {thresholdLabel && (
            <ReferenceLine
              x={thresholdLabel}
              stroke="var(--color-critical)"
              strokeDasharray="4 2"
              label={{ value: "threshold", position: "insideTopRight", fill: "var(--color-critical)", fontSize: 10 }}
            />
          )}
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function LiveScoreChart({ deviceId }: { deviceId: string | null }) {
  const [sinceMs] = useState(() => Date.now() - 60 * 60 * 1000);
  const scores = useModelScores({ device_id: deviceId ?? undefined, since_ms: sinceMs });

  if (!deviceId) {
    return <EmptyState icon={Activity} title="No device yet." detail="Scores need at least one device reporting." testId="live-score-empty" />;
  }
  if (scores.isLoading) return <Skeleton className="h-56 w-full" />;
  const points = scores.data?.points ?? [];
  if (points.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No scores yet."
        detail="Scores appear once the model is trained and this device has recent readings."
        testId="live-score-empty"
      />
    );
  }
  const threshold = scores.data?.threshold ?? 0;

  return (
    <div data-testid="live-score-chart" className="h-56 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid strokeDasharray="2 4" stroke="var(--color-border)" vertical={false} />
          <XAxis dataKey="ts" tickFormatter={(ts: number) => formatTime(ts).slice(0, 5)} stroke="var(--color-text-muted)" fontSize={10} tickLine={false} axisLine={false} minTickGap={40} />
          <YAxis stroke="var(--color-text-muted)" fontSize={10} tickLine={false} axisLine={false} width={40} />
          <Tooltip
            formatter={(value) => [Number(value).toFixed(3), "score"]}
            labelFormatter={(ts) => formatTime(Number(ts))}
            contentStyle={{ background: "var(--color-surface-raised)", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 12 }}
          />
          <ReferenceLine y={threshold} stroke="var(--color-critical)" strokeDasharray="4 2" />
          <Line
            type="monotone"
            dataKey="score"
            stroke="var(--color-info)"
            strokeWidth={1.5}
            isAnimationActive={false}
            dot={(props: any) => {
              const flagged = (props.payload?.score ?? 0) < threshold;
              return (
                <circle
                  key={props.payload?.ts ?? props.key}
                  cx={props.cx}
                  cy={props.cy}
                  r={flagged ? 3 : 0}
                  fill="var(--color-critical)"
                />
              );
            }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function InjectionTable({ forest, rule }: { forest: InjectionResult[]; rule: InjectionResult[] }) {
  if (forest.length === 0) return <EmptyState icon={Activity} title="No injection tests recorded." testId="injection-table-empty" />;
  return (
    <div className="overflow-x-auto">
      <table data-testid="injection-table" className="w-full min-w-[560px] text-left text-sm">
        <thead className="text-xs text-text-muted">
          <tr>
            <th className="px-2 py-2 font-medium">Step</th>
            <th className="px-2 py-2 font-medium">Forest</th>
            <th className="px-2 py-2 text-right font-medium">Latency</th>
            <th className="px-2 py-2 font-medium">Rule</th>
            <th className="px-2 py-2 text-right font-medium">Latency</th>
          </tr>
        </thead>
        <tbody>
          {forest.map((f, i) => {
            const r = rule[i];
            return (
              <tr key={i} data-testid="injection-row" className="border-t border-border">
                <td className="px-2 py-2 font-mono-nums text-text">
                  +{f.step_w} W, {f.duration_s}s
                </td>
                <td className="px-2 py-2">
                  <DetectedBadge detected={f.detected} />
                </td>
                <td className="px-2 py-2 text-right font-mono-nums text-text-muted">{formatLatencySeconds(f.latency_s)}</td>
                <td className="px-2 py-2">{r ? <DetectedBadge detected={r.detected} /> : "—"}</td>
                <td className="px-2 py-2 text-right font-mono-nums text-text-muted">{formatLatencySeconds(r?.latency_s)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function DetectedBadge({ detected }: { detected: boolean }) {
  return detected ? (
    <span className="inline-flex items-center gap-1 text-trace">
      <CheckCircle2 size={13} aria-hidden />
      Detected
    </span>
  ) : (
    <span className="inline-flex items-center gap-1 text-critical">
      <XCircle size={13} aria-hidden />
      Missed
    </span>
  );
}

function CandidatesTable({
  candidates,
  chosenFeatureSet,
  chosenThreshold,
}: {
  candidates: ModelCandidate[];
  chosenFeatureSet: string;
  chosenThreshold: number;
}) {
  return (
    <div className="overflow-x-auto">
      <table data-testid="candidates-table" className="w-full min-w-[520px] text-left text-sm">
        <thead className="text-xs text-text-muted">
          <tr>
            <th className="px-2 py-2 font-medium">Feature set</th>
            <th className="px-2 py-2 text-right font-medium">Threshold</th>
            <th className="px-2 py-2 text-right font-medium">False alarms/hr</th>
            <th className="px-2 py-2 text-right font-medium">Detection rate</th>
          </tr>
        </thead>
        <tbody>
          {candidates.map((c, i) => {
            const chosen = c.feature_set === chosenFeatureSet && Math.abs(c.threshold - chosenThreshold) < 1e-9;
            return (
              <tr key={i} data-testid="candidate-row" data-chosen={chosen} className={chosen ? "border-t border-trace bg-surface-raised" : "border-t border-border"}>
                <td className="px-2 py-2 text-text">
                  {c.feature_set}
                  {chosen && <span className="ml-2 rounded border border-trace px-1.5 py-0.5 text-[10px] text-trace">Chosen</span>}
                </td>
                <td className="px-2 py-2 text-right font-mono-nums text-text-muted">{c.threshold.toFixed(3)}</td>
                <td className="px-2 py-2 text-right font-mono-nums text-text-muted">{c.false_alarms_per_hour.toFixed(2)}</td>
                <td className="px-2 py-2 text-right font-mono-nums text-text-muted">{(c.detection_rate * 100).toFixed(0)}%</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

interface ParsedVariant {
  name: string;
  modelName?: string;
  promptVersion?: string;
  score?: number;
  p50Ms?: number;
  p95Ms?: number;
}

/** `LlmStatus.eval.variants` is `unknown[]` in the contract (eval_report.json's
 * exact per-variant shape is the ML agent's to define) — read it
 * defensively so this table degrades to "—" instead of crashing if a field
 * is missing or differently named. Checked against the real endpoint: it
 * names the composite score `composite` (not `score`) and latency
 * `latency_p50_ms`/`latency_p95_ms` (not `p50_ms`/`p95_ms`) — both are read
 * here, falling back to the plan's names so either shape renders. */
function parseVariant(v: unknown, index: number): ParsedVariant {
  const o = (v ?? {}) as Record<string, unknown>;
  const promptVersion = typeof o.prompt_version === "string" ? o.prompt_version : undefined;
  const modelName = typeof o.model === "string" ? o.model : undefined;
  const name = [promptVersion, modelName].filter(Boolean).join(" / ") || `Variant ${index + 1}`;
  const score = typeof o.composite === "number" ? o.composite : typeof o.score === "number" ? o.score : undefined;
  const p50Ms = typeof o.latency_p50_ms === "number" ? o.latency_p50_ms : typeof o.p50_ms === "number" ? o.p50_ms : undefined;
  const p95Ms = typeof o.latency_p95_ms === "number" ? o.latency_p95_ms : typeof o.p95_ms === "number" ? o.p95_ms : undefined;
  return { name, modelName, promptVersion, score, p50Ms, p95Ms };
}

function EvalTable({ evalData }: { evalData: { chosen: unknown; variants: unknown[] } }) {
  if (evalData.variants.length === 0) return <p className="text-xs text-text-muted">No evaluation run yet.</p>;
  // The real endpoint's `chosen` is the winning variant object itself, not
  // a name string — parse it the same way as each row and match on
  // model + prompt version, falling back to a plain string compare in case
  // a future build sends `chosen` as a name instead.
  const chosenParsed = parseVariant(evalData.chosen, -1);
  const chosenAsString = typeof evalData.chosen === "string" ? evalData.chosen : null;
  return (
    <div className="overflow-x-auto">
      <table data-testid="eval-table" className="w-full min-w-[520px] text-left text-sm">
        <thead className="text-xs text-text-muted">
          <tr>
            <th className="px-2 py-2 font-medium">Variant</th>
            <th className="px-2 py-2 text-right font-medium">Score</th>
            <th className="px-2 py-2 text-right font-medium">p50</th>
            <th className="px-2 py-2 text-right font-medium">p95</th>
          </tr>
        </thead>
        <tbody>
          {evalData.variants.map((raw, i) => {
            const v = parseVariant(raw, i);
            const chosen =
              (chosenParsed.modelName != null && chosenParsed.modelName === v.modelName && chosenParsed.promptVersion === v.promptVersion) ||
              chosenAsString === v.name ||
              chosenAsString === v.modelName;
            return (
              <tr key={i} data-testid="eval-row" data-chosen={chosen} className={chosen ? "border-t border-trace bg-surface-raised" : "border-t border-border"}>
                <td className="px-2 py-2 text-text">
                  {v.name}
                  {chosen && <span className="ml-2 rounded border border-trace px-1.5 py-0.5 text-[10px] text-trace">Chosen</span>}
                </td>
                <td className="px-2 py-2 text-right font-mono-nums text-text-muted">{v.score != null ? v.score.toFixed(3) : "—"}</td>
                <td className="px-2 py-2 text-right font-mono-nums text-text-muted">{v.p50Ms != null ? `${v.p50Ms} ms` : "—"}</td>
                <td className="px-2 py-2 text-right font-mono-nums text-text-muted">{v.p95Ms != null ? `${v.p95Ms} ms` : "—"}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function IncidentsTable() {
  const [sinceMs] = useState(() => Date.now() - 24 * 60 * 60 * 1000);
  const incidents = useIncidents({ since_ms: sinceMs, limit: 100 });

  if (incidents.isLoading) return <Skeleton className="h-64 w-full" />;
  if (!incidents.data || incidents.data.length === 0) {
    return (
      <EmptyState
        icon={Activity}
        title="No incidents in the last 24 hours."
        detail="Spikes and unusual patterns will be listed here as they happen."
        testId="modellab-incidents-empty"
      />
    );
  }
  return (
    <div className="overflow-x-auto">
      <table data-testid="modellab-incidents-table" className="w-full min-w-[860px] text-left text-sm">
        <thead className="text-xs text-text-muted">
          <tr>
            <th className="px-2 py-2 font-medium">Start</th>
            <th className="px-2 py-2 font-medium">Duration</th>
            <th className="px-2 py-2 text-right font-medium">Peak</th>
            <th className="px-2 py-2 text-right font-medium">Baseline</th>
            <th className="px-2 py-2 text-right font-medium">Rule score</th>
            <th className="px-2 py-2 text-right font-medium">ML score</th>
            <th className="px-2 py-2 font-medium">Detected by</th>
            <th className="px-2 py-2 font-medium">Explanation</th>
          </tr>
        </thead>
        <tbody>
          {incidents.data.map((inc) => (
            <tr key={inc.id} data-testid="modellab-incident-row" className="border-t border-border">
              <td className="px-2 py-2 font-mono-nums text-text-muted">{formatDateTime(inc.start_ts)}</td>
              <td className="px-2 py-2 font-mono-nums text-text-muted">{formatDuration(inc.duration_s)}</td>
              <td className="px-2 py-2 text-right font-mono-nums text-text">{formatWatts(inc.peak_w)}</td>
              <td className="px-2 py-2 text-right font-mono-nums text-text-muted">{formatWatts(inc.baseline_w)}</td>
              <td className="px-2 py-2 text-right font-mono-nums text-text-muted">{inc.rule_score != null ? inc.rule_score.toFixed(2) : "—"}</td>
              <td className="px-2 py-2 text-right font-mono-nums text-text-muted">{inc.iforest_score != null ? inc.iforest_score.toFixed(2) : "—"}</td>
              <td className="px-2 py-2">
                <span className="flex items-center gap-1">
                  {inc.methods.includes("rule") && <MethodChip method="rule" />}
                  {inc.methods.includes("iforest") && <MethodChip method="iforest" />}
                </span>
              </td>
              <td className="max-w-xs px-2 py-2 text-text-muted">{inc.explanation ?? "Explaining…"}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
