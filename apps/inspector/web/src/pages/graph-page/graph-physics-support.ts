import { linkDistance, linkStrength } from "../../utils/graph";
import type { GraphLink, GraphNode } from "../../types/graph";
import type { ViewMode } from "./types";

export type ForceGraphWithForces = {
  d3Force?: (name: string) => unknown;
  d3ReheatSimulation?: () => unknown;
};

export type TunedForceKey = "twoD" | "threeD";
export type NodePositionCache = Map<string, { x?: number; y?: number; z?: number }>;

type LinkForce = {
  distance: (fn: (link: GraphLink) => number) => unknown;
  strength: (fn: (link: GraphLink) => number) => unknown;
};

export function tuneGraphForceInstance(instance: ForceGraphWithForces | undefined, reheat = false) {
  if (!instance?.d3Force) return;
  const linkForce = instance.d3Force("link") as LinkForce | undefined;
  if (!linkForce) return;
  linkForce.distance((link) => linkDistance(link.strength_normalized, link.weight));
  linkForce.strength((link) => 0.1 + 0.9 * linkStrength(link.strength_normalized, link.weight));
  if (reheat) instance.d3ReheatSimulation?.();
}

export function modeForceKey(mode: ViewMode): TunedForceKey {
  return mode === "2d" ? "twoD" : "threeD";
}

export function cacheNodePositions(nodes: readonly GraphNode[], cache: NodePositionCache) {
  for (const node of nodes) {
    if (node.x !== undefined || node.y !== undefined || node.z !== undefined) {
      cache.set(node.id, { x: node.x, y: node.y, z: node.z });
    }
  }
}

export function restoreNodePositions(nodes: readonly GraphNode[], cache: NodePositionCache) {
  if (cache.size === 0) return;
  for (const node of nodes) {
    const cached = cache.get(node.id);
    if (!cached) continue;
    if (cached.x !== undefined) node.x = cached.x;
    if (cached.y !== undefined) node.y = cached.y;
    if (cached.z !== undefined) node.z = cached.z;
  }
}

export function findFocusedNode(
  nodes: readonly GraphNode[],
  focusedMatchId: string | undefined
): GraphNode | null {
  if (!focusedMatchId) return null;
  const node = nodes.find((candidate) => candidate.id === focusedMatchId);
  return node && node.x !== undefined && node.y !== undefined ? node : null;
}

export function cameraPositionForNode(node: GraphNode): {
  readonly camera: { readonly x: number; readonly y: number; readonly z: number };
  readonly lookAt: { readonly x: number; readonly y: number; readonly z: number };
} {
  const distance = 220;
  const norm = Math.hypot(node.x ?? 0, node.y ?? 0, node.z ?? 0) || 1;
  return {
    camera: {
      x: ((node.x ?? 0) / norm) * distance,
      y: ((node.y ?? 0) / norm) * distance,
      z: ((node.z ?? 0) / norm) * distance
    },
    lookAt: node as { x: number; y: number; z: number }
  };
}
