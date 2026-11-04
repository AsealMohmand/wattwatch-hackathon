// F1-4: the demo-video page. Big per-device live wattage, a 5-minute 1Hz
// scrolling strip chart, a flash-in event ticker, and a raw telemetry
// table — the one other place (besides Home) this plan spends boldness,
// per the brief: "spend boldness on the Home hero and the Live page."
import { Activity, Pause, Play, Radio } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, type Alert, type EnergyEvent, type Explanation } from "../api/client";
import { useDevices, useNodes } from "../api/hooks";
import { getLiveReadings, seedReadingsHistory, subscribeStreamEvents, useRecentReadings, useReadingsVersion } from "../api/stream";
import { deviceColor } from "../lib/chartPalette";
import { DeviceKindIcon } from "../components/DeviceKindIcon";
import { EmptyState } from "../components/EmptyState";
import { SeverityTag } from "../components/SeverityTag";
import { Skeleton } from "../components/Skeleton";
import { formatDateTime, formatRelative, formatTime, formatWatts } from "../lib/format";

const WINDOW_S = 300;
const TICKER_WINDOW_MS = 60 * 60 * 1000;

/** Re-renders on an interval so the ticker's relative times stay fresh and
 * items older than the 60-minute window actually drop off, without a
 * polling query. */
