import {
  Background,
  BackgroundVariant,
  ReactFlow,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeMouseHandler,
  type OnNodeDrag,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { ListTree, RotateCcw } from "lucide-react";
import { useCallback, useEffect, useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { encodeDeviceId } from "../api/client";
import { useDevices, useNodes, usePatchTopologyNode, useTopology } from "../api/hooks";
import { EmptyState } from "../components/EmptyState";
import { Skeleton } from "../components/Skeleton";
import { type PanelNodeData, PanelNodeView } from "../components/TopologyNodeView";
import { formatDuration } from "../lib/format";
import { computeTreeLayout } from "../lib/topologyLayout";

/** F1-8: dash-animation duration (seconds) for an edge drawing `watts` —
 * faster dash for more power, floored/ceilinged so it stays legible. */
function flowDurationS(watts: number): number {
  return Math.max(0.3, Math.min(2.5, 60 / Math.max(watts, 1)));
}

const nodeTypes = { panel: PanelNodeView };

export function Topology() {
  const topology = useTopology();
  const devices = useDevices();
  const hubNodes = useNodes();
  const patchNode = usePatchTopologyNode();
  const navigate = useNavigate();
  const deviceKindById = useMemo(() => new Map((devices.data ?? []).map((d) => [d.device_id, d.kind])), [devices.data]);
  const nodeHealthById = useMemo(
    () =>
      new Map(
        (hubNodes.data ?? []).map((n) => [
          n.node_id,
          { fw: n.fw, uptimeLabel: n.uptime_ms != null ? formatDuration(n.uptime_ms / 1000) : null },
        ]),
      ),
    [hubNodes.data],
  );

  const [nodes, setNodes, onNodesChange] = useNodesState<Node<PanelNodeData>>([]);
  const [edges, setEdges] = useEdgesState<Edge>([]);

  const apiNodes = topology.data?.nodes;

  const autoLayout = useMemo(() => computeTreeLayout(apiNodes ?? []), [apiNodes]);

  useEffect(() => {
    if (!apiNodes) return;
    const byId = new Map(apiNodes.map((n) => [n.id, n]));
    const nextNodes: Node<PanelNodeData>[] = apiNodes.map((n) => {
      const pos = n.x != null && n.y != null ? { x: n.x, y: n.y } : autoLayout[n.id];
      return {
        id: n.id,
        type: "panel",
        position: pos,
        draggable: true,
        data: {
          label: n.label,
          kind: n.kind,
          status: n.status,
          watts: n.watts,
          deviceKind: n.device_id ? deviceKindById.get(n.device_id) : undefined,
          clickable: n.kind === "appliance" && !!n.device_id,
          health: n.kind === "node" ? nodeHealthById.get(n.id.replace(/^node:/, "")) : undefined,
        },
      };
    });
    const nextEdges: Edge[] = apiNodes
      .filter((n) => n.parent)
      .map((n) => {
        const child = byId.get(n.id);
        const watts = child?.watts ?? 0;
        const drawing = child?.watts == null ? child?.status === "online" : child.status === "online" && child.watts > 20;
        // F1-8: the dash travels along the edge at a speed proportional to
        // watts (faster for more power) instead of xyflow's fixed-speed
        // `animated` flag, via a custom keyframe (index.css `ww-flow`) so
        // the duration can vary per edge.
        return {
          id: `${n.parent}-${n.id}`,
          source: n.parent as string,
          target: n.id,
          type: "step",
          style: {
            stroke: drawing ? "var(--color-trace)" : "var(--color-border)",
            strokeWidth: drawing ? 2 : 1,
            strokeDasharray: drawing ? 6 : undefined,
            animation: drawing ? `ww-flow ${flowDurationS(watts).toFixed(2)}s linear infinite` : undefined,
          },
        };
      });
    setNodes(nextNodes);
    setEdges(nextEdges);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiNodes, autoLayout, deviceKindById, nodeHealthById]);

  const onNodeDragStop: OnNodeDrag<Node<PanelNodeData>> = useCallback(
    (_event, node) => {
      patchNode.mutate({ nodeId: node.id, patch: { x: node.position.x, y: node.position.y } });
    },
    [patchNode],
  );

  const onNodeClick: NodeMouseHandler<Node<PanelNodeData>> = useCallback(
    (_event, node) => {
      const apiNode = apiNodes?.find((n) => n.id === node.id);
      if (apiNode?.device_id) navigate(`/devices/${encodeDeviceId(apiNode.device_id)}`);
    },
    [apiNodes, navigate],
  );

  function resetLayout() {
    if (!apiNodes) return;
    const fresh = computeTreeLayout(apiNodes);
    setNodes((prev) => prev.map((n) => ({ ...n, position: fresh[n.id] ?? n.position })));
    for (const n of apiNodes) {
      const p = fresh[n.id];
      if (p) patchNode.mutate({ nodeId: n.id, patch: { x: p.x, y: p.y } });
    }
  }

  if (topology.isLoading) return <Skeleton className="h-[560px] w-full" />;
  if (!apiNodes || apiNodes.length === 0) {
    return <EmptyState icon={ListTree} title="No topology yet." detail="The hub, nodes and ports appear here once a device reports a reading." />;
  }

  return (
    <div className="flex flex-col gap-3">
      <div className="flex items-center justify-between">
        <Legend />
        <button
          type="button"
          data-testid="topology-reset"
          onClick={resetLayout}
          className="flex items-center gap-1.5 rounded-md border border-border px-2.5 py-1.5 text-xs text-text-muted transition-colors hover:text-text hover:bg-surface-raised"
        >
          <RotateCcw size={13} />
          Reset layout
        </button>
      </div>
      <div data-testid="topology-canvas" className="h-[560px] w-full overflow-hidden rounded-md border border-border bg-surface">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={() => {}}
          onNodeDragStop={onNodeDragStop}
          onNodeClick={onNodeClick}
          nodeTypes={nodeTypes}
          fitView
          proOptions={{ hideAttribution: true }}
          minZoom={0.3}
        >
          <Background variant={BackgroundVariant.Dots} gap={20} size={1} color="var(--color-border)" />
        </ReactFlow>
      </div>
    </div>
  );
}

function Legend() {
  return (
    <div data-testid="topology-legend" className="flex flex-wrap items-center gap-3 text-xs text-text-muted">
      <LegendItem color="bg-trace" label="Online" />
      <LegendItem color="bg-critical" label="Offline" />
      <LegendItem color="bg-text-muted" label="Unknown" />
      <span className="flex items-center gap-1.5">
        <span className="h-0.5 w-5 bg-trace" aria-hidden />
        Drawing &gt; 20 W
      </span>
    </div>
  );
}

function LegendItem({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className={`h-2 w-2 rounded-full ${color}`} aria-hidden />
      {label}
    </span>
  );
}
