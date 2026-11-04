// F1-2: a single shared EventSource('/api/stream') with exponential-backoff
// reconnect (1s doubling to 30s), a subscription store for live readings
// (useLiveReadings), and a raw event/alert passthrough react-query uses to
// invalidate its caches the instant something happens instead of waiting
// out a poll interval.
//
// Everything below lives outside React (module-level singletons) so every
// component sees the same connection and the same ring buffers, no matter
// how many times useLiveReadings/useStreamStatus are called. React only
// subscribes to it via useSyncExternalStore.
import { useEffect, useMemo } from "react";
import { useSyncExternalStore } from "react";
import type { Alert, EnergyEvent, Explanation } from "./client";

export type StreamState = "connecting" | "live" | "reconnecting" | "offline";

export interface StreamStatus {
  state: StreamState;
  /** From the SSE `status` frame, sent every 5s; 0 until the first one
   * arrives. Shown in the connection chip's tooltip. */
  readingsPerMin: number;
  servicesOk: boolean;
}

export interface LivePoint {
  ts: number;
  watts: number;
}

export type StreamEvent =
  | { kind: "event"; data: EnergyEvent & { ai: Explanation | null } }
  | { kind: "alert"; data: Alert };

// Keep enough history that any reasonable useLiveReadings(windowS) caller
// (the Home hero's 60s trace, Live's 5-minute strip chart) can slice what
// it needs out of one shared buffer instead of each hook re-subscribing.
const RING_WINDOW_MS = 6 * 60 * 1000;
const INITIAL_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 30_000;

let status: StreamStatus = { state: "connecting", readingsPerMin: 0, servicesOk: true };
let version = 0; // bumped on every reading applied; the useSyncExternalStore snapshot for readings
const statusListeners = new Set<() => void>();
const readingsListeners = new Set<() => void>();
const eventListeners = new Set<(e: StreamEvent) => void>();

const deviceRings = new Map<string, LivePoint[]>();
const latestByDevice = new Map<string, number>();
let totalRing: LivePoint[] = [];

/** Flat chronological log of raw reading frames across every device, for
 * Live's raw telemetry table. Capped by count, not by time, since it's a
 * "last N rows" table rather than a windowed chart. */
const FLAT_LOG_CAP = 100;
export interface FlatReading extends LivePoint {
  deviceId: string;
}
let flatLog: FlatReading[] = [];

/** r1 FA-3: seeds the shared per-device ring buffers and the flat log with
 * readings fetched from GET /api/readings (ascending ts, any mix of
 * devices), so a page that mounts after data already exists -- the Live
 * page's 5-minute chart and raw telemetry table -- is full on first paint
 * instead of growing in empty while it waits for the next SSE frame.
 *
 * De-duplicated by (deviceId, ts): a point this already has (because a
 * live frame beat the historical fetch back, or this is called twice) is
 * dropped rather than appended again. Safe to call before `ensureStarted`
 * -- it only touches the module-level buffers, not the connection. */
export function seedReadingsHistory(points: FlatReading[]) {
  if (points.length === 0) return;
  for (const p of points) {
    const ring = deviceRings.get(p.deviceId) ?? [];
    deviceRings.set(p.deviceId, pushPoint(ring, { ts: p.ts, watts: p.watts }));
  }
  const seen = new Set(flatLog.map((f) => `${f.deviceId}:${f.ts}`));
  let changed = false;
  for (const p of points) {
    const key = `${p.deviceId}:${p.ts}`;
    if (seen.has(key)) continue;
    seen.add(key);
    flatLog.push(p);
    changed = true;
  }
  if (!changed) return;
  flatLog.sort((a, b) => a.ts - b.ts);
  if (flatLog.length > FLAT_LOG_CAP) flatLog = flatLog.slice(flatLog.length - FLAT_LOG_CAP);
  version++;
  readingsListeners.forEach((l) => l());
}

