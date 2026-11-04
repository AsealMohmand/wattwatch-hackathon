import { AlertOctagon, Clock, FileQuestion, Sparkles } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router-dom";
import { Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  useAlerts,
  useAnalyticsHourly,
  useDevice,
  useEvents,
  useIncidents,
  usePatchDevice,
  useReadings,
  useRules,
  useSettings,
} from "../api/hooks";
import { useLiveReadings } from "../api/stream";
import { guessDeviceKind } from "../api/ai";
import type { Explanation } from "../api/client";
import { DeviceChart } from "../components/DeviceChart";
import { DEVICE_KINDS, DeviceKindIcon, KIND_LABEL } from "../components/DeviceKindIcon";
import { AiMeta } from "../components/ai/AiMeta";
import { ConfidenceMeter } from "../components/ai/ConfidenceMeter";
import { VerdictChip } from "../components/ai/VerdictChip";
import { EmptyState } from "../components/EmptyState";
import { MethodChip } from "../components/MethodChip";
import { RangeButtons, RANGE_LABEL, RANGE_MS, type ChartRange } from "../components/PowerChart";
import { SeverityTag } from "../components/SeverityTag";
import { Skeleton } from "../components/Skeleton";
import { StatCard } from "../components/StatCard";
import { formatCost, formatDateTime, formatDuration, formatKwh, formatKwhTick, formatRelative, formatWatts } from "../lib/format";
import { useShellOutletContext } from "../lib/outletContext";
import { Link } from "react-router-dom";