function useNowTick(intervalMs: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

type TickerItem =
  | { id: string; kind: "event"; ts: number; data: EnergyEvent & { ai: Explanation | null } }
  | { id: string; kind: "alert"; ts: number; data: Alert };

export function Live() {
  const devices = useDevices();
  const nodes = useNodes();
  const [paused, setPaused] = useState(false);
  const v = useReadingsVersion();
  const frozenV = useRef(v);
  if (!paused) frozenV.current = v;
  const effectiveV = paused ? frozenV.current : v;

  const [ticker, setTicker] = useState<TickerItem[]>([]);
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const counterRef = useRef(0);

  useEffect(() => {
    return subscribeStreamEvents((e) => {
      if (pausedRef.current) return;
      const id = `t${counterRef.current++}`;
      setTicker((prev) => {
        const item: TickerItem =
          e.kind === "event" ? { id, kind: "event", ts: e.data.start_ts, data: e.data } : { id, kind: "alert", ts: e.data.opened_ts, data: e.data };
        return [item, ...prev].slice(0, 30);
      });
    });
  }, []);

  // r1 finding #6 / FA-3: items only ever arrive here live (there's no
  // backfill of past events/alerts into the ticker), so every item is
  // already something that happened after mount -- the flash-in animation
  // on each row is correct as-is. This tick just re-sorts newest-first (in
  // case two arrive out of order), drops anything past the 60-minute
  // window, and forces a re-render periodically so relative times and the
  // window cutoff stay current on a long-lived page.
  const nowTick = useNowTick(15_000);
  const visibleTicker = useMemo(
    () =>
      ticker
        .filter((t) => nowTick - t.ts <= TICKER_WINDOW_MS)
        .sort((a, b) => b.ts - a.ts),
    [ticker, nowTick],
  );

  const deviceList = devices.data ?? [];
  const portByDevice = new Map((nodes.data ?? []).flatMap((n) => n.ports.map((p) => [p.device_id, p] as const)).filter(([id]) => !!id));
  const deviceById = new Map(deviceList.map((d) => [d.device_id, d] as const));

  // r1 FA-3: backfill the 5-minute chart and raw telemetry from
  // /api/readings on mount, before the first SSE frame has a chance to
  // arrive, so both are full on first paint instead of growing in from
  // empty -- this is the demo-video page, so that first paint matters.
  // Runs once per distinct device-id set (guarded by the ref below), not
  // on every poll-driven refetch of `devices`.
  const backfilledRef = useRef<string | null>(null);
  const deviceIdsKey = deviceList.map((d) => d.device_id).join(",");
  useEffect(() => {
    if (!deviceIdsKey || backfilledRef.current === deviceIdsKey) return;
    backfilledRef.current = deviceIdsKey;
    const sinceMs = Date.now() - WINDOW_S * 1000;
    Promise.all(
      deviceList.map((d) =>
        api
          .readings({ device_id: d.device_id, since_ms: sinceMs, max_points: 300 })
          .then((r) => r.points.map((p) => ({ ts: p.ts, watts: p.avg_w, deviceId: d.device_id }))),
      ),
    )
      .then((perDevice) => {
        const flat = perDevice.flat().sort((a, b) => a.ts - b.ts);
        seedReadingsHistory(flat);
      })
      .catch(() => {
        // Backfill is a nice-to-have first paint; SSE still fills the
        // chart in from here if this fetch fails.
      });
  }, [deviceIdsKey, deviceList]);

  const chartData = useMemo(() => {
    const byTs = new Map<number, Record<string, number>>();
    for (const d of deviceList) {
      for (const p of getLiveReadings(d.device_id, WINDOW_S)) {
        const row = byTs.get(p.ts) ?? { ts: p.ts };
        row[d.device_id] = p.watts;
        byTs.set(p.ts, row);
      }
    }
    return [...byTs.values()].sort((a, b) => a.ts - b.ts);
    // `effectiveV` (frozen while paused) is the real dependency; the
    // per-device ids making up `deviceList` are the other one — reading
    // the live ring buffers themselves happens outside React state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveV, deviceList.map((d) => d.device_id).join(",")]);

  const recentRaw = useRecentReadings(20);
  const [frozenRows, setFrozenRows] = useState<typeof recentRaw | null>(null);
  useEffect(() => {
    if (paused) setFrozenRows(recentRaw);
    else setFrozenRows(null);
    // Capture the snapshot once, at the moment "Pause" is pressed — not on
    // every recentRaw change while paused, which would defeat the pause.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [paused]);
  const recent = paused ? frozenRows ?? recentRaw : recentRaw;

  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between">
        <h1 className="flex items-center gap-2 text-sm font-medium text-text">
          <Radio size={15} className="text-trace" />
          Live
        </h1>
        <button
          type="button"
          data-testid="live-pause-toggle"
          aria-pressed={paused}
          onClick={() => setPaused((p) => !p)}
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:text-text hover:bg-surface-raised"
        >
          {paused ? <Play size={13} /> : <Pause size={13} />}
          {paused ? "Resume stream" : "Pause stream"}
        </button>
      </div>

      {devices.isLoading ? (
        <Skeleton className="h-28 w-full" />
      ) : deviceList.length === 0 ? (
        <EmptyState icon={Radio} title="No devices yet." detail="A live tile appears here the first time a device reports a reading." />
      ) : (
        <div data-testid="live-device-tiles" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
          {deviceList.map((d, i) => {
            const port = portByDevice.get(d.device_id);
            return (
              <div key={d.device_id} data-testid="live-device-tile" data-device-id={d.device_id} className="flex flex-col gap-1 rounded-md border border-border bg-surface px-4 py-3">
                <span className="flex items-center gap-2 text-xs text-text-muted">
                  <DeviceKindIcon kind={d.kind} size={13} />
                  {d.name}
                  <span className={`ml-auto h-1.5 w-1.5 rounded-full ${d.online ? "bg-trace" : "bg-critical"}`} aria-hidden />
                </span>
                <span className="font-mono-nums text-3xl font-semibold" style={{ color: d.online ? deviceColor(i) : "var(--color-text-muted)" }}>
                  {d.online ? (
                    <>
                      {formatWatts(d.watts).replace(" W", "")}
                      <span className="ml-1 text-sm text-text-muted">W</span>
                    </>
                  ) : (
                    "—"
                  )}
                </span>
                {d.online && port?.irms_raw_a != null && <span className="font-mono-nums text-xs text-text-muted">{port.irms_raw_a.toFixed(2)} A</span>}
                {!d.online && (
                  <span data-testid="live-tile-last-seen" className="text-xs text-text-muted">
                    {d.last_ts != null ? `Last seen ${formatRelative(d.last_ts)}` : "No readings yet."}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      )}

      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
        <h2 className="text-sm font-medium text-text">Last 5 minutes, 1 Hz</h2>
        {chartData.length === 0 ? (
          <EmptyState icon={Activity} title="No live readings yet." detail="This chart fills in as soon as the stream connects." testId="live-chart-empty" />
        ) : (
          <div data-testid="live-chart" className="h-72 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={chartData} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="ts" tickFormatter={(ts: number) => formatTime(ts).slice(0, 8)} stroke="var(--color-text-muted)" fontSize={11} tickLine={false} axisLine={false} minTickGap={50} />
                <YAxis stroke="var(--color-text-muted)" fontSize={11} tickLine={false} axisLine={false} width={40} />
                <Tooltip
                  formatter={(value, name) => [formatWatts(Number(value)), String(name)]}
                  labelFormatter={(ts) => formatTime(Number(ts))}
                  contentStyle={{ background: "var(--color-surface-raised)", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 12 }}
                  isAnimationActive={false}
                />
                {deviceList.map((d, i) => (
                  <Area
                    key={d.device_id}
                    type="monotone"
                    dataKey={d.device_id}
                    name={d.name}
                    stroke={deviceColor(i)}
                    fill={deviceColor(i)}
                    fillOpacity={0.22}
                    strokeWidth={1.5}
                    isAnimationActive={false}
                    dot={false}
                    connectNulls
                  />
                ))}
              </AreaChart>
            </ResponsiveContainer>
          </div>
        )}
      </section>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <section className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
          <h2 className="text-sm font-medium text-text">Event ticker</h2>
          {visibleTicker.length === 0 ? (
            <EmptyState
              icon={Activity}
              title="Nothing in the last hour."
              detail="New spikes and alerts land here as they happen."
              testId="live-ticker-empty"
            />
          ) : (
            <ul data-testid="live-ticker" className="flex max-h-80 flex-col gap-1.5 overflow-y-auto">
              {visibleTicker.map((t) => (
                <li key={t.id} data-testid="live-ticker-item" className="flash-in flex items-center gap-2 rounded-md border border-border px-2.5 py-2 text-sm">
                  {t.kind === "alert" ? (
                    <SeverityTag severity={t.data.severity} />
                  ) : (
                    <span className={`rounded px-1.5 py-0.5 text-xs ${t.data.method === "rule" ? "bg-critical-bg text-critical" : "bg-info-bg text-info"}`}>
                      {t.data.method === "rule" ? "Rule" : "ML"}
                    </span>
                  )}
                  <span className="min-w-0 flex-1 truncate text-text">
                    {t.kind === "alert" ? (
                      t.data.title
                    ) : (
                      <span className="flex flex-wrap items-baseline gap-x-2">
                        <span className="truncate text-text">{deviceById.get(t.data.device_id)?.name ?? t.data.device_id}</span>
                        <span className="text-text-muted">Peak {formatWatts(t.data.peak_w)}</span>
                      </span>
                    )}
                  </span>
                  <span className="shrink-0 font-mono-nums text-xs text-text-muted" title={formatDateTime(t.ts)}>
                    {formatRelative(t.ts, nowTick)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>

        <section className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
          <h2 className="text-sm font-medium text-text">Raw telemetry, last {recent.length}</h2>
          {recent.length === 0 ? (
            <EmptyState icon={Activity} title="No readings yet." testId="live-raw-empty" />
          ) : (
            <div className="overflow-x-auto">
              <table data-testid="live-raw-table" className="w-full min-w-[480px] text-left text-sm">
                <thead className="text-xs text-text-muted">
                  <tr>
                    <th className="px-2 py-1.5 font-medium">Time</th>
                    <th className="px-2 py-1.5 font-medium">Device</th>
                    <th className="px-2 py-1.5 text-right font-medium">W</th>
                    <th className="px-2 py-1.5 text-right font-medium">A</th>
                    <th className="px-2 py-1.5 text-right font-medium">n/s</th>
                  </tr>
                </thead>
                <tbody>
                  {[...recent].reverse().map((r, i) => {
                    const port = portByDevice.get(r.deviceId);
                    return (
                      <tr key={`${r.deviceId}-${r.ts}-${i}`} data-testid="live-raw-row" className="border-t border-border">
                        <td className="px-2 py-1.5 font-mono-nums text-[11px] text-text-muted">{formatDateTime(r.ts).split(" ")[1]}</td>
                        <td className="px-2 py-1.5 text-text-muted">{r.deviceId}</td>
                        <td className="px-2 py-1.5 text-right font-mono-nums text-[11px] text-text">{r.watts.toFixed(0)}</td>
                        <td className="px-2 py-1.5 text-right font-mono-nums text-[11px] text-text-muted">{port?.irms_raw_a != null ? port.irms_raw_a.toFixed(2) : "—"}</td>
                        <td className="px-2 py-1.5 text-right font-mono-nums text-[11px] text-text-muted">{port?.n_samples ?? "—"}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
