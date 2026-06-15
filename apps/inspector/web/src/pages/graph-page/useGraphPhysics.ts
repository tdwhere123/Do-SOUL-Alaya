import { useCallback, useEffect, useRef } from "react";
import type { ForceGraphMethods as ForceGraphMethods2D } from "react-force-graph-2d";
import type { ForceGraphMethods as ForceGraphMethods3D } from "react-force-graph-3d";
import type { GraphLink, GraphNode } from "../../types/graph";
import { linkDistance, linkStrength } from "../../utils/graph";
import type { GraphData, ViewMode } from "./types";

type ForceGraphWithForces = {
  d3Force?: (name: string) => unknown;
  d3ReheatSimulation?: () => unknown;
};

type TunedForceKey = "twoD" | "threeD";

interface UseGraphPhysicsOptions {
  readonly data: GraphData | null;
  readonly effectiveMode: ViewMode;
  readonly fg2dRef: React.MutableRefObject<
    ForceGraphMethods2D<GraphNode, GraphLink> | undefined
  >;
  readonly fg3dRef: React.MutableRefObject<
    ForceGraphMethods3D<GraphNode, GraphLink> | undefined
  >;
  readonly focusedMatchId: string | undefined;
  readonly viewMode: ViewMode;
}

export function useGraphPhysics({
  data,
  effectiveMode,
  fg2dRef,
  fg3dRef,
  focusedMatchId,
  viewMode
}: UseGraphPhysicsOptions) {
  const nodePositionsRef = useRef<Map<string, { x?: number; y?: number; z?: number }>>(new Map());
  const tunedForceRefs = useRef<Record<TunedForceKey, ForceGraphWithForces | null>>({
    twoD: null,
    threeD: null
  });

  const tuneGraphForces = useCallback(
    (instance: ForceGraphWithForces | undefined, reheat = false) => {
      if (!instance?.d3Force) return;
      const linkForce = instance.d3Force("link") as
        | {
            distance: (fn: (link: GraphLink) => number) => unknown;
            strength: (fn: (link: GraphLink) => number) => unknown;
          }
        | undefined;
      if (!linkForce) return;
      linkForce.distance((link: GraphLink) => linkDistance(link.strength_normalized, link.weight));
      linkForce.strength(
        (link: GraphLink) => 0.1 + 0.9 * linkStrength(link.strength_normalized, link.weight)
      );
      if (reheat) instance.d3ReheatSimulation?.();
    },
    []
  );

  useEffect(() => {
    if (!data) return;
    tunedForceRefs.current = { twoD: null, threeD: null };
    tuneGraphForces(fg2dRef.current, true);
    tuneGraphForces(fg3dRef.current, true);
  }, [data, fg2dRef, fg3dRef, tuneGraphForces, viewMode]);

  const handleGraphEngineTick = useCallback(
    (mode: ViewMode) => {
      const key: TunedForceKey = mode === "2d" ? "twoD" : "threeD";
      const instance = mode === "2d" ? fg2dRef.current : fg3dRef.current;
      if (!instance || tunedForceRefs.current[key] === instance) return;
      tuneGraphForces(instance, true);
      tunedForceRefs.current[key] = instance;
    },
    [fg2dRef, fg3dRef, tuneGraphForces]
  );

  useEffect(() => {
    return () => {
      if (!data) return;
      for (const node of data.nodes) {
        if (node.x !== undefined || node.y !== undefined || node.z !== undefined) {
          nodePositionsRef.current.set(node.id, { x: node.x, y: node.y, z: node.z });
        }
      }
    };
  }, [data, viewMode]);

  useEffect(() => {
    if (!data) return;
    const cache = nodePositionsRef.current;
    if (cache.size === 0) return;
    for (const node of data.nodes) {
      const cached = cache.get(node.id);
      if (!cached) continue;
      if (cached.x !== undefined) node.x = cached.x;
      if (cached.y !== undefined) node.y = cached.y;
      if (cached.z !== undefined) node.z = cached.z;
    }
  }, [data, viewMode]);

  useEffect(() => {
    if (!focusedMatchId || !data) return;
    const node = data.nodes.find((candidate) => candidate.id === focusedMatchId);
    if (!node || node.x === undefined || node.y === undefined) return;

    if (effectiveMode === "2d" && fg2dRef.current?.centerAt) {
      fg2dRef.current.centerAt(node.x, node.y, 600);
      fg2dRef.current.zoom?.(2, 600);
      return;
    }

    if (effectiveMode === "3d" && fg3dRef.current?.cameraPosition) {
      const distance = 220;
      const norm = Math.hypot(node.x ?? 0, node.y ?? 0, node.z ?? 0) || 1;
      fg3dRef.current.cameraPosition(
        {
          x: ((node.x ?? 0) / norm) * distance,
          y: ((node.y ?? 0) / norm) * distance,
          z: ((node.z ?? 0) / norm) * distance
        },
        node as { x: number; y: number; z: number },
        800
      );
    }
  }, [data, effectiveMode, fg2dRef, fg3dRef, focusedMatchId]);

  return { handleGraphEngineTick };
}
