import { useCallback, useEffect, useRef } from "react";
import type { ForceGraphMethods as ForceGraphMethods2D } from "react-force-graph-2d";
import type { ForceGraphMethods as ForceGraphMethods3D } from "react-force-graph-3d";
import type { GraphLink, GraphNode } from "../../types/graph";
import type { GraphData, ViewMode } from "./types";
import {
  cacheNodePositions,
  cameraPositionForNode,
  findFocusedNode,
  modeForceKey,
  restoreNodePositions,
  tuneGraphForceInstance,
  type ForceGraphWithForces,
  type TunedForceKey
} from "./graph-physics-support";

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
  useResetGraphForces(data, fg2dRef, fg3dRef, tunedForceRefs, viewMode);
  usePersistGraphPositions(data, nodePositionsRef, viewMode);
  useRestoreGraphPositions(data, nodePositionsRef, viewMode);
  useFocusGraphNode(data, effectiveMode, fg2dRef, fg3dRef, focusedMatchId);

  const handleGraphEngineTick = useCallback(
    (mode: ViewMode) => tuneUntunedForce(mode, fg2dRef.current, fg3dRef.current, tunedForceRefs.current),
    [fg2dRef, fg3dRef]
  );

  return { handleGraphEngineTick };
}

function useResetGraphForces(
  data: GraphData | null,
  fg2dRef: React.MutableRefObject<ForceGraphMethods2D<GraphNode, GraphLink> | undefined>,
  fg3dRef: React.MutableRefObject<ForceGraphMethods3D<GraphNode, GraphLink> | undefined>,
  tunedForceRefs: React.MutableRefObject<Record<TunedForceKey, ForceGraphWithForces | null>>,
  viewMode: ViewMode
) {
  useEffect(() => {
    if (!data) return;
    tunedForceRefs.current = { twoD: null, threeD: null };
    tuneGraphForceInstance(fg2dRef.current, true);
    tuneGraphForceInstance(fg3dRef.current, true);
  }, [data, fg2dRef, fg3dRef, tunedForceRefs, viewMode]);
}

function usePersistGraphPositions(
  data: GraphData | null,
  nodePositionsRef: React.MutableRefObject<Map<string, { x?: number; y?: number; z?: number }>>,
  viewMode: ViewMode
) {
  useEffect(() => {
    return () => {
      if (!data) return;
      cacheNodePositions(data.nodes, nodePositionsRef.current);
    };
  }, [data, viewMode]);
}

function useRestoreGraphPositions(
  data: GraphData | null,
  nodePositionsRef: React.MutableRefObject<Map<string, { x?: number; y?: number; z?: number }>>,
  viewMode: ViewMode
) {
  useEffect(() => {
    if (!data) return;
    restoreNodePositions(data.nodes, nodePositionsRef.current);
  }, [data, viewMode]);
}

function useFocusGraphNode(
  data: GraphData | null,
  effectiveMode: ViewMode,
  fg2dRef: React.MutableRefObject<ForceGraphMethods2D<GraphNode, GraphLink> | undefined>,
  fg3dRef: React.MutableRefObject<ForceGraphMethods3D<GraphNode, GraphLink> | undefined>,
  focusedMatchId: string | undefined
) {
  useEffect(() => {
    if (!data) return;
    const node = findFocusedNode(data.nodes, focusedMatchId);
    if (!node) return;

    if (effectiveMode === "2d" && fg2dRef.current?.centerAt) {
      fg2dRef.current.centerAt(node.x, node.y, 600);
      fg2dRef.current.zoom?.(2, 600);
      return;
    }

    if (effectiveMode === "3d" && fg3dRef.current?.cameraPosition) {
      const { camera, lookAt } = cameraPositionForNode(node);
      fg3dRef.current.cameraPosition(camera, lookAt, 800);
    }
  }, [data, effectiveMode, fg2dRef, fg3dRef, focusedMatchId]);
}

function tuneUntunedForce(
  mode: ViewMode,
  twoD: ForceGraphWithForces | undefined,
  threeD: ForceGraphWithForces | undefined,
  tuned: Record<TunedForceKey, ForceGraphWithForces | null>
) {
  const key = modeForceKey(mode);
  const instance = mode === "2d" ? twoD : threeD;
  if (!instance || tuned[key] === instance) return;
  tuneGraphForceInstance(instance, true);
  tuned[key] = instance;
}
