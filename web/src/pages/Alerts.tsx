import { CheckCheck, CheckCircle2, Circle, ClipboardCheck, Siren, X } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { Area, AreaChart, ResponsiveContainer, Tooltip, XAxis } from "recharts";
import type { Alert, AlertSeverity } from "../api/client";
import { useAckAlert, useAlerts, useAlertsSummary, useDevices, useReadings, useResolveAlert, useRules } from "../api/hooks";
import { AiMeta } from "../components/ai/AiMeta";
import { ConfidenceMeter } from "../components/ai/ConfidenceMeter";
import { VerdictChip } from "../components/ai/VerdictChip";
import { EmptyState } from "../components/EmptyState";
import { DetectorsChip, SeverityTag } from "../components/SeverityTag";
import { Skeleton } from "../components/Skeleton";
import { formatAbsoluteShort, formatDateTime, formatRelative, formatTime, formatWatts } from "../lib/format";

type Tab = "alerts" | "rules";

type StatusFilter = "active" | "resolved" | "all";

const MOBILE_BREAKPOINT_PX = 768;

/** True under 768px, kept in sync with a matchMedia listener (not just a
 * CSS class toggle) because the mobile layout below swaps in a different
 * element tree per row, not just different column visibility. */
function useIsMobile(breakpointPx: number): boolean {
  const query = `(max-width: ${breakpointPx - 1}px)`;
  const [isMobile, setIsMobile] = useState(() => (typeof window !== "undefined" ? window.matchMedia(query).matches : false));
  useEffect(() => {
    const mql = window.matchMedia(query);
    const onChange = () => setIsMobile(mql.matches);
    onChange();
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, [query]);
  return isMobile;
}

const STATUS_CHIPS: { value: StatusFilter; label: string }[] = [
  { value: "active", label: "Active" },
  { value: "resolved", label: "Resolved" },
  { value: "all", label: "All" },
];

const SEVERITY_CHIPS: { value: AlertSeverity | "all"; label: string }[] = [
  { value: "all", label: "All severities" },
  { value: "info", label: "Info" },
  { value: "warning", label: "Warning" },
  { value: "critical", label: "Critical" },
];

export function Alerts() {
  const [params, setParams] = useSearchParams();
  const [tab, setTab] = useState<Tab>("alerts");
  const [status, setStatus] = useState<StatusFilter>("active");
  const [severity, setSeverity] = useState<AlertSeverity | "all">("all");
  const [deviceId, setDeviceId] = useState<string>(() => params.get("device_id") ?? "all");
  const [nowMs, setNowMs] = useState(Date.now());
  const [selectedIds, setSelectedIds] = useState<Set<number>>(new Set());
  const isMobile = useIsMobile(MOBILE_BREAKPOINT_PX);

  useEffect(() => {
    const id = window.setInterval(() => setNowMs(Date.now()), 1000);
    return () => window.clearInterval(id);
  }, []);

  const devices = useDevices();
  const alerts = useAlerts({
    status: status === "all" ? undefined : status,
    severity: severity === "all" ? undefined : severity,
    device_id: deviceId === "all" ? undefined : deviceId,
    limit: 100,
  });
  const summary = useAlertsSummary();
  const rules = useRules();
  const ack = useAckAlert();
  const resolve = useResolveAlert();

  const openId = params.get("open");
  const selected = useMemo(() => alerts.data?.find((a) => String(a.id) === openId) ?? null, [alerts.data, openId]);

  function openDrawer(a: Alert) {
    setParams({ open: String(a.id) });
  }
  function closeDrawer() {
    const next = new URLSearchParams(params);
    next.delete("open");
    setParams(next);
  }

  function toggleSelected(id: number) {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  function bulkAck() {
    for (const id of selectedIds) ack.mutate(id);
    setSelectedIds(new Set());
  }
  function bulkResolve() {
    for (const id of selectedIds) resolve.mutate(id);
    setSelectedIds(new Set());
  }

  return (
    <div className="flex flex-col gap-4">
      <div className="flex gap-1 rounded-md border border-border p-1" data-testid="alerts-tabs" role="tablist">
        <button
          type="button"
          data-testid="alerts-tab-alerts"
          role="tab"
          aria-selected={tab === "alerts"}
          onClick={() => setTab("alerts")}
          className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
            tab === "alerts" ? "bg-trace text-[#0b1612]" : "text-text-muted hover:bg-surface-raised"
          }`}
        >
          Alerts
        </button>
        <button
          type="button"
          data-testid="alerts-tab-rules"
          role="tab"
          aria-selected={tab === "rules"}
          onClick={() => setTab("rules")}
          className={`rounded px-3 py-1.5 text-xs font-medium transition-colors ${
            tab === "rules" ? "bg-trace text-[#0b1612]" : "text-text-muted hover:bg-surface-raised"
          }`}
        >
          Rules
        </button>
      </div>

      {tab === "rules" ? (
        <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-text">Alert rules</h2>
            <Link to="/settings" className="text-xs text-trace hover:underline">
              Edit in settings
            </Link>
          </div>
          {rules.isLoading ? (
            <Skeleton className="h-32 w-full" />
          ) : rules.data && rules.data.length > 0 ? (
            <ul data-testid="alerts-rules-list" className="flex flex-col gap-1.5">
              {rules.data.map((r) => (
                <li key={r.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm">
                  <span className="text-text">{r.name}</span>
                  <span className="flex items-center gap-2">
                    <SeverityTag severity={r.severity} />
                    <span className={`text-xs ${r.enabled ? "text-trace" : "text-text-muted"}`}>{r.enabled ? "Enabled" : "Disabled"}</span>
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-sm text-text-muted">No rules configured yet.</p>
          )}
        </section>
      ) : (
        <>
      <section data-testid="alerts-summary" className="grid grid-cols-3 gap-3">
        <div className="rounded-md border border-border bg-surface px-4 py-3">
          <span className="block text-xs text-text-muted">Open</span>
          <span className="font-mono-nums text-xl text-text">{summary.data?.open ?? "—"}</span>
        </div>
        <div className="rounded-md border border-border bg-surface px-4 py-3">
          <span className="block text-xs text-text-muted">Acknowledged</span>
          <span className="font-mono-nums text-xl text-text">{summary.data?.acknowledged ?? "—"}</span>
        </div>
        <div className="rounded-md border border-border bg-surface px-4 py-3">
          <span className="block text-xs text-text-muted">Resolved, 24h</span>
          <span className="font-mono-nums text-xl text-text">{summary.data?.resolved_24h ?? "—"}</span>
        </div>
      </section>

      <div className="flex flex-wrap items-center gap-3">
        <div className="flex gap-1 rounded-md border border-border p-1" data-testid="status-filter">
          {STATUS_CHIPS.map((c) => (
            <button
              key={c.value}
              type="button"
              data-testid={`status-chip-${c.value}`}
              aria-pressed={status === c.value}
              onClick={() => setStatus(c.value)}
              className={`rounded px-2.5 py-1 text-xs font-medium transition-colors ${
                status === c.value ? "bg-trace text-[#0b1612]" : "text-text-muted hover:bg-surface-raised"
              }`}
            >
              {c.label}
            </button>
          ))}
        </div>
        <select
          data-testid="severity-filter"
          value={severity}
          onChange={(e) => setSeverity(e.target.value as AlertSeverity | "all")}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text"
        >
          {SEVERITY_CHIPS.map((c) => (
            <option key={c.value} value={c.value}>
              {c.label}
            </option>
          ))}
        </select>
        <select
          data-testid="device-filter"
          value={deviceId}
          onChange={(e) => setDeviceId(e.target.value)}
          className="rounded-md border border-border bg-surface px-2 py-1.5 text-xs text-text"
        >
          <option value="all">All devices</option>
          {(devices.data ?? []).map((d) => (
            <option key={d.device_id} value={d.device_id}>
              {d.name}
            </option>
          ))}
        </select>
      </div>

      {selectedIds.size > 0 && (
        <div data-testid="bulk-action-bar" className="flex items-center justify-between gap-3 rounded-md border border-trace bg-surface px-3 py-2">
          <span className="text-xs text-text-muted">{selectedIds.size} selected</span>
          <div className="flex gap-2">
            <button
              type="button"
              data-testid="bulk-ack"
              onClick={bulkAck}
              className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text transition-colors hover:border-trace"
            >
              <ClipboardCheck size={13} />
              Acknowledge selected
            </button>
            <button
              type="button"
              data-testid="bulk-resolve"
              onClick={bulkResolve}
              className="flex items-center gap-1.5 rounded-md bg-trace px-2.5 py-1.5 text-xs font-medium text-[#0b1612] transition-colors hover:opacity-90"
            >
              <CheckCheck size={13} />
              Resolve selected
            </button>
          </div>
        </div>
      )}

      {alerts.isLoading ? (
        <Skeleton className="h-64 w-full" />
      ) : alerts.data && alerts.data.length > 0 ? (
        isMobile ? (
          // Under 768px the Device and Opened columns have nowhere to go,
          // so each alert becomes a stacked row instead of a table a phone
          // user has to scroll sideways to read.
          <div data-testid="alerts-table" className="flex flex-col divide-y divide-border rounded-md border border-border">
            {alerts.data.map((a) => (
              <div
                key={a.id}
                data-testid="alert-row"
                data-alert-id={a.id}
                data-status={a.status}
                tabIndex={0}
                role="button"
                onKeyDown={(e) => e.key === "Enter" && openDrawer(a)}
                onClick={() => openDrawer(a)}
                className="flex cursor-pointer flex-col gap-1 bg-surface px-3 py-2.5 text-sm transition-colors hover:bg-surface-raised"
              >
                <div className="flex min-w-0 items-center gap-1.5">
                  <input
                    type="checkbox"
                    data-testid="alert-select"
                    checked={selectedIds.has(a.id)}
                    onClick={(e) => e.stopPropagation()}
                    onChange={() => toggleSelected(a.id)}
                    className="shrink-0"
                    aria-label={`Select ${a.title}`}
                  />
                  <SeverityTag severity={a.severity} />
                  <span className="truncate text-text">{a.title}</span>
                  <DetectorsChip detectors={a.detectors} />
                </div>
                <div className="flex items-center gap-2 text-xs text-text-muted" title={formatDateTime(a.opened_ts)}>
                  <span className="truncate">{a.device_name}</span>
                  <span className="font-mono-nums shrink-0">{formatRelative(a.opened_ts, nowMs)}</span>
                </div>
              </div>
            ))}
          </div>
        ) : (
          <div className="overflow-x-auto rounded-md border border-border">
            <table data-testid="alerts-table" className="w-full min-w-[640px] text-left text-sm">
              <thead className="bg-surface text-xs text-text-muted">
                <tr>
                  <th className="w-8 px-3 py-2 font-medium" />
                  <th className="px-3 py-2 font-medium">Severity</th>
                  <th className="px-3 py-2 font-medium">Title</th>
                  <th className="px-3 py-2 font-medium">Device</th>
                  <th className="px-3 py-2 font-medium">Opened</th>
                  <th className="px-3 py-2 font-medium">Status</th>
                </tr>
              </thead>
              <tbody>
                {alerts.data.map((a) => (
                  <tr
                    key={a.id}
                    data-testid="alert-row"
                    data-alert-id={a.id}
                    data-status={a.status}
                    tabIndex={0}
                    role="button"
                    onKeyDown={(e) => e.key === "Enter" && openDrawer(a)}
                    onClick={() => openDrawer(a)}
                    className="cursor-pointer border-t border-border bg-surface transition-colors hover:bg-surface-raised"
                  >
                    <td className="px-3 py-2">
                      <input
                        type="checkbox"
                        data-testid="alert-select"
                        checked={selectedIds.has(a.id)}
                        onClick={(e) => e.stopPropagation()}
                        onChange={() => toggleSelected(a.id)}
                        aria-label={`Select ${a.title}`}
                      />
                    </td>
                    <td className="px-3 py-2">
                      <SeverityTag severity={a.severity} />
                    </td>
                    <td className="px-3 py-2 text-text">
                      <span className="flex items-center gap-1.5">
                        {a.title}
                        <DetectorsChip detectors={a.detectors} />
                      </span>
                    </td>
                    <td className="px-3 py-2 text-text-muted">{a.device_name}</td>
                    <td className="px-3 py-2" title={formatDateTime(a.opened_ts)}>
                      <div className="flex flex-col">
                        <span className="font-mono-nums text-text">{formatRelative(a.opened_ts, nowMs)}</span>
                        <span className="font-mono-nums text-[11px] text-text-muted">{formatAbsoluteShort(a.opened_ts, nowMs)}</span>
                      </div>
                    </td>
                    <td className="px-3 py-2 text-text-muted capitalize">{a.status}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      ) : (
        <EmptyState icon={Siren} title="No alerts." detail="Spikes and rule breaches appear here." />
      )}
        </>
      )}

      {selected && <AlertDrawer alert={selected} onClose={closeDrawer} />}
    </div>
  );
}

function AlertDrawer({ alert, onClose }: { alert: Alert; onClose: () => void }) {
  const ack = useAckAlert();
  const resolve = useResolveAlert();
  const since = alert.opened_ts - 2 * 60 * 1000;
  const until = alert.opened_ts + 2 * 60 * 1000;
  const readings = useReadings({ device_id: alert.device_id, since_ms: since, until_ms: until, max_points: 120 });

  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-black/40" onClick={onClose}>
      <div
        data-testid="alert-drawer"
        onClick={(e) => e.stopPropagation()}
        className="flex h-full w-full max-w-md flex-col gap-4 overflow-y-auto border-l border-border bg-surface p-5"
      >
        <div className="flex items-start justify-between gap-3">
          <div className="flex flex-col gap-1">
            <SeverityTag severity={alert.severity} />
            <h2 className="flex items-center gap-1.5 text-base font-medium text-text">
              {alert.title}
              <DetectorsChip detectors={alert.detectors} />
            </h2>
            <span className="text-xs text-text-muted">{alert.device_name}</span>
          </div>
          <button type="button" aria-label="Close" onClick={onClose} className="rounded-md p-1 text-text-muted hover:bg-surface-raised">
            <X size={16} />
          </button>
        </div>

        <ActivityTimeline alert={alert} />

        <div className="h-32 w-full">
          {readings.data && readings.data.points.length > 1 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={readings.data.points} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
                <XAxis dataKey="ts" tickFormatter={(ts: number) => formatTime(ts).slice(0, 5)} stroke="var(--color-text-muted)" fontSize={10} tickLine={false} axisLine={false} minTickGap={30} />
                <Tooltip
                  formatter={(value) => [formatWatts(Number(value)), "watts"]}
                  labelFormatter={(ts) => formatTime(Number(ts))}
                  contentStyle={{ background: "var(--color-surface-raised)", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 12 }}
                />
                <Area type="monotone" dataKey="avg_w" stroke="var(--color-trace)" fill="var(--color-trace)" fillOpacity={0.25} strokeWidth={1.5} isAnimationActive={false} dot={false} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <Skeleton className="h-full w-full" />
          )}
        </div>

        <div className="flex flex-col gap-1.5">
          <span className="text-xs text-text-muted">AI analysis</span>
          {alert.ai ? (
            <div className="flex flex-col gap-1.5 rounded-md border border-border bg-bg p-3">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-sm text-text">{alert.ai.appliance ?? "Unidentified load"}</span>
                {alert.ai.confidence && <ConfidenceMeter confidence={alert.ai.confidence} />}
                {alert.ai.verdict && <VerdictChip verdict={alert.ai.verdict} />}
              </div>
              <p data-testid="alert-explanation" className="text-sm text-text">
                {alert.ai.summary}
              </p>
              <AiMeta model={alert.ai.model} latencyMs={alert.ai.latency_ms} fallback={alert.ai.fallback} />
            </div>
          ) : (
            <p data-testid="alert-explanation" className="text-sm text-text">
              {alert.detail ?? "Explaining…"}
            </p>
          )}
        </div>

        <div className="mt-auto flex gap-2">
          <button
            type="button"
            data-testid="alert-ack"
            disabled={alert.status !== "open" || ack.isPending}
            onClick={() => ack.mutate(alert.id)}
            className="flex-1 rounded-md border border-border px-3 py-2 text-sm text-text transition-colors hover:bg-surface-raised disabled:cursor-not-allowed disabled:opacity-40"
          >
            Acknowledge
          </button>
          <button
            type="button"
            data-testid="alert-resolve"
            disabled={alert.status === "resolved" || resolve.isPending}
            onClick={() => resolve.mutate(alert.id)}
            className="flex-1 rounded-md bg-trace px-3 py-2 text-sm font-medium text-[#0b1612] transition-colors hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-40"
          >
            <span className="inline-flex items-center gap-1.5">
              <CheckCircle2 size={14} />
              Resolve
            </span>
          </button>
        </div>
      </div>
    </div>
  );
}

function ActivityTimeline({ alert }: { alert: Alert }) {
  const steps: { label: string; ts: number | null; done: boolean }[] = [
    { label: "Opened", ts: alert.opened_ts, done: true },
    { label: "Acknowledged", ts: alert.acked_ts, done: alert.acked_ts != null },
    { label: "Resolved", ts: alert.resolved_ts, done: alert.resolved_ts != null },
  ];
  return (
    <ul data-testid="alert-activity-timeline" className="flex flex-col gap-1.5 text-xs text-text-muted">
      {steps.map((s) => (
        <li key={s.label} className="flex items-center gap-2">
          {s.done ? <CheckCircle2 size={13} className="shrink-0 text-trace" aria-hidden /> : <Circle size={13} className="shrink-0 text-text-muted" aria-hidden />}
          <span className={s.done ? "text-text" : ""}>{s.label}</span>
          {s.ts != null && <span className="font-mono-nums">{formatDateTime(s.ts)}</span>}
        </li>
      ))}
    </ul>
  );
}
