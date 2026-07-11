import { useCallback, useRef, useState } from "react";
import type { ForceGraphMethods as ForceGraphMethods2D } from "react-force-graph-2d";
import type { ForceGraphMethods as ForceGraphMethods3D } from "react-force-graph-3d";
import DetailDrawer from "../../components/detail-drawer";
import { useToasts } from "../../components/toast";
import { useFpsMonitor } from "../../hooks/useFpsMonitor";
import { useGraphSpotlight } from "../../hooks/useGraphSpotlight";
import type { GraphLink, GraphNode } from "../../types/graph";
import GraphOverlays from "./graph-overlays";
import GraphRenderer from "./graph-renderer";
import GraphToolbar from "./graph-toolbar";
import { probeWebgl } from "./support";
import type { GraphData, ViewMode } from "./types";
import { useGraphActions } from "./useGraphActions";
import { useGraphData } from "./useGraphData";
import { useGraphKeyboardShortcuts, type GraphKeyboardState } from "./useGraphKeyboardShortcuts";
import { useGraphPhysics } from "./useGraphPhysics";
import { useViewportSize } from "./useViewportSize";

const LARGE_GRAPH_NODE_THRESHOLD = 500;

export default function GraphWorkspace({ workspaceId }: { readonly workspaceId: string }) {
  const { showToast } = useToasts();
  const refs = useGraphRefs();
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("2d");
  const [webglSupported] = useState(() => probeWebgl());
  const viewport = useViewportSize(refs.viewportRef);
  const { data, error, loading } = useGraphData(workspaceId);
  const spotlight = useGraphSpotlight({ data, workspaceId });
  const effectiveMode: ViewMode = webglSupported ? viewMode : "2d";
  const largeGraphMode = effectiveMode === "3d" && (data?.nodes.length ?? 0) > LARGE_GRAPH_NODE_THRESHOLD;
  const lowFpsDetected = useFpsMonitor({ enabled: largeGraphMode });
  const { handleGraphEngineTick } = useGraphPhysics({
    data,
    effectiveMode, fg2dRef: refs.fg2dRef, fg3dRef: refs.fg3dRef, focusedMatchId: spotlight.focusedMatchId, viewMode
  });
  const actions = useGraphActions({ showToast, workspaceId });
  const handleNodeClick = useNodeSelection(setSelectedNode, spotlight.setSearchTerm);
  refs.keyboardStateRef.current = keyboardState(spotlight, selectedNode);
  useGraphKeyboardShortcuts({
    keyboardStateRef: refs.keyboardStateRef,
    searchInputRef: refs.searchInputRef,
    setMatchCursor: spotlight.setMatchCursor,
    setSearchTerm: spotlight.setSearchTerm,
    setSelectedNode
  });

  return (
    <GraphWorkspaceView
      actions={actions}
      dataState={{ data, error, loading }}
      graphState={{
        effectiveMode,
        largeGraphMode,
        lowFpsDetected,
        selectedNode,
        setViewMode,
        webglSupported
      }}
      refs={refs}
      physics={{ handleGraphEngineTick }}
      selection={{ handleNodeClick, setSelectedNode }}
      spotlight={spotlight}
      viewport={viewport}
    />
  );
}

function useGraphRefs() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const fg2dRef = useRef<ForceGraphMethods2D<GraphNode, GraphLink> | undefined>(undefined);
  const fg3dRef = useRef<ForceGraphMethods3D<GraphNode, GraphLink> | undefined>(undefined);
  const keyboardStateRef = useRef<GraphKeyboardState>({
    matchCount: 0,
    searchTerm: "",
    selectedNode: null,
    spotlightActive: false
  });
  return { fg2dRef, fg3dRef, keyboardStateRef, searchInputRef, viewportRef };
}