function setStatus(patch: Partial<StreamStatus>) {
  status = { ...status, ...patch };
  statusListeners.forEach((l) => l());
}

function pushPoint(ring: LivePoint[], point: LivePoint): LivePoint[] {
  // De-duplicated by ts: a resend of the same timestamp (reconnect replay,
  // a device whose clock hasn't ticked) replaces in place rather than
  // appending a second point at the same x.
  if (ring.length > 0 && ring[ring.length - 1].ts === point.ts) {
    ring[ring.length - 1] = point;
  } else {
    ring.push(point);
  }
  const cutoff = point.ts - RING_WINDOW_MS;
  let drop = 0;
  while (drop < ring.length && ring[drop].ts < cutoff) drop++;
  if (drop > 0) ring.splice(0, drop);
  return ring;
}

function handleReading(data: { device_id: string; ts: number; watts: number }) {
  if (typeof data?.ts !== "number" || typeof data?.watts !== "number" || !data.device_id) return;
  latestByDevice.set(data.device_id, data.watts);
  const ring = deviceRings.get(data.device_id) ?? [];
  deviceRings.set(data.device_id, pushPoint(ring, { ts: data.ts, watts: data.watts }));
  let total = 0;
  for (const w of latestByDevice.values()) total += w;
  totalRing = pushPoint(totalRing, { ts: data.ts, watts: total });
  flatLog.push({ ts: data.ts, watts: data.watts, deviceId: data.device_id });
  if (flatLog.length > FLAT_LOG_CAP) flatLog = flatLog.slice(flatLog.length - FLAT_LOG_CAP);
  version++;
  readingsListeners.forEach((l) => l());
}

let es: EventSource | null = null;
let backoffMs = INITIAL_BACKOFF_MS;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let started = false;

function scheduleReconnect() {
  if (reconnectTimer || status.state === "offline") return;
  setStatus({ state: "reconnecting" });
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
  }, backoffMs);
  backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
}

function parse<T>(ev: Event): T | null {
  try {
    return JSON.parse((ev as MessageEvent).data) as T;
  } catch {
    return null;
  }
}

function connect() {
  if (typeof window === "undefined" || typeof EventSource === "undefined") return;
  try {
    es?.close();
  } catch {
    // already gone
  }
  es = new EventSource("/api/stream");
  es.onopen = () => {
    backoffMs = INITIAL_BACKOFF_MS;
    setStatus({ state: "live" });
  };
  es.onerror = () => scheduleReconnect();
  es.addEventListener("reading", (ev) => {
    const data = parse<{ device_id: string; ts: number; watts: number }>(ev);
    if (data) handleReading(data);
  });
  es.addEventListener("event", (ev) => {
    const data = parse<EnergyEvent & { ai: Explanation | null }>(ev);
    if (data) eventListeners.forEach((l) => l({ kind: "event", data }));
  });
  es.addEventListener("alert", (ev) => {
    const data = parse<Alert>(ev);
    if (data) eventListeners.forEach((l) => l({ kind: "alert", data }));
  });
  es.addEventListener("status", (ev) => {
    const data = parse<{ ts: number; readings_per_min: number; services_ok: boolean }>(ev);
    if (data) setStatus({ readingsPerMin: data.readings_per_min, servicesOk: data.services_ok, state: "live" });
  });
}

function ensureStarted() {
  if (started) return;
  started = true;
  connect();
  window.addEventListener("offline", () => {
    try {
      es?.close();
    } catch {
      // already gone
    }
    backoffMs = INITIAL_BACKOFF_MS;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    setStatus({ state: "offline" });
  });
  window.addEventListener("online", () => {
    backoffMs = INITIAL_BACKOFF_MS;
    connect();
  });
}

function getStreamStatus(): StreamStatus {
  return status;
}

function subscribeStreamStatus(cb: () => void): () => void {
  ensureStarted();
  statusListeners.add(cb);
  return () => {
    statusListeners.delete(cb);
  };
}

