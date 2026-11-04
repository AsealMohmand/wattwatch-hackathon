// F1-6: energy analytics. Range picker, stacked per-device kWh bars, a
// 7x24 hourly heatmap, a breakdown donut + table, cost/CO2 cards with a
// month projection, and CSV export.
import { keepPreviousData, useQueries } from "@tanstack/react-query";
import { Download, Gauge, Leaf } from "lucide-react";
import { useMemo, useState } from "react";
import { Bar, BarChart, CartesianGrid, Cell, Legend, Pie, PieChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api } from "../api/client";
import { useAnalyticsBreakdown, useAnalyticsHourly, useAnalyticsSummary, useDevices } from "../api/hooks";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { StatCard } from "../components/StatCard";
import { deviceColor } from "../lib/chartPalette";
import { formatAbsoluteShort, formatCost, formatKwh, formatKwhTick } from "../lib/format";

type Range = "today" | "7d" | "30d";
const RANGE_DAYS: Record<Range, number> = { today: 1, "7d": 7, "30d": 30 };
const RANGE_LABEL: Record<Range, string> = { today: "Today", "7d": "7 days", "30d": "30 days" };

const HOURS = Array.from({ length: 24 }, (_, i) => i);
const COPPER_STEPS = [0.12, 0.28, 0.46, 0.66, 1];