export function DeviceProfile() {
  const { deviceId = "" } = useParams<{ deviceId: string }>();
  const device = useDevice(deviceId);
  const patch = usePatchDevice(deviceId);
  const { setDeviceTitle } = useShellOutletContext();
  const nameInputRef = useRef<HTMLInputElement>(null);

  const [range, setRange] = useState<ChartRange>("1h");
  const [nowMs, setNowMs] = useState(Date.now());

  useEffect(() => {
    const interval = range === "24h" || range === "6h" ? 30000 : 2000;
    const id = window.setInterval(() => setNowMs(Date.now()), interval);
    return () => window.clearInterval(id);
  }, [range]);

  useEffect(() => {
    if (device.data) setDeviceTitle(device.data.name);
  }, [device.data, setDeviceTitle]);

  const readings = useReadings({ device_id: deviceId, since_ms: nowMs - RANGE_MS[range], until_ms: nowMs, max_points: 600 });
  const events = useEvents({ device_id: deviceId, limit: 50 });
  const incidents = useIncidents({ device_id: deviceId, limit: 50 });
  const alerts = useAlerts({ device_id: deviceId, status: "active" });
  const rules = useRules();
  const settings = useSettings();
  const hourly = useAnalyticsHourly({ device_id: deviceId, days: 7 });
  // SSE-first live watts (api/stream.ts), falling back to the 2s-polled
  // `device.data.watts` below until the first reading arrives over the
  // stream -- never a blank header while the connection is still opening.
  const liveReadings = useLiveReadings(deviceId, 10);

  const aiSummary = useMemo(() => {
    const counts = new Map<string, { count: number; latest: Explanation }>();
    for (const inc of incidents.data ?? []) {
      const appliance = inc.ai?.appliance;
      if (!appliance) continue;
      const key = appliance.trim().toLowerCase();
      const entry = counts.get(key);
      if (entry) entry.count += 1;
      else counts.set(key, { count: 1, latest: inc.ai! });
    }
    if (counts.size === 0) return null;
    return [...counts.values()].sort((a, b) => b.count - a.count)[0].latest;
  }, [incidents.data]);
  const guessedKind = aiSummary?.appliance ? guessDeviceKind(aiSummary.appliance) : null;

  const cycleStats = useMemo(() => {
    const list = incidents.data ?? [];
    const todayStart = (() => {
      const dt = new Date();
      dt.setHours(0, 0, 0, 0);
      return dt.getTime();
    })();
    const cyclesToday = list.filter((i) => i.start_ts >= todayStart).length;
    const kwhEstimates = list.map((i) => (i.peak_w * i.duration_s) / 3_600_000);
    const avgKwh = kwhEstimates.length > 0 ? kwhEstimates.reduce((a, b) => a + b, 0) / kwhEstimates.length : null;
    const price = settings.data?.price_per_kwh;
    const costPerRun = avgKwh != null && price != null ? avgKwh * price : null;
    return { cyclesToday, costPerRun };
  }, [incidents.data, settings.data]);

  const usagePattern = useMemo(() => {
    const rows = hourly.data ?? [];
    if (rows.length === 0) return [];
    const sums = new Array(24).fill(0);
    const counts = new Array(24).fill(0);
    for (const r of rows) {
      sums[r.hour] += r.kwh;
      counts[r.hour] += 1;
    }
    return sums.map((s, hour) => ({ hour, kwh: counts[hour] ? s / counts[hour] : 0 }));
  }, [hourly.data]);

  const [name, setName] = useState("");
  const [room, setRoom] = useState("");
  const [ratedW, setRatedW] = useState("");
  const [notes, setNotes] = useState("");

  useEffect(() => {
    if (!device.data) return;
    setName(device.data.name);
    setRoom(device.data.room ?? "");
    setRatedW(device.data.rated_w != null ? String(device.data.rated_w) : "");
    setNotes(device.data.notes ?? "");
  }, [device.data?.device_id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (device.isLoading) return <Skeleton className="h-96 w-full" />;
  if (!device.data) {
    return <EmptyState icon={FileQuestion} title="Device not found." detail="It may have been removed, or the id in the address is wrong." />;
  }
  const d = device.data;

  const applicableRules = (rules.data ?? []).filter((r) => r.device_id === null || r.device_id === deviceId);
  const unnamed = d.name === d.device_id && d.kind === "unknown";

  return (
    <div className="flex flex-col gap-5">
      {unnamed && (
        <div
          data-testid="unnamed-device-callout"
          className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-warning bg-warning-bg px-4 py-2.5 text-sm text-text"
        >
          <span>Give this device a name and kind so alerts read clearly.</span>
          <button
            type="button"
            data-testid="unnamed-device-name-button"
            onClick={() => nameInputRef.current?.focus()}
            className="shrink-0 rounded-md border border-border px-2.5 py-1.5 text-xs text-text transition-colors hover:bg-surface-raised"
          >
            Name device
          </button>
        </div>
      )}

      <section className="flex flex-col gap-4 rounded-md border border-border bg-surface p-4">
        <div className="flex flex-wrap items-center gap-3">
          <DeviceKindIcon kind={d.kind} size={22} />
          <input
            ref={nameInputRef}
            data-testid="device-name-input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
            onBlur={() => name.trim() && name !== d.name && patch.mutate({ name: name.trim() })}
            className="min-w-0 flex-1 rounded-md border border-transparent bg-transparent px-1 text-lg font-medium text-text focus:border-border focus:bg-bg focus:outline-none"
          />
          <span
            data-testid="device-online-dot"
            data-online={d.online}
            className={`h-2 w-2 shrink-0 rounded-full ${d.online ? "bg-trace" : "bg-critical"}`}
          />
          <span data-testid="device-live-watts" className="font-mono-nums text-xl text-text">
            {d.online ? formatWatts(liveReadings.length > 0 ? liveReadings[liveReadings.length - 1].watts : d.watts) : "—"}
          </span>
        </div>
        {!d.online && (
          <span data-testid="device-last-seen" className="-mt-2 text-xs text-text-muted">
            {d.last_ts != null ? `Last seen ${formatRelative(d.last_ts)} at ${formatWatts(d.last_watts)}` : "No readings yet."}
          </span>
        )}

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Kind
            <select
              data-testid="device-kind-select"
              value={d.kind}
              onChange={(e) => patch.mutate({ kind: e.target.value as typeof d.kind })}
              className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text focus:outline-none"
            >
              {DEVICE_KINDS.map((k) => (
                <option key={k} value={k}>
                  {KIND_LABEL[k]}
                </option>
              ))}
            </select>
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Room
            <input
              data-testid="device-room-input"
              value={room}
              onChange={(e) => setRoom(e.target.value)}
              onBlur={() => patch.mutate({ room: room.trim() || null })}
              className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Rated power (W)
            <input
              data-testid="device-rated-w-input"
              value={ratedW}
              onChange={(e) => setRatedW(e.target.value)}
              onBlur={() => patch.mutate({ rated_w: ratedW.trim() === "" ? null : Number(ratedW) })}
              inputMode="decimal"
              className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text font-mono-nums focus:outline-none"
            />
          </label>
          <label className="flex flex-col gap-1 text-xs text-text-muted">
            Notes
            <input
              data-testid="device-notes-input"
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              onBlur={() => patch.mutate({ notes: notes.trim() || null })}
              className="rounded-md border border-border bg-bg px-2 py-1.5 text-sm text-text focus:outline-none"
            />
          </label>
        </div>
      </section>

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <StatCard testId="stat-avg-1h" label="Avg, 1h" value={formatWatts(d.stats.avg_w_1h)} />
        <StatCard testId="stat-peak-24h" label="Peak, 24h" value={formatWatts(d.stats.peak_w_24h)} />
        <StatCard testId="stat-kwh-today-device" label="kWh today" accent="copper" value={formatKwh(d.stats.kwh_today)} />
        <StatCard testId="stat-kwh-7d-device" label="kWh, 7d" accent="copper" value={formatKwh(d.stats.kwh_7d)} />
        <StatCard testId="stat-on-time" label="On-time today" value={formatDuration(d.stats.on_time_today_s)} />
        <StatCard testId="stat-baseline" label="Baseline" value={formatWatts(d.stats.baseline_w)} />
        <StatCard testId="stat-cycles-today" label="Cycles today" value={String(cycleStats.cyclesToday)} />
        <StatCard
          testId="stat-cost-per-run"
          label="Cost per run"
          accent="copper"
          value={cycleStats.costPerRun != null ? formatCost(cycleStats.costPerRun, settings.data?.currency) : "—"}
          sub="Estimated from peak watts × duration"
        />
      </div>

      {aiSummary && (
        <section className="flex flex-wrap items-center justify-between gap-3 rounded-md border border-border bg-surface p-4">
          <div className="flex flex-wrap items-center gap-2">
            <Sparkles size={16} className="text-info" aria-hidden />
            <span className="text-sm text-text-muted">AI guess:</span>
            <span className="text-sm font-medium text-text" data-testid="device-ai-appliance">
              {aiSummary.appliance}
            </span>
            {aiSummary.confidence && <ConfidenceMeter confidence={aiSummary.confidence} />}
          </div>
          {guessedKind && guessedKind !== d.kind && (
            <button
              type="button"
              data-testid="use-as-kind-button"
              onClick={() => patch.mutate({ kind: guessedKind })}
              className="rounded-md border border-border px-2.5 py-1.5 text-xs font-medium text-text transition-colors hover:border-trace"
            >
              Use as kind: {KIND_LABEL[guessedKind]}
            </button>
          )}
        </section>
      )}

      <section className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
        <h2 className="text-sm font-medium text-text">kWh by hour of day, last 7 days</h2>
        {hourly.isLoading ? (
          <Skeleton className="h-48 w-full" />
        ) : usagePattern.length > 0 && usagePattern.some((p) => p.kwh > 0) ? (
          <div data-testid="usage-pattern-chart" className="h-48 w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={usagePattern} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
                <CartesianGrid strokeDasharray="2 4" stroke="var(--color-border)" vertical={false} />
                <XAxis dataKey="hour" tickFormatter={(h: number) => `${h}`} stroke="var(--color-text-muted)" fontSize={10} tickLine={false} axisLine={false} interval={2} />
                <YAxis tickFormatter={(v) => formatKwhTick(Number(v))} stroke="var(--color-text-muted)" fontSize={10} tickLine={false} axisLine={false} width={36} />
                <Tooltip
                  formatter={(value) => [formatKwh(Number(value)), "avg"]}
                  labelFormatter={(h) => `${h}:00`}
                  contentStyle={{ background: "var(--color-surface-raised)", border: "1px solid var(--color-border)", borderRadius: 6, fontSize: 12 }}
                />
                <Bar dataKey="kwh" fill="var(--color-copper)" isAnimationActive={false} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        ) : (
          <EmptyState
            icon={Clock}
            title="No usage pattern yet."
            detail="An hour-by-hour average builds up over the device's first week of readings."
            testId="usage-pattern-empty"
          />
        )}
      </section>

      <section className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-text">Power</h2>
          <RangeButtons ranges={["10m", "1h", "6h", "24h"]} value={range} onChange={setRange} />
        </div>
        <DeviceChart
          points={readings.data?.points ?? []}
          events={events.data ?? []}
          loading={readings.isLoading}
          lastTs={readings.data?.last_ts}
          rangeLabel={RANGE_LABEL[range]}
          onShowLast24h={range !== "24h" ? () => setRange("24h") : undefined}
        />
      </section>

      {alerts.data && alerts.data.length > 0 && (
        <section className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
          <div className="flex items-center justify-between gap-3">
            <h2 className="text-sm font-medium text-text">{alerts.data.length} active</h2>
            <Link to={`/alerts?device_id=${encodeURIComponent(deviceId)}`} className="text-xs text-trace hover:underline">
              View all on Alerts
            </Link>
          </div>
          <ul data-testid="device-active-alerts" className="flex flex-col gap-2">
            {[...alerts.data]
              .sort((a, b) => b.opened_ts - a.opened_ts)
              .slice(0, 3)
              .map((a) => (
                <li key={a.id}>
                  <Link
                    to={`/alerts?open=${a.id}`}
                    className="flex items-center gap-2 rounded-md border border-border px-3 py-2 text-sm hover:border-trace"
                  >
                    <SeverityTag severity={a.severity} />
                    <span className="min-w-0 flex-1 truncate text-text">{a.title}</span>
                    <span className="font-mono-nums shrink-0 text-xs text-text-muted">{formatRelative(a.opened_ts)}</span>
                  </Link>
                </li>
              ))}
          </ul>
        </section>
      )}

      <section className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
        <h2 className="text-sm font-medium text-text">Incidents</h2>
        {incidents.isLoading ? (
          <Skeleton className="h-32 w-full" />
        ) : incidents.data && incidents.data.length > 0 ? (
          <ul data-testid="device-incidents-list" className="flex flex-col gap-2">
            {incidents.data.map((inc) => (
              <li key={inc.id} className="flex flex-col gap-1 rounded-md border border-border px-3 py-2 text-sm">
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="flex items-center gap-2">
                    {inc.methods.includes("rule") && <MethodChip method="rule" />}
                    {inc.methods.includes("iforest") && <MethodChip method="iforest" />}
                    <span className="font-mono-nums text-text-muted">{formatDateTime(inc.start_ts)}</span>
                    <span className="text-text-muted">Duration {formatDuration(inc.duration_s)}</span>
                  </span>
                  <span className="font-mono-nums text-text">
                    {formatWatts(inc.peak_w)} peak{inc.baseline_w != null ? ` / ${formatWatts(inc.baseline_w)} baseline` : ""}
                  </span>
                </div>
                {inc.ai ? (
                  <div className="flex flex-col gap-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-text">{inc.ai.appliance ?? "Unidentified load"}</span>
                      {inc.ai.confidence && <ConfidenceMeter confidence={inc.ai.confidence} />}
                      {inc.ai.verdict && <VerdictChip verdict={inc.ai.verdict} />}
                    </div>
                    <p data-testid="device-incident-explanation" className="text-text-muted">
                      {inc.ai.summary}
                    </p>
                    <AiMeta model={inc.ai.model} latencyMs={inc.ai.latency_ms} fallback={inc.ai.fallback} />
                  </div>
                ) : (
                  <p data-testid="device-incident-explanation" className="text-text-muted">
                    {inc.explanation ?? "Explaining…"}
                  </p>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <EmptyState icon={AlertOctagon} title="No incidents yet." detail="Spikes and unusual patterns for this device merge into incidents here." />
        )}
      </section>

      <section className="flex flex-col gap-2 rounded-md border border-border bg-surface p-4">
        <div className="flex items-center justify-between">
          <h2 className="text-sm font-medium text-text">Alert rules for this device</h2>
          <Link to="/settings" className="text-xs text-trace hover:underline">
            Edit rules
          </Link>
        </div>
        {applicableRules.length > 0 ? (
          <ul data-testid="device-rules-list" className="flex flex-col gap-1.5 text-sm">
            {applicableRules.map((r) => (
              <li key={r.id} className="flex items-center justify-between gap-2 rounded-md border border-border px-3 py-1.5">
                <span className="text-text">{r.name}</span>
                <span className="flex items-center gap-2">
                  <SeverityTag severity={r.severity} />
                  <span className={`text-xs ${r.enabled ? "text-trace" : "text-text-muted"}`}>{r.enabled ? "Enabled" : "Disabled"}</span>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-sm text-text-muted">No rules apply to this device yet.</p>
        )}
      </section>
    </div>
  );
}
