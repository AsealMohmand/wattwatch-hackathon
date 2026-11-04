// F1-5 (list): a card per hub node — status, firmware, humanized uptime,
// boot count, readings/min, last seen, and port chips (ch0/ch1 with the
// mapped device and live amps).
import { Cable, Cpu } from "lucide-react";
import { Link } from "react-router-dom";
import { useNodes } from "../api/hooks";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { formatDuration, formatRelative } from "../lib/format";

export function Nodes() {
  const nodes = useNodes();

  if (nodes.isLoading) {
    return (
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <Skeleton className="h-40 w-full" />
        <Skeleton className="h-40 w-full" />
      </div>
    );
  }

  const list = nodes.data ?? [];
  if (list.length === 0) {
    return <EmptyState icon={Cpu} title="No nodes yet." detail="A node appears here the first time its firmware reports telemetry." />;
  }

  return (
    <div data-testid="nodes-grid" className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
      {list.map((n) => (
        <Link
          key={n.node_id}
          to={`/nodes/${encodeURIComponent(n.node_id)}`}
          data-testid="node-card"
          data-node-id={n.node_id}
          className="flex flex-col gap-3 rounded-md border border-border bg-surface p-4 transition-colors hover:border-trace"
        >
          <div className="flex items-center justify-between">
            <span className="flex items-center gap-2 text-sm font-medium text-text">
              <Cpu size={15} className="text-text-muted" />
              {n.node_id}
            </span>
            <span
              data-testid="node-online-dot"
              data-online={n.online}
              className={`h-2 w-2 shrink-0 rounded-full ${n.online ? "bg-trace" : "bg-critical"}`}
              aria-label={n.online ? "Online" : "Offline"}
            />
          </div>
          <div className="grid grid-cols-2 gap-2 text-xs text-text-muted">
            <span>
              Firmware <span className="font-mono-nums text-text">{n.fw ?? "—"}</span>
            </span>
            <span>
              Uptime <span className="font-mono-nums text-text">{n.uptime_ms != null ? formatDuration(n.uptime_ms / 1000) : "—"}</span>
            </span>
            <span>
              Boots <span className="font-mono-nums text-text">{n.boots}</span>
            </span>
            <span>
              Readings/min <span className="font-mono-nums text-text">{n.readings_per_min.toFixed(0)}</span>
            </span>
            <span className="col-span-2">
              Last seen <span className="font-mono-nums text-text">{formatRelative(n.last_ts)}</span>
            </span>
          </div>
          <div className="flex flex-wrap gap-1.5 border-t border-border pt-2">
            {n.ports.map((p) => (
              <span
                key={p.port}
                data-testid="node-port-chip"
                className={`flex items-center gap-1.5 rounded-md border px-2 py-1 text-[11px] ${
                  p.online ? "border-trace text-trace" : "border-border text-text-muted"
                }`}
              >
                <Cable size={11} />
                {p.port}
                {p.device_name && <span className="text-text-muted">{p.device_name}</span>}
                {p.irms_raw_a != null && <span className="font-mono-nums">{p.irms_raw_a.toFixed(2)} A</span>}
              </span>
            ))}
          </div>
        </Link>
      ))}
    </div>
  );
}
