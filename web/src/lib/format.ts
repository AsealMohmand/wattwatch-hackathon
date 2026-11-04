// Formatting helpers shared by every page. Keep units attached to every
// number that leaves this module — the plan requires units always shown.

export function formatWatts(w: number | null | undefined): string {
  if (w == null || Number.isNaN(w)) return "— W";
  return `${w.toLocaleString("en-US", { maximumFractionDigits: 0 })} W`;
}

export function formatKwh(kwh: number | null | undefined): string {
  if (kwh == null || Number.isNaN(kwh)) return "— kWh";
  return `${kwh.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })} kWh`;
}

export function formatCost(cost: number | null | undefined, currency = "$"): string {
  if (cost == null || Number.isNaN(cost)) return `— ${currency}`;
  return `${currency}${cost.toLocaleString("en-US", { maximumFractionDigits: 2, minimumFractionDigits: 2 })}`;
}

/** Compact kWh for a chart axis tick: <=3 significant figures, no unit
 * suffix (the chart's own heading already says "kWh"), and no clipped
 * leading digit at small values ("0.015", not ".015"). */
export function formatKwhTick(kwh: number | null | undefined): string {
  if (kwh == null || Number.isNaN(kwh)) return "—";
  if (kwh === 0) return "0";
  let s = Math.abs(kwh).toPrecision(3);
  if (s.includes("e")) s = Math.abs(kwh).toFixed(3);
  if (s.includes(".")) s = s.replace(/0+$/, "").replace(/\.$/, "");
  return kwh < 0 ? `-${s}` : s;
}

export function formatVolts(v: number | null | undefined): string {
  if (v == null || Number.isNaN(v)) return "— V";
  return `${v} V`;
}

/** Local 24h HH:mm:ss, per the plan. */
export function formatTime(ts: number | null | undefined): string {
  if (ts == null) return "—";
  const d = new Date(ts);
  return d.toLocaleTimeString("en-GB", { hour12: false });
}

/** Local date + 24h time, for absolute timestamps in tables/drawers. */
export function formatDateTime(ts: number | null | undefined): string {
  if (ts == null) return "—";
  const d = new Date(ts);
  const date = d.toLocaleDateString("en-CA"); // YYYY-MM-DD
  return `${date} ${formatTime(ts)}`;
}

/** HH:mm:ss, with the date prefixed only when `ts` isn't today relative to
 * `nowMs` — the second, muted line under a relative timestamp. */
export function formatAbsoluteShort(ts: number | null | undefined, nowMs: number = Date.now()): string {
  if (ts == null) return "—";
  const d = new Date(ts);
  const now = new Date(nowMs);
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  return sameDay ? formatTime(ts) : formatDateTime(ts);
}

/** "3m ago", "just now", "2h ago" — for relative timestamps. */
export function formatRelative(ts: number | null | undefined, nowMs: number = Date.now()): string {
  if (ts == null) return "—";
  const deltaS = Math.max(0, Math.round((nowMs - ts) / 1000));
  if (deltaS < 5) return "just now";
  if (deltaS < 60) return `${deltaS}s ago`;
  const m = Math.floor(deltaS / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

/** Duration in seconds -> "1m 30s" / "45s" / "2h 3m". */
export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null || Number.isNaN(seconds)) return "—";
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h ${m}m`;
  if (m > 0) return `${m}m ${sec}s`;
  return `${sec}s`;
}

export function deviceLabel(deviceId: string): string {
  return deviceId.split("/").pop() ?? deviceId;
}

/** Humanized hint next to a raw-seconds rule duration input ("4 h", "90 s",
 * "2 m") — a quick sanity check, not a replacement for the editable field. */
export function formatDurationHint(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return "0 s";
  if (seconds % 3600 === 0) return `${seconds / 3600} h`;
  if (seconds % 60 === 0) return `${seconds / 60} m`;
  return `${seconds} s`;
}
