import { Activity } from "lucide-react";
import { Area, AreaChart, CartesianGrid, ReferenceArea, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { EnergyEvent, ReadingPoint } from "../api/client";
import { formatTime, formatWatts } from "../lib/format";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./Skeleton";
import { StaleWindowState } from "./PowerChart";

/** Single-device chart with events shaded: red for rule hits, blue for the
 * Isolation Forest (anomaly) layer. */
export function DeviceChart({
  points,
  events,
  loading,
  lastTs,
  rangeLabel,
  onShowLast24h,
}: {
  points: ReadingPoint[];
  events: EnergyEvent[];
  loading?: boolean;
  /** The device's newest reading, any age — lets the empty state tell
   * "nothing in this window" apart from "no data ever" (r1 F2). */
  lastTs?: number | null;
  rangeLabel?: string;
  onShowLast24h?: () => void;
}) {
  if (loading) return <Skeleton className="h-64 w-full" />;
  if (points.length === 0) {
    if (lastTs != null) {
      return <StaleWindowState lastTs={lastTs} rangeLabel={rangeLabel ?? "window"} onShowLast24h={onShowLast24h} testId="device-chart-stale" />;
    }
    return (
      <EmptyState
        icon={Activity}
        title="No readings in this window."
        detail="Try a longer range, or check back once the device reports again."
        testId="device-chart-empty"
      />
    );
  }
  return (
    <div data-testid="device-chart" className="h-64 w-full">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
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
          <YAxis stroke="var(--color-text-muted)" fontSize={11} tickLine={false} axisLine={false} width={40} />
          <Tooltip
            formatter={(value) => [formatWatts(Number(value)), "watts"]}
            labelFormatter={(ts) => formatTime(Number(ts))}
            contentStyle={{
              background: "var(--color-surface-raised)",
              border: "1px solid var(--color-border)",
              borderRadius: 6,
              fontSize: 12,
            }}
          />
          {events.map((ev) => (
            <ReferenceArea
              key={ev.id}
              x1={ev.start_ts}
              x2={Math.max(ev.end_ts, ev.start_ts + 1000)}
              fill={ev.method === "rule" ? "var(--color-critical)" : "var(--color-info)"}
              fillOpacity={0.18}
              stroke="none"
              data-testid="device-chart-event"
            />
          ))}
          <Area
            type="monotone"
            dataKey="avg_w"
            stroke="var(--color-trace)"
            fill="var(--color-trace)"
            fillOpacity={0.25}
            strokeWidth={1.5}
            isAnimationActive={false}
            dot={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
}
