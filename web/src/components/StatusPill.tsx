import type { StreamState, StreamStatus } from "../api/stream";

const COPY: Record<StreamState, string> = {
  connecting: "Connecting…",
  live: "Live",
  reconnecting: "Reconnecting…",
  offline: "Offline",
};

const DOT: Record<StreamState, string> = {
  connecting: "bg-text-muted",
  live: "bg-trace",
  reconnecting: "bg-warning",
  offline: "bg-critical",
};

/** F1-1: the SSE connection chip. Shows the shared stream's state (not
 * last-reading recency, which the data itself already communicates via
 * device online dots) with readings/min in its tooltip. */
export function StatusPill({ status }: { status: StreamStatus }) {
  const state = status.state === "connecting" ? "reconnecting" : status.state;
  return (
    <span
      data-testid="status-pill"
      data-state={status.state}
      title={`${status.readingsPerMin} readings/min`}
      className="inline-flex items-center gap-1.5 rounded-full border border-border bg-surface px-2.5 py-1 text-xs text-text-muted"
    >
      <span className={`h-1.5 w-1.5 rounded-full ${DOT[state]} ${state === "live" ? "animate-pulse" : ""}`} aria-hidden />
      {COPY[state]}
    </span>
  );
}
