// F1-3: Home. This and Live are where the brief's boldness budget gets
// spent — everywhere else on the console stays flat and tabular. The hero
// is a real-time meter (SSE-driven total + 60s trace + an always-on/active
// split), not a stat-card grid; below it, a KPI row, the 24h chart with
// incident bands, today's digest, active alerts and device/node health.
import { keepPreviousData, useQueries } from "@tanstack/react-query";
import { Bolt, FileText, Gauge } from "lucide-react";
import { useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Area, AreaChart, CartesianGrid, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, type ReadingPoint } from "../api/client";
import { useAlerts, useAnalyticsSummary, useDevices, useIncidents, useInsights, useNodes, useOverview } from "../api/hooks";
import { useLiveReadings } from "../api/stream";
import { DeviceCard } from "../components/DeviceCard";
import { EmptyState } from "../components/EmptyState";
import { SeverityTag } from "../components/SeverityTag";
import { Skeleton } from "../components/Skeleton";
import { StatCard } from "../components/StatCard";
import { deviceColor } from "../lib/chartPalette";
import { formatCost, formatDuration, formatKwh, formatRelative, formatTime, formatWatts } from "../lib/format";

const DAY_MS = 24 * 60 * 60 * 1000;

export function Overview() {
  const overview = useOverview();
  const summary = useAnalyticsSummary();
  const devices = useDevices();
  const nodes = useNodes();
  const alerts = useAlerts({ status: "active", limit: 5 });
  const insights = useInsights(1);
  const trace60s = useLiveReadings(undefined, 60);

  const deviceList = devices.data ?? [];
  // Fixed at mount so the incidents/readings query keys don't drift (and
  // refetch from scratch) every render — the same pattern used elsewhere
  // on this console for a rolling window.
  const [sinceMs] = useState(() => Date.now() - DAY_MS);
  // r1 FA-2: incident bands come from /api/incidents (one merged rule+ML
  // span per boil), not /api/events, which used to draw a band per
  // detector and could double them up on an overlapping rule+ML incident.
  const incidents = useIncidents({ since_ms: sinceMs, limit: 100 });

  const readingsQueries = useQueries({
    queries: deviceList.map((d) => ({
      queryKey: ["home-readings-24h", d.device_id],
      queryFn: () => api.readings({ device_id: d.device_id, since_ms: sinceMs, until_ms: Date.now(), max_points: 400 }),
      enabled: !!d.device_id,
      refetchInterval: 30_000,
      placeholderData: keepPreviousData,
    })),
  });

  const chartData = useMemo(() => {
    const byTs = new Map<number, Record<string, number>>();
    readingsQueries.forEach((q, i) => {
      const device = deviceList[i];
      if (!device || !q.data) return;
      for (const p of q.data.points as ReadingPoint[]) {
        const row = byTs.get(p.ts) ?? { ts: p.ts };
        row[device.device_id] = p.avg_w;
        byTs.set(p.ts, row);
      }
    });
    return [...byTs.values()].sort((a, b) => a.ts - b.ts);
  }, [readingsQueries, deviceList]);

  const chartLoading = devices.isLoading || readingsQueries.some((q) => q.isLoading);

  const alwaysOn = summary.data?.always_on_w ?? 0;
  const active = summary.data?.active_w ?? 0;
  const splitTotal = Math.max(1, alwaysOn + active);
  const alwaysOnPct = (alwaysOn / splitTotal) * 100;

  // r1 finding #5 / FA-2: the old delta compared a partial "today so far"
  // against the whole of yesterday (reads as "-86%" at 4am for no real
  // reason). kwh_yesterday_same_time is yesterday from 00:00 to the same
  // clock time as now, so this is an apples-to-apples comparison -- and
  // it's hidden entirely rather than falling back to the misleading one
  // when the backend hasn't landed the field yet or yesterday has no data.
  const yesterdaySameTime = summary.data?.kwh_yesterday_same_time;
  const rawDeltaPct = yesterdaySameTime != null && yesterdaySameTime > 0 ? ((summary.data!.kwh_today - yesterdaySameTime) / yesterdaySameTime) * 100 : null;
  // Belt-and-braces: the backend already nulls kwh_yesterday_same_time when its
  // window is too sparse to trust, but a lone outlier reading could still slip
  // through and produce a swing nobody should read as real (e.g. "+17928%").
  const deltaPct = rawDeltaPct != null && Math.abs(rawDeltaPct) <= 999 ? rawDeltaPct : null;

  return (
    <div className="flex flex-col gap-5">
      {/* Hero: live draw. A meter-style readout on a faint graticule, a 60s
          trace, and the always-on/active split as two labelled segments —
          never a middle-dot string. */}
      <section
        data-testid="stat-total-w"
        className="relative overflow-hidden rounded-md border border-border bg-surface px-5 py-6"
        style={{
          backgroundImage:
            "linear-gradient(var(--color-border) 1px, transparent 1px), linear-gradient(90deg, var(--color-border) 1px, transparent 1px)",
          backgroundSize: "28px 28px",
          backgroundPosition: "center",
        }}
      >
        <div className="relative flex flex-wrap items-end justify-between gap-4">
          <div>
            <span className="text-xs text-text-muted">Live draw</span>
            {overview.isLoading ? (
              <Skeleton className="mt-1 h-10 w-40" />
            ) : (
              <div className="flex items-baseline gap-2">
                <span className="font-mono-nums text-4xl font-semibold text-trace">{formatWatts(overview.data?.total_w).replace(" W", "")}</span>
                <span className="text-lg text-text-muted">W</span>
              </div>
            )}
            <span className="text-xs text-text-muted">
              across {overview.data?.devices_online ?? 0} of {overview.data?.devices_total ?? 0} devices online
            </span>
          </div>
          {trace60s.length > 1 && (
            <div className="h-14 w-40">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={trace60s} margin={{ top: 2, right: 0, bottom: 0, left: 0 }}>
                  <Area type="monotone" dataKey="watts" stroke="var(--color-trace)" fill="var(--color-trace)" fillOpacity={0.18} strokeWidth={1.75} isAnimationActive={false} dot={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </div>
        {summary.data && (
          <div data-testid="always-active-split" className="relative mt-5 flex flex-col gap-1.5">
            <div className="flex h-2 w-full overflow-hidden rounded-full bg-surface-raised">
              <span className="h-full bg-text-muted" style={{ width: `${alwaysOnPct}%` }} aria-hidden />
              <span className="h-full bg-trace" style={{ width: `${100 - alwaysOnPct}%` }} aria-hidden />
            </div>
            <div className="flex justify-between text-xs text-text-muted">
              <span>
                Always on <span className="font-mono-nums text-text">{alwaysOn.toFixed(0)} W</span>
              </span>
              <span>
                Active <span className="font-mono-nums text-text">{active.toFixed(0)} W</span>
              </span>
            </div>
          </div>
        )}
      </section>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard
          testId="stat-kwh-today"
          label="kWh today"
          accent="copper"
          value={formatKwh(overview.data?.kwh_today)}
          sub={deltaPct != null ? `${deltaPct >= 0 ? "+" : ""}${deltaPct.toFixed(0)}% vs this time yesterday` : undefined}
        />
        <StatCard testId="stat-cost-today" label="Cost today" accent="copper" value={formatCost(overview.data?.cost_today, overview.data?.currency ?? "$")} />
        <StatCard
          testId="stat-cost-mtd"
          label="Cost, month to date"
          accent="copper"
          value={formatCost(summary.data?.cost_mtd, summary.data?.currency ?? "$")}
          sub={summary.data ? `Projected ${formatCost(summary.data.projected_month_cost, summary.data.currency)}` : undefined}
        />
        <StatCard testId="stat-co2-today" label="CO2 today" value={summary.data ? `${summary.data.co2_kg_today.toFixed(2)} kg` : "— kg"} />
        {/* r1 finding #4 / FA-2: peak now has its own KPI instead of
            riding along as the "Open alerts" card's subtitle, where it
            belonged to the wrong metric. */}
        <StatCard
          testId="stat-peak-today"
          label="Peak today"
          value={summary.data?.peak_today_ts != null ? formatWatts(summary.data.peak_today_w) : "— W"}
          sub={summary.data?.peak_today_ts != null ? `at ${formatTime(summary.data.peak_today_ts).slice(0, 5)}` : undefined}
        />
        <StatCard
          testId="stat-open-alerts"
          label="Open alerts"
          accent={overview.data && overview.data.critical_alerts > 0 ? "critical" : "text"}
          value={String(overview.data?.open_alerts ?? 0)}
          sub={overview.data ? (overview.data.critical_alerts > 0 ? `${overview.data.critical_alerts} critical` : "None critical") : undefined}
        />
      </div>

      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
        <h2 className="text-sm font-medium text-text">Power, last 24 hours</h2>
        {chartLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : chartData.length === 0 ? (
          <EmptyState icon={Gauge} title="No power data yet." detail="Readings will appear here once a device reports in." testId="home-chart-empty" />
        ) : (
          <div data-testid="power-chart" className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="ts" tickFormatter={(ts: number) => formatTime(ts).slice(0, 5)} stroke="var(--color-text-muted)" fontSize={11} tickLine={false} axisLine={false} minTickGap={50} />
                <YAxis stroke="var(--color-text-muted)" fontSize={11} tickLine={false} axisLine={false} width={40} />
                <Tooltip
                  formatter={(value, name) => [formatWatts(Number(value)), String(name)]}
                  labelFormatter={(ts) => formatTime(Number(ts))}
                  contentStyle={{ background: "var(--color-surface-raised)", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 12 }}
                />
                {(incidents.data ?? []).map((inc) => (
                  <ReferenceArea
                    key={inc.id}
                    x1={inc.start_ts}
                    x2={Math.max(inc.end_ts, inc.start_ts + 60_000)}
                    fill={inc.methods.includes("rule") ? "var(--color-critical)" : "var(--color-info)"}
                    fillOpacity={0.16}
                    stroke="none"
                    data-testid="home-chart-incident"
                  />
                ))}
                {deviceList.map((d, i) => (
                  <Area key={d.device_id} type="monotone" dataKey={d.device_id} name={d.name} stackId="home" stroke={deviceColor(i)} fill={deviceColor(i)} fillOpacity={0.28} isAnimationActive={false} />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
        {deviceList.length > 0 && (
          <div data-testid="home-chart-legend" className="flex flex-wrap gap-x-4 gap-y-1">
            {deviceList.map((d, i) => (
              <span key={d.device_id} className="flex items-center gap-1.5 text-xs text-text-muted">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: deviceColor(i) }} aria-hidden />
                {d.name}
              </span>
            ))}
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section data-testid="home-digest" className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 text-sm font-medium text-text">
              <FileText size={14} className="text-text-muted" />
              Today's digest
            </h2>
            <Link to="/ai/insights" className="text-xs text-trace hover:underline">
              See all insights
            </Link>
          </div>
          {insights.isLoading ? (
            <Skeleton className="h-16 w-full" />
          ) : insights.data && insights.data.length > 0 ? (
            <div className="flex flex-col gap-1">
              <span className="text-sm text-text">{insights.data[0].title}</span>
              <p className="text-xs text-text-muted">{insights.data[0].body}</p>
              <span className="font-mono-nums text-[11px] text-text-muted">{formatRelative(insights.data[0].created_ts)}</span>
            </div>
          ) : (
            <EmptyState icon={FileText} title="No digest yet." detail="A daily summary appears here once Llama has generated one." testId="home-digest-empty" />
          )}
        </section>

        <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
          <div className="flex items-center justify-between">
            <h2 className="text-sm font-medium text-text">Active alerts</h2>
            <Link to="/alerts" className="text-xs text-trace hover:underline">
              See all alerts
            </Link>
          </div>
          {alerts.isLoading ? (
            <div className="flex flex-col gap-2">
              <Skeleton className="h-10 w-full" />
              <Skeleton className="h-10 w-full" />
            </div>
          ) : alerts.data && alerts.data.length > 0 ? (
            <ul data-testid="recent-alerts" className="flex flex-col gap-2">
              {alerts.data.slice(0, 5).map((a) => (
                <li key={a.id}>
                  <Link to={`/alerts?open=${a.id}`} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-2 text-sm transition-colors hover:border-trace">
                    <span className="flex min-w-0 items-center gap-2">
                      <SeverityTag severity={a.severity} />
                      <span className="truncate text-text">{a.title}</span>
                    </span>
                    <span className="shrink-0 font-mono-nums text-xs text-text-muted">{formatRelative(a.opened_ts)}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState icon={Gauge} title="No alerts." detail="Spikes and rule breaches appear here." />
          )}
        </section>
      </div>

      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
        <h2 className="text-sm font-medium text-text">Devices</h2>
        {devices.isLoading ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <Skeleton className="h-28 w-full" />
            <Skeleton className="h-28 w-full" />
          </div>
        ) : deviceList.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {deviceList.map((d, i) => {
              const spark = readingsQueries[i]?.data?.points;
              return <DeviceCard key={d.device_id} device={d} spark={spark} />;
            })}
          </div>
        ) : (
          <EmptyState icon={Bolt} title="No devices yet." detail="A device appears here the first time it reports a reading." />
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
        <h2 className="text-sm font-medium text-text">Node health</h2>
        {nodes.isLoading ? (
          <Skeleton className="h-16 w-full" />
        ) : (nodes.data ?? []).length > 0 ? (
          <div data-testid="home-node-health-strip" className="flex flex-wrap gap-3">
            {(nodes.data ?? []).map((n) => (
              <div key={n.node_id} className="flex min-w-[180px] flex-1 flex-col gap-1 rounded-md border border-border px-3 py-2">
                <span className="flex items-center gap-2 text-sm text-text">
                  <span className={`h-1.5 w-1.5 rounded-full ${n.online ? "bg-trace" : "bg-critical"}`} aria-hidden />
                  {n.node_id}
                </span>
                <span className="flex flex-col font-mono-nums text-[11px] text-text-muted">
                  <span>{n.fw ?? "firmware unknown"}</span>
                  {/* r1 finding #11 / FA-2: an offline node used to show its
                      last-known uptime and reading rate as if current
                      ("up 24h 0m, 0 readings/min") -- replaced with when it
                      was last actually seen. */}
                  {n.online ? (
                    <span>
                      up {n.uptime_ms != null ? formatDuration(n.uptime_ms / 1000) : "—"}, {n.readings_per_min.toFixed(0)} readings/min
                    </span>
                  ) : (
                    <span>Last seen {formatRelative(n.last_ts)}</span>
                  )}
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState icon={Gauge} title="No nodes yet." testId="home-node-health-empty" />
        )}
      </section>
    </div>
  );
}
