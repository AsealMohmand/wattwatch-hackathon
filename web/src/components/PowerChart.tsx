import { useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { formatRelative, formatTime, formatWatts } from "../lib/format";
import { deviceColor } from "../lib/chartPalette";
import { Skeleton } from "./Skeleton";
import { EmptyState } from "./EmptyState";
import { Activity } from "lucide-react";

export type ChartRange = "10m" | "1h" | "6h" | "24h";

export const RANGE_MS: Record<ChartRange, number> = {
  "10m": 10 * 60 * 1000,
  "1h": 60 * 60 * 1000,
  "6h": 6 * 60 * 60 * 1000,
  "24h": 24 * 60 * 60 * 1000,
};

export const RANGE_LABEL: Record<ChartRange, string> = {
  "10m": "10 min",
  "1h": "1 hour",
  "6h": "6 hours",
  "24h": "24 hours",
};

/** The window has no points but the device has reported at some point —
 * tells the truth ("the data exists, it's just older than this window")
 * instead of the generic "no power data yet" empty state. */
export function StaleWindowState({
  lastTs,
  rangeLabel,
  onShowLast24h,
  testId,
}: {
  lastTs: number;
  rangeLabel: string;
  onShowLast24h?: () => void;
  testId?: string;
}) {
  return (
    <div
      data-testid={testId ?? "stale-window-state"}
      className="flex flex-col items-center gap-2 px-6 py-12 text-center text-text-muted"
    >
      <Activity size={28} strokeWidth={1.5} aria-hidden />
      <p className="text-sm text-text">
        No readings in the last {rangeLabel}. Last reading {formatRelative(lastTs)}.
      </p>
      {onShowLast24h && (
        <button
          type="button"
          data-testid="show-last-24h"
          onClick={onShowLast24h}
          className="mt-1 rounded-md border border-border px-3 py-1.5 text-xs text-text transition-colors hover:border-trace hover:bg-surface-raised"
        >
          Show last 24 hours
        </button>
      )}
    </div>
  );
}

export function RangeButtons({
  ranges,
  value,
  onChange,
}: {
  ranges: ChartRange[];
  value: ChartRange;
  onChange: (r: ChartRange) => void;
}) {
  return (
    <div className="flex gap-1" role="group" aria-label="Chart range">
      {ranges.map((r) => (
        <button
          key={r}
          type="button"
          data-testid={`range-${r}`}
          aria-pressed={value === r}
          onClick={() => onChange(r)}
          className={`rounded-md px-2.5 py-1 text-xs font-medium transition-colors ${
            value === r ? "bg-trace text-[#0b1612]" : "text-text-muted hover:bg-surface-raised hover:text-text"
          }`}
        >
          {r}
        </button>
      ))}
    </div>
  );
}

export interface PowerSeriesKey {
  key: string;
  label: string;
}

export function PowerChart({
  data,
  seriesKeys,
  loading,
  lastTs,
  rangeLabel,
  onShowLast24h,
}: {
  data: Array<Record<string, number>>;
  seriesKeys: PowerSeriesKey[];
  loading?: boolean;
  /** The newest reading across all devices, any age — lets the empty state
   * tell "nothing in this window" apart from "no data ever" (r1 F2). */
  lastTs?: number | null;
  rangeLabel?: string;
  onShowLast24h?: () => void;
}) {
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  function toggle(key: string) {
    setHidden((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }

  if (loading) return <Skeleton className="h-64 w-full" />;
  if (data.length === 0 || seriesKeys.length === 0) {
    if (lastTs != null) {
      return <StaleWindowState lastTs={lastTs} rangeLabel={rangeLabel ?? "window"} onShowLast24h={onShowLast24h} testId="power-chart-stale" />;
    }
    return (
      <EmptyState
        icon={Activity}
        title="No power data yet."
        detail="Readings will appear here once a device reports in."
        testId="power-chart-empty"
      />
    );
  }
  return (
    <div data-testid="power-chart" className="flex flex-col gap-2">
      <div className="h-64 w-full">
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={data} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
            <CartesianGrid strokeDasharray="2 4" stroke="var(--color-border)" vertical={false} />
            <XAxis
              dataKey="ts"
              tickFormatter={(ts: number) => formatTime(ts).slice(0, 5)}
              stroke="var(--color-text-muted)"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              minTickGap={40}
            />
            <YAxis
              tickFormatter={(w: number) => `${w}`}
              stroke="var(--color-text-muted)"
              fontSize={11}
              tickLine={false}
              axisLine={false}
              width={40}
            />
            <Tooltip
              formatter={(value, name) => [formatWatts(Number(value)), String(name)]}
              labelFormatter={(ts) => formatTime(Number(ts))}
              contentStyle={{
                background: "var(--color-surface-raised)",
                border: "1px solid var(--color-border)",
                borderRadius: 6,
                fontSize: 12,
              }}
            />
            {seriesKeys.map(
              (s, i) =>
                !hidden.has(s.key) && (
                  <Area
                    key={s.key}
                    type="monotone"
                    dataKey={s.key}
                    name={s.label}
                    stackId="1"
                    stroke={deviceColor(i)}
                    fill={deviceColor(i)}
                    fillOpacity={0.3}
                    isAnimationActive={false}
                  />
                ),
            )}
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div data-testid="power-chart-legend" className="flex flex-wrap gap-3">
        {seriesKeys.map((s, i) => (
          <button
            key={s.key}
            type="button"
            data-testid="power-chart-legend-item"
            data-device-id={s.key}
            aria-pressed={!hidden.has(s.key)}
            onClick={() => toggle(s.key)}
            className={`flex items-center gap-1.5 text-xs transition-opacity ${hidden.has(s.key) ? "opacity-40" : ""}`}
          >
            <span className="h-2 w-2 shrink-0 rounded-full" style={{ background: deviceColor(i) }} aria-hidden />
            <span className="text-text-muted">{s.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
