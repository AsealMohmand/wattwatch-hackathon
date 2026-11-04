// Single source of truth for API types and calls. Everything here mirrors
// the contract in docs/plans/2026-11-03-wattwatch-console.md exactly — do
// not add fields the contract doesn't have.

const BASE = "/api";

export class ApiError extends Error {
  status: number;
  constructor(status: number, detail: string) {
    super(detail);
    this.status = status;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(init?.headers ?? {}) },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      if (body?.detail) detail = body.detail;
    } catch {
      // ignore
    }
    throw new ApiError(res.status, detail);
  }
  if (res.status === 204) return undefined as T;
  return (await res.json()) as T;
}

function qs(params: Record<string, string | number | boolean | undefined | null>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`);
  }
  return parts.length ? `?${parts.join("&")}` : "";
}

/** Encode a device id (may contain "/") for use in a path segment. */
export function encodeDeviceId(deviceId: string): string {
  return encodeURIComponent(deviceId);
}

// ---- types -------------------------------------------------------------

export type DeviceKind =
  | "unknown"
  | "kettle"
  | "heater"
  | "fridge"
  | "computer"
  | "lighting"
  | "tv"
  | "washer"
  | "dryer"
  | "microwave"
  | "other";

export interface Health {
  ok: boolean;
  now_ms: number;
  readings: number;
  last_reading_ts: number | null;
  iforest: { trained: boolean; trained_at: number | null; threshold: number | null };
  llm: { model: string; reachable: boolean };
}

export interface Overview {
  now_ms: number;
  total_w: number;
  devices_online: number;
  devices_total: number;
  kwh_today: number;
  cost_today: number;
  currency: string;
  events_today: number;
  open_alerts: number;
  critical_alerts: number;
}

export interface Device {
  device_id: string;
  name: string;
  kind: DeviceKind;
  room: string | null;
  rated_w: number | null;
  notes: string | null;
  online: boolean;
  last_ts: number | null;
  watts: number | null;
  /** The latest reading regardless of age — populated even when `watts` is
   * null because the device is offline (r1 contract amendment). */
  last_watts: number | null;
  kwh_today: number;
  events_today: number;
  open_alerts: number;
}

export interface DeviceDetail extends Device {
  stats: {
    avg_w_1h: number | null;
    peak_w_24h: number | null;
    kwh_today: number;
    kwh_7d: number;
    on_time_today_s: number;
    baseline_w: number | null;
    first_seen_ts: number | null;
  };
}

export interface DevicePatch {
  name?: string;
  kind?: DeviceKind;
  room?: string | null;
  rated_w?: number | null;
  notes?: string | null;
}

export interface ReadingPoint {
  ts: number;
  avg_w: number;
  max_w: number;
}

export interface ReadingsResponse {
  device_id: string;
  bucket_ms: number;
  points: ReadingPoint[];
  /** The device's newest reading, any age — null if it has never reported.
   * Lets the UI tell "no data in this window" apart from "no data ever"
   * (r1 contract amendment). */
  last_ts: number | null;
}

export interface DailyEnergy {
  day: string;
  kwh: number;
  cost: number;
  peak_w: number;
}

export type EventMethod = "rule" | "iforest";

export interface EnergyEvent {
  id: number;
  device_id: string;
  start_ts: number;
  end_ts: number;
  duration_s: number;
  peak_w: number;
  baseline_w: number | null;
  score: number | null;
  method: EventMethod;
  explanation: string | null;
  /** v2: structured AI explanation, null before Llama fills it (or if the
   * explainer never ran on this event). */
  ai: Explanation | null;
}

export type AlertSeverity = "info" | "warning" | "critical";
export type AlertStatus = "open" | "acknowledged" | "resolved";

export interface Alert {
  id: number;
  rule_id: number | null;
  device_id: string;
  device_name: string;
  kind: string;
  severity: AlertSeverity;
  title: string;
  detail: string | null;
  event_id: number | null;
  value: number | null;
  status: AlertStatus;
  opened_ts: number;
  updated_ts: number;
  acked_ts: number | null;
  resolved_ts: number | null;
  /** Which detector(s) fired: "rule" and/or "iforest". A spike alert lists
   * "iforest" too when an overlapping anomaly event exists (r1 contract
   * amendment). */
  detectors: string[];
  /** v2: structured AI explanation for the alert's underlying event. */
  ai: Explanation | null;
}

/** A merged rule+ML event on one device (r1 contract amendment). Incidents
 * collapse the old "2 alerts per boil" noise into one row. */
export interface Incident {
  id: string;
  device_id: string;
  device_name: string;
  start_ts: number;
  end_ts: number;
  duration_s: number;
  peak_w: number;
  baseline_w: number | null;
  methods: string[];
  rule_score: number | null;
  iforest_score: number | null;
  explanation: string | null;
  event_ids: number[];
  /** v2: structured AI explanation for the incident. */
  ai: Explanation | null;
}

export interface AlertsSummary {
  open: number;
  acknowledged: number;
  resolved_24h: number;
  by_severity: { info: number; warning: number; critical: number };
}

export type RuleKind = "spike" | "anomaly" | "over_power" | "offline" | "daily_energy" | "always_on" | "hardware_limit";

export interface Rule {
  id: number;
  name: string;
  kind: RuleKind;
  device_id: string | null;
  threshold: number | null;
  duration_s: number;
  severity: AlertSeverity;
  enabled: boolean;
}

export interface RuleCreate {
  name: string;
  kind: RuleKind;
  device_id?: string | null;
  threshold?: number | null;
  duration_s: number;
  severity: AlertSeverity;
  enabled: boolean;
}

export type RulePatch = Partial<RuleCreate>;

export type TopologyNodeKind = "hub" | "node" | "port" | "appliance";
export type TopologyStatus = "online" | "offline" | "unknown";

export interface TopologyNode {
  id: string;
  kind: TopologyNodeKind;
  label: string;
  parent: string | null;
  status: TopologyStatus;
  watts: number | null;
  device_id: string | null;
  x: number | null;
  y: number | null;
}

export interface Topology {
  nodes: TopologyNode[];
}

export interface TopologyPatch {
  label?: string;
  x?: number;
  y?: number;
}

export interface Settings {
  price_per_kwh: number;
  currency: string;
  volts: number;
  offline_after_s: number;
  /** v2: single-site label shown in the shell's site switcher. */
  site_name: string;
  /** v2: CO2 factor used by /api/analytics/summary, kg per kWh. */
  co2_kg_per_kwh: number;
}

export type SettingsPatch = Partial<Settings>;

// ---- v2: structured AI explanation --------------------------------------
// Shared by Event/Incident/Alert (each gains an `ai` field) and by
// GET /api/explanations/{event_id}. Lives here (not FE-2's api/ai.ts)
// because it's embedded directly in types this file already owns.

export type AiConfidence = "low" | "medium" | "high";
export type AiVerdict = "normal" | "check";

export interface Explanation {
  appliance: string | null;
  confidence: AiConfidence | null;
  verdict: AiVerdict | null;
  summary: string;
  model: string;
  latency_ms: number | null;
  fallback: boolean;
}

// ---- v2: nodes / firmware telemetry --------------------------------------

export interface NodePort {
  port: string;
  device_id: string | null;
  device_name: string | null;
  online: boolean;
  irms_raw_a: number | null;
  peak_raw_a: number | null;
  crest_factor: number | null;
  n_samples: number | null;
  sample_rate_hz: number | null;
  over_limit: boolean;
  last_ts: number | null;
  readings: number;
}

export interface Node {
  node_id: string;
  fw: string | null;
  online: boolean;
  first_seen_ts: number | null;
  last_ts: number | null;
  boots: number;
  uptime_ms: number | null;
  readings_per_min: number;
  ports: NodePort[];
}

export interface NodeTelemetryPoint {
  ts: number;
  port: string;
  uptime_ms: number | null;
  n_samples: number | null;
  irms_raw_a: number | null;
  peak_raw_a: number | null;
}

export interface NodeDetail extends Node {
  telemetry: NodeTelemetryPoint[];
}

// ---- v2: system / service health -----------------------------------------

export type ServiceStatusKind = "running" | "stale" | "down";

export interface ServiceInfo {
  service: string;
  pid: number | null;
  status: ServiceStatusKind;
  heartbeat_age_s: number | null;
  started_ts: number | null;
  info: Record<string, unknown> | null;
}

export interface SystemStatus {
  services: ServiceInfo[];
  db: { size_bytes: number; readings: number; events: number; alerts: number };
  ingest: { readings_per_min: number; last_ts: number | null };
  versions: { api: string; python: string; ollama_model: string };
  now_ms: number;
}

export interface AuditEntry {
  id: number;
  ts: number;
  actor: string;
  action: string;
  target: string | null;
  detail: string | null;
}

// ---- v2: analytics ---------------------------------------------------------

export interface AnalyticsSummary {
  kwh_today: number;
  /** Null when yesterday's readings cover under 80% of the day -- early in a
   * demo DB's life "yesterday" can be almost entirely empty, and a number
   * computed from next to no data is worse than no number. */
  kwh_yesterday: number | null;
  kwh_mtd: number;
  cost_today: number;
  cost_mtd: number;
  projected_month_kwh: number;
  projected_month_cost: number;
  co2_kg_today: number;
  co2_kg_mtd: number;
  always_on_w: number;
  active_w: number;
  peak_today_w: number;
  peak_today_ts: number | null;
  currency: string;
  /** r1 BK-1: yesterday from 00:00 to the same clock time as now, for an
   * apples-to-apples "vs this time yesterday" delta (the old kwh_yesterday
   * compared a partial today against a full yesterday). Optional because a
   * backend agent is adding this field in parallel -- treat its absence as
   * "not available yet", not an error. */
  kwh_yesterday_same_time?: number | null;
}

export interface HourlyKwh {
  day: string;
  hour: number;
  kwh: number;
}

export interface BreakdownRow {
  device_id: string;
  device_name: string;
  kwh: number;
  cost: number;
  share: number;
}

// ---- v2: model lab ----------------------------------------------------------

export interface InjectionResult {
  step_w: number;
  duration_s: number;
  detected: boolean;
  latency_s: number | null;
}

export interface ModelCandidate {
  feature_set: string;
  threshold: number;
  false_alarms_per_hour: number;
  detection_rate: number;
}

export interface ModelReport {
  version: number;
  trained_at: number;
  feature_set: string;
  features: string[];
  rows: number;
  window: { start_ts: number; end_ts: number };
  threshold: number;
  contamination: number;
  score_hist: { edges: number[]; counts: number[] };
  train_score_pctl: { p0_1: number; p1: number; p5: number; p50: number };
  backtest: {
    idle_hours: number;
    false_alarm_events: number;
    false_alarms_per_hour: number;
    injections: InjectionResult[];
    rule_injections: InjectionResult[];
  };
  candidates: ModelCandidate[];
  chosen_reason: string;
}

export interface ModelStatus {
  exists: boolean;
  report: ModelReport | null;
  model_mtime: number | null;
}

export interface ModelScorePoint {
  ts: number;
  score: number;
}

export interface ModelScores {
  threshold: number | null;
  points: ModelScorePoint[];
}

export type TrainJobStatus = "queued" | "running" | "done" | "error";

export interface TrainJob {
  job_id: string;
  status: TrainJobStatus;
  progress: number;
  message: string;
  report: ModelReport | null;
}

export interface LlmStatus {
  model: string;
  reachable: boolean;
  prompt_version: string;
  eval: { chosen: string; variants: unknown[] } | null;
}

// ---- v2: insights (daily digests) ------------------------------------------

export interface Insight {
  id: number;
  kind: string;
  created_ts: number;
  period_start: number | null;
  period_end: number | null;
  title: string;
  body: string;
  model: string | null;
  latency_ms: number | null;
}

// ---- calls ---------------------------------------------------------------

export const api = {
  health: () => request<Health>("/health"),
  overview: () => request<Overview>("/overview"),

  devices: () => request<Device[]>("/devices"),
  device: (deviceId: string) => request<DeviceDetail>(`/devices/${encodeDeviceId(deviceId)}`),
  patchDevice: (deviceId: string, patch: DevicePatch) =>
    request<Device>(`/devices/${encodeDeviceId(deviceId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  readings: (params: { device_id: string; since_ms?: number; until_ms?: number; max_points?: number }) =>
    request<ReadingsResponse>(`/readings${qs(params)}`),

  energyDaily: (params?: { device_id?: string; days?: number }) =>
    request<DailyEnergy[]>(`/energy/daily${qs(params ?? {})}`),

  events: (params?: { device_id?: string; method?: EventMethod; since_ms?: number; limit?: number }) =>
    request<EnergyEvent[]>(`/events${qs(params ?? {})}`),

  incidents: (params?: { device_id?: string; since_ms?: number; limit?: number }) =>
    request<Incident[]>(`/incidents${qs(params ?? {})}`),

  alerts: (params?: { status?: string; severity?: AlertSeverity; device_id?: string; limit?: number }) =>
    request<Alert[]>(`/alerts${qs(params ?? {})}`),
  alertsSummary: () => request<AlertsSummary>("/alerts/summary"),
  ackAlert: (id: number) => request<Alert>(`/alerts/${id}/ack`, { method: "POST" }),
  resolveAlert: (id: number) => request<Alert>(`/alerts/${id}/resolve`, { method: "POST" }),

  rules: () => request<Rule[]>("/rules"),
  createRule: (rule: RuleCreate) => request<Rule>("/rules", { method: "POST", body: JSON.stringify(rule) }),
  patchRule: (id: number, patch: RulePatch) =>
    request<Rule>(`/rules/${id}`, { method: "PATCH", body: JSON.stringify(patch) }),
  deleteRule: (id: number) => request<void>(`/rules/${id}`, { method: "DELETE" }),

  topology: () => request<Topology>("/topology"),
  patchTopologyNode: (nodeId: string, patch: TopologyPatch) =>
    request<TopologyNode>(`/topology/${encodeDeviceId(nodeId)}`, {
      method: "PATCH",
      body: JSON.stringify(patch),
    }),

  settings: () => request<Settings>("/settings"),
  patchSettings: (patch: SettingsPatch) =>
    request<Settings>("/settings", { method: "PATCH", body: JSON.stringify(patch) }),

  // ---- v2 ------------------------------------------------------------

  nodes: () => request<Node[]>("/nodes"),
  node: (nodeId: string) => request<NodeDetail>(`/nodes/${encodeDeviceId(nodeId)}`),

  system: () => request<SystemStatus>("/system"),
  audit: (limit = 100) => request<AuditEntry[]>(`/audit${qs({ limit })}`),

  analyticsSummary: () => request<AnalyticsSummary>("/analytics/summary"),
  analyticsHourly: (params?: { days?: number; device_id?: string }) =>
    request<HourlyKwh[]>(`/analytics/hourly${qs(params ?? {})}`),
  analyticsBreakdown: (params?: { since_ms?: number; until_ms?: number }) =>
    request<BreakdownRow[]>(`/analytics/breakdown${qs(params ?? {})}`),

  /** Not fetched via `request` — handed to the browser as a download link. */
  readingsCsvUrl: (params: { device_id?: string; since_ms?: number; until_ms?: number }) =>
    `${BASE}/export/readings.csv${qs(params)}`,
  eventsCsvUrl: (params?: { since_ms?: number }) => `${BASE}/export/events.csv${qs(params ?? {})}`,

  model: () => request<ModelStatus>("/model"),
  modelScores: (params: { device_id?: string; since_ms?: number }) =>
    request<ModelScores>(`/model/scores${qs(params)}`),
  trainModel: () => request<{ job_id: string }>("/model/train", { method: "POST" }),
  trainJob: (jobId: string) => request<TrainJob>(`/model/train/${jobId}`),

  explanation: (eventId: number) => request<Explanation>(`/explanations/${eventId}`),

  insights: (limit = 20) => request<Insight[]>(`/insights${qs({ limit })}`),
  generateDigest: () => request<Insight>("/insights/digest", { method: "POST" }),

  llm: () => request<LlmStatus>("/llm"),
};
