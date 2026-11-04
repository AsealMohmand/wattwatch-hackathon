import type { TopologyNode, TopologyNodeKind } from "../api/client";

const DEPTH: Record<TopologyNodeKind, number> = { hub: 0, node: 1, port: 2, appliance: 3 };
export const LEAF_GAP = 220;
export const LEVEL_GAP = 140;

/** Top-down tree layout: hub at top, children spread evenly per level.
 * Parents are centered over the mean x of their children (post-order). */
export function computeTreeLayout(nodes: TopologyNode[]): Record<string, { x: number; y: number }> {
  const childrenOf = new Map<string, string[]>();
  for (const n of nodes) {
    if (n.parent) childrenOf.set(n.parent, [...(childrenOf.get(n.parent) ?? []), n.id]);
  }
  let leafCounter = 0;
  const xOf = new Map<string, number>();

  function visit(id: string): number {
    if (xOf.has(id)) return xOf.get(id) as number;
    const kids = childrenOf.get(id) ?? [];
    let x: number;
    if (kids.length === 0) {
      x = leafCounter * LEAF_GAP;
      leafCounter += 1;
    } else {
      const childXs = kids.map(visit);
      x = childXs.reduce((a, b) => a + b, 0) / childXs.length;
    }
    xOf.set(id, x);
    return x;
  }

  const root = nodes.find((n) => n.kind === "hub");
  if (root) visit(root.id);
  for (const n of nodes) {
    if (!xOf.has(n.id)) visit(n.id);
  }

  const result: Record<string, { x: number; y: number }> = {};
  for (const n of nodes) {
    result[n.id] = { x: xOf.get(n.id) ?? 0, y: DEPTH[n.kind] * LEVEL_GAP };
  }
  return result;
}