/** Connection state for the shell's SSE chip: "connecting" (initial),
 * "live", "reconnecting" (backoff in progress) or "offline" (browser
 * reports no network). */
export function useStreamStatus(): StreamStatus {
  return useSyncExternalStore(subscribeStreamStatus, getStreamStatus, getStreamStatus);
}

function subscribeReadings(cb: () => void): () => void {
  ensureStarted();
  readingsListeners.add(cb);
  return () => {
    readingsListeners.delete(cb);
  };
}

function getReadingsVersion() {
  return version;
}

/** Non-hook read of a device's (or, with no id, the live total's) ring
 * buffer, sliced to the last `windowS` seconds. For a component that needs
 * several devices' series at once (a multi-series chart built from a
 * device *list*, whose length can change) — calling a hook once per device
 * in a loop would break the rules of hooks, so that case subscribes once
 * with `useReadingsVersion` and calls this plain function per device
 * inside its own `useMemo`. */
export function getLiveReadings(deviceId?: string, windowS = 300): LivePoint[] {
  const ring = deviceId ? deviceRings.get(deviceId) ?? [] : totalRing;
  if (ring.length === 0) return [];
  const cutoff = ring[ring.length - 1].ts - windowS * 1000;
  return ring.filter((p) => p.ts >= cutoff);
}

/** A ring buffer of live readings, de-duplicated by ts, sliced to the last
 * `windowS` seconds. With no `deviceId`, returns the live *total* across
 * every device (summed at each reading, not just the devices seen at
 * mount) — what the Home hero's trace and split bar want. With a
 * `deviceId`, returns that device's own buffer — what Live's per-device
 * strip charts want. */
export function useLiveReadings(deviceId?: string, windowS = 300): LivePoint[] {
  const v = useSyncExternalStore(subscribeReadings, getReadingsVersion, getReadingsVersion);
  return useMemo(
    () => getLiveReadings(deviceId, windowS),
    // `v` is the real dependency (it changes whenever any ring mutates);
    // the rings themselves live outside React state, so eslint can't see
    // the connection between `v` and `deviceRings`/`totalRing`.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [deviceId, windowS, v],
  );
}

/** Subscribes to the same "a reading arrived" signal as useLiveReadings
 * without picking a device — for a component that reads several devices'
 * rings at once via getLiveReadings inside its own useMemo. */
export function useReadingsVersion(): number {
  return useSyncExternalStore(subscribeReadings, getReadingsVersion, getReadingsVersion);
}

/** The last `limit` raw reading frames across every device, newest last —
 * Live's raw telemetry table. */
export function useRecentReadings(limit = 20): FlatReading[] {
  const v = useSyncExternalStore(subscribeReadings, getReadingsVersion, getReadingsVersion);
  return useMemo(
    () => flatLog.slice(Math.max(0, flatLog.length - limit)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [limit, v],
  );
}

/** Raw SSE event/alert frames, for the Live page's ticker and for wiring
 * react-query cache invalidation (see useStreamBridge below). */
export function subscribeStreamEvents(cb: (e: StreamEvent) => void): () => void {
  ensureStarted();
  eventListeners.add(cb);
  return () => {
    eventListeners.delete(cb);
  };
}

/** Invalidates the given react-query key lists the instant an `event` or
 * `alert` SSE frame arrives, so polling-backed pages refresh immediately
 * instead of waiting out their interval. Mount once near the app root with
 * a stable `invalidate` callback (e.g. `qc.invalidateQueries`-based). */
export function useStreamBridge(invalidate: (keys: string[][]) => void) {
  useEffect(() => {
    return subscribeStreamEvents((e) => {
      if (e.kind === "event") {
        invalidate([["events"], ["incidents"], ["overview"], ["devices"]]);
      } else {
        invalidate([["alerts"], ["alerts-summary"], ["overview"]]);
      }
    });
  }, [invalidate]);
}