export function Analytics() {
  const [range, setRange] = useState<Range>("7d");
  const days = RANGE_DAYS[range];
  const [sinceMs] = useState(() => Date.now());

  const summary = useAnalyticsSummary();
  const devices = useDevices();
  const hourly = useAnalyticsHourly({ days: 7 });
  const breakdown = useAnalyticsBreakdown({ since_ms: sinceMs - days * 24 * 60 * 60 * 1000, until_ms: sinceMs });

  const deviceList = devices.data ?? [];
  // r1 finding #8 / FA-4: a device's color must stay the same wherever it
  // appears on this page. Indexing CHART_PALETTE by each dataset's own row
  // order (bars by `deviceList`, the donut by `breakdown.data`) only lines
  // up by coincidence when both endpoints happen to return devices in the
  // same order -- this map pins each device_id to one color, from one
  // source of truth (`deviceList`), so the donut and its legend look it up
  // by identity instead of by position.
  const colorByDevice = useMemo(() => new Map(deviceList.map((d, i) => [d.device_id, deviceColor(i)])), [deviceList]);
  const dailyQueries = useQueries({
    queries: deviceList.map((d) => ({
      queryKey: ["analytics-daily", d.device_id, days],
      queryFn: () => api.energyDaily({ device_id: d.device_id, days }),
      enabled: !!d.device_id,
      placeholderData: keepPreviousData,
    })),
  });

  const barData = useMemo(() => {
    const byDay = new Map<string, Record<string, number | string>>();
    dailyQueries.forEach((q, i) => {
      const device = deviceList[i];
      if (!device || !q.data) return;
      for (const row of q.data) {
        const entry = byDay.get(row.day) ?? { day: row.day };
        entry[device.device_id] = row.kwh;
        byDay.set(row.day, entry);
      }
    });
    return [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  }, [dailyQueries, deviceList]);

  const barsLoading = devices.isLoading || dailyQueries.some((q) => q.isLoading);

  const maxHourlyKwh = useMemo(() => Math.max(0.0001, ...(hourly.data ?? []).map((h) => h.kwh)), [hourly.data]);
  const hourlyByKey = useMemo(() => {
    const m = new Map<string, number>();
    for (const h of hourly.data ?? []) m.set(`${h.day}:${h.hour}`, h.kwh);
    return m;
  }, [hourly.data]);
  const days7 = useMemo(() => [...new Set((hourly.data ?? []).map((h) => h.day))].sort(), [hourly.data]);
  // The endpoint always zero-fills 7x24, so an empty `days7` never happens
  // in practice -- "no history yet" means every cell is zero, not that the
  // list of days is empty.
  const hasHourlyUsage = useMemo(() => (hourly.data ?? []).some((h) => h.kwh > 0), [hourly.data]);

  const breakdownTotal = useMemo(() => (breakdown.data ?? []).reduce((a, b) => a + b.kwh, 0), [breakdown.data]);

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex gap-1" role="group" aria-label="Range">
          {(["today", "7d", "30d"] as Range[]).map((r) => (
            <button
              key={r}
              type="button"
              data-testid={`analytics-range-${r}`}
              aria-pressed={range === r}
              onClick={() => setRange(r)}
              className={`rounded-md px-2.5 py-1.5 text-xs font-medium transition-colors ${
                range === r ? "bg-trace text-[#0b1612]" : "border border-border text-text-muted hover:bg-surface-raised hover:text-text"
              }`}
            >
              {RANGE_LABEL[r]}
            </button>
          ))}
        </div>
        <div className="flex gap-2">
          <a
            data-testid="export-readings-csv"
            href={api.readingsCsvUrl({ since_ms: sinceMs - days * 24 * 60 * 60 * 1000, until_ms: sinceMs })}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:text-text hover:bg-surface-raised"
          >
            <Download size={13} />
            Export readings
          </a>
          <a
            data-testid="export-events-csv"
            href={api.eventsCsvUrl({ since_ms: sinceMs - days * 24 * 60 * 60 * 1000 })}
            className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:text-text hover:bg-surface-raised"
          >
            <Download size={13} />
            Export events
          </a>
        </div>
      </div>

      <section className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatCard testId="stat-kwh-mtd" label="kWh, month to date" accent="copper" value={formatKwh(summary.data?.kwh_mtd)} />
        <StatCard
          testId="stat-cost-mtd"
          label="Cost, month to date"
          accent="copper"
          value={formatCost(summary.data?.cost_mtd, summary.data?.currency ?? "$")}
          sub={summary.data ? `Projected ${formatCost(summary.data.projected_month_cost, summary.data.currency)}` : undefined}
        />
        <StatCard testId="stat-co2-mtd" label="CO2, month to date" value={summary.data ? `${summary.data.co2_kg_mtd.toFixed(1)} kg` : "— kg"} />
        <StatCard
          testId="stat-always-active"
          label="Always on / active"
          value={summary.data ? `${summary.data.always_on_w.toFixed(0)} / ${summary.data.active_w.toFixed(0)} W` : "— W"}
        />
      </section>

      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
        <h2 className="text-sm font-medium text-text">kWh by device, {RANGE_LABEL[range].toLowerCase()}</h2>
        {barsLoading ? (
          <Skeleton className="h-64 w-full" />
        ) : barData.length === 0 || deviceList.length === 0 ? (
          <EmptyState icon={Gauge} title="No energy history yet." detail="A bar appears here for each day once readings come in." testId="analytics-bars-empty" />
        ) : (
          <div data-testid="analytics-stacked-bars" className="h-64 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={barData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="day" stroke="var(--color-text-muted)" fontSize={11} tickLine={false} axisLine={false} />
                <YAxis tickFormatter={(v: number) => formatKwhTick(v)} stroke="var(--color-text-muted)" fontSize={11} tickLine={false} axisLine={false} width={48} />
                <Tooltip
                  formatter={(value, name) => [formatKwh(Number(value)), String(name)]}
                  contentStyle={{ background: "var(--color-surface-raised)", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 12 }}
                />
                {deviceList.map((d, i) => (
                  <Bar key={d.device_id} dataKey={d.device_id} name={d.name} stackId="energy" fill={deviceColor(i)} isAnimationActive={false} />
                ))}
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}
        {/* r1 finding #8 / FA-4: a device's series now uses the same
            palette color everywhere -- these bars, the donut below and
            its legend -- instead of copper shades here colliding with a
            different hue in the donut for the same device. Copper stays
            reserved for single-series totals and KPIs. */}
        {deviceList.length > 0 && (
          <div data-testid="analytics-bars-legend" className="flex flex-wrap gap-x-4 gap-y-1">
            {deviceList.map((d, i) => (
              <span key={d.device_id} className="flex items-center gap-1.5 text-xs text-text-muted">
                <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: deviceColor(i) }} aria-hidden />
                {d.name}
              </span>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-text">Hourly load, last 7 days</h2>
          <div className="flex items-center gap-1 text-[11px] text-text-muted">
            Less
            {COPPER_STEPS.map((s) => (
              <span key={s} className="h-3 w-3 rounded-sm" style={{ background: `color-mix(in srgb, var(--color-copper) ${s * 100}%, transparent)` }} aria-hidden />
            ))}
            More
          </div>
        </div>
        {hourly.isLoading ? (
          <Skeleton className="h-56 w-full" />
        ) : !hasHourlyUsage ? (
          <EmptyState icon={Gauge} title="No hourly history yet." testId="analytics-heatmap-empty" />
        ) : (
          // r1 finding #8 / FA-4: the grid of hour cells now fills the
          // card's full width (each cell flexes, floor 10px) instead of a
          // fixed 14px per cell that left half the card blank on anything
          // wider than ~360px of hour columns.
          <div data-testid="analytics-heatmap" className="flex flex-col gap-1">
            <div className="flex gap-0.5 pl-14 text-[10px] text-text-muted">
              {HOURS.map((h) => (
                <span key={h} className="min-w-[10px] flex-1 text-center">
                  {h % 4 === 0 ? String(h).padStart(2, "0") : ""}
                </span>
              ))}
            </div>
            {days7.map((day) => (
              <div key={day} className="flex items-center gap-0.5">
                <span className="w-14 shrink-0 font-mono-nums text-[10px] text-text-muted">{day.slice(5)}</span>
                {HOURS.map((h) => {
                  const kwh = hourlyByKey.get(`${day}:${h}`) ?? 0;
                  const intensity = kwh === 0 ? 0 : Math.max(0.1, kwh / maxHourlyKwh);
                  return (
                    <span
                      key={h}
                      data-testid="heatmap-cell"
                      title={`${day} ${String(h).padStart(2, "0")}:00 — ${formatKwh(kwh)}`}
                      className="h-3.5 min-w-[10px] flex-1 rounded-sm"
                      style={{ background: kwh > 0 ? `color-mix(in srgb, var(--color-copper) ${Math.round(intensity * 100)}%, transparent)` : "var(--color-border)" }}
                    />
                  );
                })}
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
        {/* r1 finding #8 / FA-4: the donut card had no title at all. */}
        <h2 className="text-sm font-medium text-text">Share by device</h2>
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center">
          <div className="h-56 w-full lg:w-56">
          {breakdown.isLoading ? (
            <Skeleton className="h-full w-full" />
          ) : (breakdown.data ?? []).length === 0 ? (
            <EmptyState icon={Leaf} title="No usage in this range yet." testId="analytics-donut-empty" />
          ) : (
            <ResponsiveContainer width="100%" height="100%">
              <PieChart>
                <Pie data={breakdown.data} dataKey="kwh" nameKey="device_name" innerRadius={48} outerRadius={72} isAnimationActive={false}>
                  {(breakdown.data ?? []).map((row, i) => (
                    <Cell key={row.device_id} fill={colorByDevice.get(row.device_id) ?? deviceColor(i)} />
                  ))}
                </Pie>
                <Tooltip formatter={(value) => formatKwh(Number(value))} contentStyle={{ background: "var(--color-surface-raised)", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 12 }} />
                <Legend wrapperStyle={{ fontSize: 11 }} />
              </PieChart>
            </ResponsiveContainer>
          )}
        </div>
        <div className="flex-1 overflow-x-auto">
          <table data-testid="breakdown-table" className="w-full min-w-[420px] text-left text-sm">
            <thead className="text-xs text-text-muted">
              <tr>
                <th className="px-2 py-1.5 font-medium">Device</th>
                <th className="px-2 py-1.5 text-right font-medium">kWh</th>
                <th className="px-2 py-1.5 text-right font-medium">Cost</th>
                <th className="px-2 py-1.5 text-right font-medium">Share</th>
              </tr>
            </thead>
            <tbody>
              {(breakdown.data ?? []).map((row) => (
                <tr key={row.device_id} className="border-t border-border">
                  <td className="px-2 py-1.5 text-text">{row.device_name}</td>
                  <td className="px-2 py-1.5 text-right font-mono-nums text-text">{formatKwh(row.kwh)}</td>
                  <td className="px-2 py-1.5 text-right font-mono-nums text-text-muted">{formatCost(row.cost, summary.data?.currency ?? "$")}</td>
                  <td className="px-2 py-1.5 text-right font-mono-nums text-text-muted">{(row.share * 100).toFixed(0)}%</td>
                </tr>
              ))}
              {breakdownTotal === 0 && (
                <tr>
                  <td colSpan={4} className="px-2 py-4 text-center text-xs text-text-muted">
                    No usage in this range yet.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
        </div>
      </section>

      {/* r1 finding #8 / FA-4: this used to repeat the peak timestamp
          twice (a bare time, then the same time again in parens as a full
          date-time). One rendering, with the date only when it isn't
          today. */}
      {summary.data?.peak_today_ts != null && (
        <p data-testid="analytics-peak-note" className="text-xs text-text-muted">
          Peak today was {summary.data.peak_today_w.toFixed(0)} W at {formatAbsoluteShort(summary.data.peak_today_ts)}.
        </p>
      )}
    </div>
  );
}
