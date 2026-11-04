// react-query hooks. Polling intervals per the plan:
// overview/devices/health/topology 2s; readings 2s for <=1h windows, 30s
// otherwise; alerts 3s; events 5s; rules/settings on demand (no polling).
import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  api,
  type AlertSeverity,
  type DevicePatch,
  type EventMethod,
  type RuleCreate,
  type RulePatch,
  type SettingsPatch,
  type TopologyPatch,
} from "./client";
import { useStreamStatus } from "./stream";

/** F1-2: "polling stays on as the fallback, at 10s while SSE is healthy and
 * 2s when it is not." Applied to the queries the SSE `event`/`alert`
 * frames already keep fresh via useStreamBridge — when the stream is live,
 * those frames do the real-time work and polling only needs to catch
 * anything missed; when it isn't, polling is the only thing keeping the
 * page honest, so it runs hot. */
function useAdaptiveInterval(healthyMs = 10_000, unhealthyMs = 2_000): number {
  const { state } = useStreamStatus();
  return state === "live" ? healthyMs : unhealthyMs;
}

export function useHealth() {
  const interval = useAdaptiveInterval(10_000, 2_000);
  return useQuery({ queryKey: ["health"], queryFn: api.health, refetchInterval: interval });
}

export function useOverview() {
  const interval = useAdaptiveInterval();
  return useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: interval });
}

export function useDevices() {
  const interval = useAdaptiveInterval();
  return useQuery({ queryKey: ["devices"], queryFn: api.devices, refetchInterval: interval });
}

export function useDevice(deviceId: string | undefined) {
  return useQuery({
    queryKey: ["device", deviceId],
    queryFn: () => api.device(deviceId as string),
    enabled: !!deviceId,
    refetchInterval: 2000,
  });
}

export function usePatchDevice(deviceId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: DevicePatch) => api.patchDevice(deviceId, patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["device", deviceId] });
      qc.invalidateQueries({ queryKey: ["devices"] });
    },
  });
}

export function useReadings(params: { device_id: string; since_ms?: number; until_ms?: number; max_points?: number }) {
  const spanMs = params.until_ms && params.since_ms ? params.until_ms - params.since_ms : 10 * 60 * 1000;
  const interval = spanMs <= 60 * 60 * 1000 ? 2000 : 30000;
  return useQuery({
    queryKey: ["readings", params],
    queryFn: () => api.readings(params),
    refetchInterval: interval,
    enabled: !!params.device_id,
    // A sliding window means since_ms/until_ms (and so the query key) move
    // every tick; keep the last frame on screen instead of flashing a
    // loading skeleton on every poll.
    placeholderData: keepPreviousData,
  });
}

export function useEnergyDaily(params?: { device_id?: string; days?: number }) {
  return useQuery({ queryKey: ["energy-daily", params], queryFn: () => api.energyDaily(params) });
}

export function useEvents(params?: { device_id?: string; method?: EventMethod; since_ms?: number; limit?: number }) {
  return useQuery({ queryKey: ["events", params], queryFn: () => api.events(params), refetchInterval: 5000 });
}

export function useIncidents(params?: { device_id?: string; since_ms?: number; limit?: number }) {
  return useQuery({ queryKey: ["incidents", params], queryFn: () => api.incidents(params), refetchInterval: 5000 });
}

export function useAlerts(params?: { status?: string; severity?: AlertSeverity; device_id?: string; limit?: number }) {
  const interval = useAdaptiveInterval(10_000, 3_000);
  return useQuery({ queryKey: ["alerts", params], queryFn: () => api.alerts(params), refetchInterval: interval });
}

export function useAlertsSummary() {
  const interval = useAdaptiveInterval(10_000, 3_000);
  return useQuery({ queryKey: ["alerts-summary"], queryFn: api.alertsSummary, refetchInterval: interval });
}

export function useAckAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.ackAlert(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alerts"] });
      qc.invalidateQueries({ queryKey: ["alerts-summary"] });
    },
  });
}

