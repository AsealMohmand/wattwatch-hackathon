import { Handle, Position, type NodeProps } from "@xyflow/react";
import { Router, Cable, Plug, Zap } from "lucide-react";
import type { TopologyNodeKind, TopologyStatus } from "../api/client";
import { formatWatts } from "../lib/format";
import { DeviceKindIcon } from "./DeviceKindIcon";
import type { DeviceKind } from "../api/client";

export interface PanelNodeData extends Record<string, unknown> {
  label: string;
  kind: TopologyNodeKind;
  status: TopologyStatus;
  watts: number | null;
  deviceKind?: DeviceKind;
  clickable: boolean;
  /** F1-8: node health badge (fw + humanized uptime) on "node"-kind boxes,
   * from the v2 /api/nodes list. Undefined for kinds other than "node", or
   * before that list has loaded. */
  health?: { fw: string | null; uptimeLabel: string | null };
}

const KIND_ICON: Record<TopologyNodeKind, typeof Router> = {
  hub: Router,
  node: Cable,
  port: Plug,
  appliance: Zap,
};

const STATUS_BAR: Record<TopologyStatus, string> = {
  online: "bg-trace",
  offline: "bg-critical",
  unknown: "bg-text-muted",
};

/** Breaker-panel-style node: sharp corners, a left status bar instead of a
 * glow or drop shadow — reads as hardware, not a flowchart bubble. */
export function PanelNodeView({ data }: NodeProps & { data: PanelNodeData }) {
  const Icon = data.kind === "appliance" && data.deviceKind ? undefined : KIND_ICON[data.kind];
  return (
    // A fixed width, identical across every node kind, is load-bearing:
    // the tree layout (lib/topologyLayout.ts) positions nodes by their
    // left edge assuming every box is the same width, so a child centers
    // under its parent only when widths actually match. A min-width that
    // grows with each node's own label/wattage text (the old behavior)
    // breaks that for any parent/child pair with different text lengths —
    // e.g. "ch1" under a port vs. "Space heater" / "1,480 W" under an
    // appliance — and the step edge jogs sideways instead of dropping
    // straight down.
    <div
      data-testid="topology-node"
      data-kind={data.kind}
      data-status={data.status}
      className={`flex w-[152px] items-stretch overflow-hidden rounded-none border bg-surface text-sm shadow-none transition-colors ${
        data.clickable ? "cursor-pointer hover:border-trace" : "border-border"
      } ${data.status === "offline" ? "opacity-70" : ""}`}
      style={{ borderColor: "var(--color-border)" }}
    >
      <Handle type="target" position={Position.Top} style={{ visibility: "hidden" }} />
      <span className={`w-1 shrink-0 ${STATUS_BAR[data.status]}`} aria-hidden />
      <div className="flex min-w-0 flex-1 items-center gap-2 px-2.5 py-2">
        {data.kind === "appliance" && data.deviceKind ? (
          <DeviceKindIcon kind={data.deviceKind} size={14} />
        ) : Icon ? (
          <Icon size={14} className="shrink-0 text-text-muted" />
        ) : null}
        <div className="flex min-w-0 flex-col">
          <span className="truncate font-mono-nums text-xs text-text">{data.label}</span>
          {data.kind === "appliance" && (
            <span className="truncate font-mono-nums text-[11px] text-text-muted">{data.status === "offline" ? "offline" : formatWatts(data.watts)}</span>
          )}
          {data.kind === "node" && data.health && (data.health.fw || data.health.uptimeLabel) && (
            <span data-testid="topology-node-health" className="flex flex-col truncate font-mono-nums text-[10px] text-text-muted">
              {data.health.fw && <span className="truncate">{data.health.fw}</span>}
              {data.health.uptimeLabel && <span className="truncate">up {data.health.uptimeLabel}</span>}
            </span>
          )}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} style={{ visibility: "hidden" }} />
    </div>
  );
}