function GraphWorkspaceView(props: {
  readonly actions: ReturnType<typeof useGraphActions>;
  readonly dataState: { readonly data: GraphData | null; readonly error: string | null; readonly loading: boolean };
  readonly graphState: {
    readonly effectiveMode: ViewMode;
    readonly largeGraphMode: boolean;
    readonly lowFpsDetected: boolean;
    readonly selectedNode: GraphNode | null;
    readonly setViewMode: (mode: ViewMode) => void;
    readonly webglSupported: boolean;
  };
  readonly refs: ReturnType<typeof useGraphRefs>;
  readonly physics: { readonly handleGraphEngineTick: (mode: ViewMode) => void };
  readonly selection: {
    readonly handleNodeClick: (node: GraphNode, event?: MouseEvent) => void;
    readonly setSelectedNode: (node: GraphNode | null) => void;
  };
  readonly spotlight: ReturnType<typeof useGraphSpotlight>;
  readonly viewport: { readonly width: number; readonly height: number };
}) {
  return (
    <div ref={props.refs.viewportRef} data-graph-viewport="true" className="relative flex-1 overflow-hidden bg-beige-100">
      <GraphChrome {...props} />
      <DetailDrawer
        node={props.graphState.selectedNode}
        onClose={() => props.selection.setSelectedNode(null)}
        onFocusSubgraph={(id) => props.spotlight.setSearchTerm(id)}
        onCopyCli={props.actions.copyToClipboard}
        onCreateProposal={props.actions.createMemoryProposal}
      />
    </div>
  );
}

function GraphChrome(props: Parameters<typeof GraphWorkspaceView>[0]) {
  return (
    <>
      <GraphToolbar
        effectiveMode={props.graphState.effectiveMode}
        matchCount={props.spotlight.matchCount}
        matchCursor={props.spotlight.matchCursor}
        onModeChange={props.graphState.setViewMode}
        searchInputRef={props.refs.searchInputRef}
        searchTerm={props.spotlight.searchTerm}
        setSearchTerm={props.spotlight.setSearchTerm}
        spotlightActive={props.spotlight.spotlightActive}
        webglSupported={props.graphState.webglSupported}
      />
      <GraphLayers {...props} />
    </>
  );
}

function GraphLayers(props: Parameters<typeof GraphWorkspaceView>[0]) {
  return (
    <>
      <GraphOverlays
        data={props.dataState.data}
        effectiveMode={props.graphState.effectiveMode}
        error={props.dataState.error}
        largeGraphMode={props.graphState.largeGraphMode}
        loading={props.dataState.loading}
        lowFpsDetected={props.graphState.lowFpsDetected}
        searchError={props.spotlight.searchError}
        searchTimeHits={props.spotlight.searchTimeHits}
        webglSupported={props.graphState.webglSupported}
      />
      {props.dataState.data ? <GraphCanvas {...props} data={props.dataState.data} /> : null}
    </>
  );
}

function GraphCanvas(props: Parameters<typeof GraphWorkspaceView>[0] & { readonly data: NonNullable<ReturnType<typeof useGraphData>["data"]> }) {
  return (
    <GraphRenderer
      data={props.data}
      effectiveMode={props.graphState.effectiveMode}
      fg2dRef={props.refs.fg2dRef}
      fg3dRef={props.refs.fg3dRef}
      largeGraphMode={props.graphState.largeGraphMode}
      matchIds={props.spotlight.matchIds}
      nodeSpotlightState={props.spotlight.nodeSpotlightState}
      onBackgroundClick={() => props.selection.setSelectedNode(null)}
      onEngineTick={props.physics.handleGraphEngineTick}
      onNodeClick={props.selection.handleNodeClick}
      selectedNode={props.graphState.selectedNode}
      spotlightActive={props.spotlight.spotlightActive}
      viewport={props.viewport}
    />
  );
}

function useNodeSelection(
  setSelectedNode: (node: GraphNode | null) => void,
  setSearchTerm: React.Dispatch<React.SetStateAction<string>>
) {
  return useCallback((node: GraphNode, event?: MouseEvent) => {
    setSelectedNode(node);
    if ((event?.detail ?? 1) >= 2) setSearchTerm(node.id);
  }, [setSearchTerm, setSelectedNode]);
}

function keyboardState(
  spotlight: ReturnType<typeof useGraphSpotlight>,
  selectedNode: GraphNode | null
): GraphKeyboardState {
  return {
    matchCount: spotlight.matchCount,
    searchTerm: spotlight.searchTerm,
    selectedNode,
    spotlightActive: spotlight.spotlightActive
  };
}
