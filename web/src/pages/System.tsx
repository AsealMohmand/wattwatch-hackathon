// F1-7: service health grid (6 services), DB stats, ingest rate sparkline,
// versions, Ollama status, and an audit log table with filter.
import { Activity, Brain, Database, Server } from "lucide-react";
import { useMemo, useState } from "react";
import { Area, AreaChart, ResponsiveContainer } from "recharts";
import type { ServiceStatusKind } from "../api/client";
import { useAudit, useLlm, useSystem } from "../api/hooks";
import { useLiveReadings } from "../api/stream";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { formatDateTime, formatDuration, formatRelative } from "../lib/format";

const STATUS_DOT: Record<ServiceStatusKind, string> = {
  running: "bg-trace",
  stale: "bg-warning",
  down: "bg-critical",
};

const STATUS_LABEL: Record<ServiceStatusKind, string> = {
  running: "Running",
  stale: "Stale",
  down: "Down",
};

export function System() {
  const system = useSystem();
  const llm = useLlm();
  const audit = useAudit(100);
  const live = useLiveReadings(undefined, 120);
  const [actionFilter, setActionFilter] = useState("");

  const filteredAudit = useMemo(() => {
    const list = audit.data ?? [];
    const q = actionFilter.trim().toLowerCase();
    if (!q) return list;
    return list.filter((a) => a.action.toLowerCase().includes(q) || a.actor.toLowerCase().includes(q) || (a.target ?? "").toLowerCase().includes(q));
  }, [audit.data, actionFilter]);

  return (
    <div className="flex flex-col gap-5">
      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
        <h2 className="text-sm font-medium text-text">Services</h2>
        {system.isLoading ? (
          <Skeleton className="h-40 w-full" />
        ) : (
          <div data-testid="service-grid" className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3">
            {(system.data?.services ?? []).map((s) => (
              <div key={s.service} data-testid="service-row" data-service={s.service} className="flex flex-col gap-1 rounded-md border border-border px-3 py-2.5">
                <span className="flex items-center gap-2 text-sm text-text">
                  <span className={`h-2 w-2 shrink-0 rounded-full ${STATUS_DOT[s.status]}`} aria-hidden />
                  <Server size={13} className="text-text-muted" />
                  {s.service}
                  <span className="ml-auto text-xs text-text-muted">{STATUS_LABEL[s.status]}</span>
                </span>
                <span className="flex flex-wrap gap-x-3 font-mono-nums text-[11px] text-text-muted">
                  <span>pid {s.pid ?? "—"}</span>
                  <span>heartbeat {s.heartbeat_age_s != null ? `${s.heartbeat_age_s.toFixed(0)}s ago` : "—"}</span>
                  <span>up {s.started_ts != null ? formatDuration((Date.now() - s.started_ts) / 1000) : "—"}</span>
                </span>
                {/* r1 finding #12 / FA-5: raw JSON ({"mode":"demo"}) replaced
                    with key/value chips; hidden entirely when info is empty
                    rather than rendering an empty "{}" chip row. */}
                {s.info && Object.keys(s.info).length > 0 && (
                  <span className="flex flex-wrap gap-1">
                    {Object.entries(s.info).map(([k, v]) => (
                      <span key={k} className="rounded border border-border px-1.5 py-0.5 font-mono-nums text-[11px] text-text-muted">
                        {k}: {typeof v === "object" && v !== null ? JSON.stringify(v) : String(v)}
                      </span>
                    ))}
                  </span>
                )}
              </div>
            ))}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
          <h2 className="flex items-center gap-2 text-sm font-medium text-text">
            <Database size={14} className="text-text-muted" />
            Database
          </h2>
          {system.isLoading ? (
            <Skeleton className="h-20 w-full" />
          ) : (
            <div className="grid grid-cols-2 gap-2 text-sm sm:grid-cols-4">
              <Metric label="Size" value={system.data ? `${(system.data.db.size_bytes / 1024 / 1024).toFixed(1)} MB` : "—"} />
              <Metric label="Readings" value={system.data ? system.data.db.readings.toLocaleString() : "—"} />
              <Metric label="Events" value={system.data ? system.data.db.events.toLocaleString() : "—"} />
              <Metric label="Alerts" value={system.data ? system.data.db.alerts.toLocaleString() : "—"} />
            </div>
          )}
        </section>

        <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
          <h2 className="flex items-center gap-2 text-sm font-medium text-text">
            <Activity size={14} className="text-text-muted" />
            Ingest rate
          </h2>
          <div className="flex items-baseline gap-2">
            <span className="font-mono-nums text-2xl text-text">{system.data?.ingest.readings_per_min ?? "—"}</span>
            <span className="text-xs text-text-muted">readings/min, last reading {formatRelative(system.data?.ingest.last_ts)}</span>
          </div>
          {live.length > 1 ? (
            <div data-testid="ingest-sparkline" className="h-[28px] w-full">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={live} margin={{ top: 0, right: 0, bottom: 0, left: 0 }}>
                  <Area type="monotone" dataKey="watts" stroke="var(--color-trace)" fill="var(--color-trace)" fillOpacity={0.15} strokeWidth={1.25} isAnimationActive={false} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-[28px] w-full rounded bg-surface-raised/50" />
          )}
        </section>
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
          <h2 className="text-sm font-medium text-text">Versions</h2>
          {system.isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : (
            <div className="flex flex-col gap-1 text-xs text-text-muted">
              <span>
                API <span className="font-mono-nums text-text">{system.data?.versions.api ?? "—"}</span>
              </span>
              <span>
                Python <span className="font-mono-nums text-text">{system.data?.versions.python ?? "—"}</span>
              </span>
              <span>
                Ollama model <span className="font-mono-nums text-text">{system.data?.versions.ollama_model ?? "—"}</span>
              </span>
            </div>
          )}
        </section>

        <section className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
          <h2 className="flex items-center gap-2 text-sm font-medium text-text">
            <Brain size={14} className="text-text-muted" />
            Ollama
          </h2>
          {llm.isLoading ? (
            <Skeleton className="h-12 w-full" />
          ) : (
            <div className="flex items-center gap-2 text-sm">
              <span className={`h-1.5 w-1.5 rounded-full ${llm.data?.reachable ? "bg-trace" : "bg-critical"}`} aria-hidden />
              <span className="text-text">{llm.data?.model ?? "—"}</span>
              <span className="ml-auto text-xs text-text-muted">{llm.data?.reachable ? "Reachable" : "Unreachable"}</span>
            </div>
          )}
        </section>
      </div>

      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-text">Audit log</h2>
          <input
            data-testid="audit-filter"
            value={actionFilter}
            onChange={(e) => setActionFilter(e.target.value)}
            placeholder="Filter by action, actor or target"
            className="w-56 rounded-md border border-border bg-bg px-2 py-1.5 text-xs text-text placeholder:text-text-muted focus:outline-none"
          />
        </div>
        {audit.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : filteredAudit.length === 0 ? (
          <EmptyState icon={Activity} title="No audit entries yet." detail="Every write action — acking an alert, saving settings, retraining — lands here." testId="audit-empty" />
        ) : (
          <div className="overflow-x-auto">
            <table data-testid="audit-table" className="w-full min-w-[640px] text-left text-sm">
              <thead className="text-xs text-text-muted">
                <tr>
                  <th className="px-2 py-1.5 font-medium">Time</th>
                  <th className="px-2 py-1.5 font-medium">Actor</th>
                  <th className="px-2 py-1.5 font-medium">Action</th>
                  <th className="px-2 py-1.5 font-medium">Target</th>
                  <th className="px-2 py-1.5 font-medium">Detail</th>
                </tr>
              </thead>
              <tbody>
                {filteredAudit.map((a) => (
                  <tr key={a.id} data-testid="audit-row" className="border-t border-border text-[11px]">
                    <td className="px-2 py-1.5 font-mono-nums text-text-muted">{formatDateTime(a.ts)}</td>
                    <td className="px-2 py-1.5 text-text-muted">{a.actor}</td>
                    <td className="px-2 py-1.5 text-text">{a.action}</td>
                    <td className="px-2 py-1.5 font-mono-nums text-text-muted">{a.target ?? "—"}</td>
                    <td className="max-w-xs truncate px-2 py-1.5 text-text-muted">{a.detail ?? "—"}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <span className="text-xs text-text-muted">{label}</span>
      <span className="font-mono-nums text-base text-text">{value}</span>
    </div>
  );
}