export function useResolveAlert() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.resolveAlert(id),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["alerts"] });
      qc.invalidateQueries({ queryKey: ["alerts-summary"] });
    },
  });
}

export function useRules() {
  return useQuery({ queryKey: ["rules"], queryFn: api.rules });
}

export function useCreateRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (rule: RuleCreate) => api.createRule(rule),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });
}

export function usePatchRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: number; patch: RulePatch }) => api.patchRule(id, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });
}

export function useDeleteRule() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: number) => api.deleteRule(id),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["rules"] }),
  });
}

export function useTopology() {
  const interval = useAdaptiveInterval();
  return useQuery({ queryKey: ["topology"], queryFn: api.topology, refetchInterval: interval });
}

export function usePatchTopologyNode() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ nodeId, patch }: { nodeId: string; patch: TopologyPatch }) => api.patchTopologyNode(nodeId, patch),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["topology"] }),
  });
}

export function useSettings() {
  return useQuery({ queryKey: ["settings"], queryFn: api.settings });
}

export function usePatchSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => api.patchSettings(patch),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["settings"] });
      qc.invalidateQueries({ queryKey: ["overview"] });
    },
  });
}

// ---- v2 --------------------------------------------------------------

export function useNodes() {
  const interval = useAdaptiveInterval();
  return useQuery({ queryKey: ["nodes"], queryFn: api.nodes, refetchInterval: interval });
}

export function useNode(nodeId: string | undefined) {
  return useQuery({
    queryKey: ["node", nodeId],
    queryFn: () => api.node(nodeId as string),
    enabled: !!nodeId,
    refetchInterval: 2000,
  });
}

export function useSystem() {
  const interval = useAdaptiveInterval(5_000, 2_000);
  return useQuery({ queryKey: ["system"], queryFn: api.system, refetchInterval: interval });
}

export function useAudit(limit = 100) {
  return useQuery({ queryKey: ["audit", limit], queryFn: () => api.audit(limit), refetchInterval: 10_000 });
}

export function useAnalyticsSummary() {
  return useQuery({ queryKey: ["analytics-summary"], queryFn: api.analyticsSummary, refetchInterval: 10_000 });
}

export function useAnalyticsHourly(params?: { days?: number; device_id?: string }) {
  return useQuery({ queryKey: ["analytics-hourly", params], queryFn: () => api.analyticsHourly(params) });
}

export function useAnalyticsBreakdown(params?: { since_ms?: number; until_ms?: number }) {
  return useQuery({ queryKey: ["analytics-breakdown", params], queryFn: () => api.analyticsBreakdown(params) });
}

export function useModel() {
  return useQuery({ queryKey: ["model"], queryFn: api.model, refetchInterval: 5_000 });
}

export function useModelScores(params: { device_id?: string; since_ms?: number }) {
  return useQuery({
    queryKey: ["model-scores", params],
    queryFn: () => api.modelScores(params),
    enabled: !!params.device_id,
    refetchInterval: 5_000,
    placeholderData: keepPreviousData,
  });
}

export function useTrainModel() {
  return useMutation({ mutationFn: () => api.trainModel() });
}

export function useTrainJob(jobId: string | undefined) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: ["train-job", jobId],
    queryFn: () => api.trainJob(jobId as string),
    enabled: !!jobId,
    refetchInterval: (query) => {
      const status = query.state.data?.status;
      if (status === "done" || status === "error") {
        qc.invalidateQueries({ queryKey: ["model"] });
        return false;
      }
      return 800;
    },
  });
}

export function useInsights(limit = 20) {
  return useQuery({ queryKey: ["insights", limit], queryFn: () => api.insights(limit), refetchInterval: 15_000 });
}

export function useGenerateDigest() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => api.generateDigest(),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["insights"] }),
  });
}

export function useLlm() {
  return useQuery({ queryKey: ["llm"], queryFn: api.llm, refetchInterval: 10_000 });
}
