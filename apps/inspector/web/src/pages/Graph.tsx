import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { ForceGraphMethods as ForceGraphMethods2D } from "react-force-graph-2d";
import type { ForceGraphMethods as ForceGraphMethods3D } from "react-force-graph-3d";
import { apiFetch, getWorkspaceId, type ApiError } from "../api";
import DetailDrawer from "../components/DetailDrawer";
import NoWorkspaceAlert from "../components/NoWorkspaceAlert";
import { useToasts } from "../components/Toast";
import { useFpsMonitor } from "../hooks/useFpsMonitor";
import { useGraphSpotlight } from "../hooks/useGraphSpotlight";
import { useI18n } from "../i18n/Locale";
import type { GraphLink, GraphNode } from "../types/graph";
import { linkDistance, linkStrength } from "../utils/graph";
import GraphOverlays from "./graph-page/GraphOverlays";
import GraphRenderer from "./graph-page/GraphRenderer";
import GraphToolbar from "./graph-page/GraphToolbar";
import { probeWebgl } from "./graph-page/support";
import type { ViewMode } from "./graph-page/types";
import { useGraphData } from "./graph-page/useGraphData";
import { useGraphPhysics } from "./graph-page/useGraphPhysics";
import { useViewportSize } from "./graph-page/useViewportSize";

interface ProposalCreateEnvelope {
  readonly success: boolean;
  readonly data: {
    readonly proposal_id: string;
    readonly status: "created" | "already_pending";
  };
}

const LARGE_GRAPH_NODE_THRESHOLD = 500;

/**
 * GraphPage visualizes the live path graph in 2D or 3D, keeps search
 * spotlighting responsive for large workspaces, and preserves the existing
 * proposal and drawer workflows.
 */
export default function GraphPage() {
  const { t } = useI18n();
  const navigate = useNavigate();
  const { showToast } = useToasts();
  const workspaceId = getWorkspaceId();
  const viewportRef = useRef<HTMLDivElement>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const fg2dRef = useRef<ForceGraphMethods2D<GraphNode, GraphLink> | undefined>(undefined);
  const fg3dRef = useRef<ForceGraphMethods3D<GraphNode, GraphLink> | undefined>(undefined);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [viewMode, setViewMode] = useState<ViewMode>("2d");
  const [webglSupported] = useState(() => probeWebgl());
  const [now, setNow] = useState(() => Date.now());

  const viewport = useViewportSize(viewportRef);
  const { data, error, loading } = useGraphData(workspaceId);
  const {
    focusedMatchId,
    matchCount,
    matchCursor,
    matchIds,
    nodeSpotlightState,
    searchError,
    searchTerm,
    searchTimeHits,
    setMatchCursor,
    setSearchTerm,
    spotlightActive
  } = useGraphSpotlight({ data, workspaceId });

  const effectiveMode: ViewMode = webglSupported ? viewMode : "2d";
  const largeGraphMode =
    effectiveMode === "3d" && (data?.nodes.length ?? 0) > LARGE_GRAPH_NODE_THRESHOLD;
  const lowFpsDetected = useFpsMonitor({ enabled: largeGraphMode });
  const { handleGraphEngineTick } = useGraphPhysics({
    data,
    effectiveMode,
    fg2dRef,
    fg3dRef,
    focusedMatchId,
    viewMode
  });

  useEffect(() => {
    const timerId = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timerId);
  }, []);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const isTyping =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;

      if (
        (event.key === "/" && !isTyping) ||
        (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey))
      ) {
        event.preventDefault();
        searchInputRef.current?.focus();
        return;
      }

      if (event.key === "Escape") {
        if (selectedNode) {
          setSelectedNode(null);
        } else if (searchTerm) {
          setSearchTerm("");
        }
        return;
      }

      if (
        event.key === "ArrowDown" &&
        spotlightActive &&
        matchCount > 0 &&
        isTyping &&
        target === searchInputRef.current
      ) {
        event.preventDefault();
        setMatchCursor((cursor) => (cursor + 1) % matchCount);
      }

      if (
        event.key === "ArrowUp" &&
        spotlightActive &&
        matchCount > 0 &&
        isTyping &&
        target === searchInputRef.current
      ) {
        event.preventDefault();
        setMatchCursor((cursor) => (cursor - 1 + matchCount) % matchCount);
      }
    };

    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [matchCount, searchTerm, selectedNode, setMatchCursor, setSearchTerm, spotlightActive]);

  const copyToClipboard = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text);
      showToast({ message: t("common:copied"), type: "success", duration: 2500 });
    },
    [showToast, t]
  );

  const createMemoryProposal = useCallback(
    async (
      action: "keep" | "rewrite" | "downgrade" | "retire",
      nodeId: string,
      newContent?: string
    ) => {
      if (workspaceId === null) {
        showToast({ type: "error", message: t("drawer:action.noWorkspace") });
        return;
      }

      try {
        const envelope = await apiFetch<ProposalCreateEnvelope>(
          `/proposals/${workspaceId}/memory/${nodeId}/${action}`,
          {
            method: "POST",
            body: action === "rewrite" ? { new_content: newContent ?? "" } : undefined
          }
        );
        const proposalId = envelope.data.proposal_id;
        const alreadyPending = envelope.data.status === "already_pending";
        showToast({
          type: "success",
          message: alreadyPending
            ? t("drawer:action.proposalAlreadyPending")
            : t("drawer:action.proposalCreated"),
          action: {
            label: t("drawer:action.proposalReviewLink"),
            onClick: () => navigate(`/proposals?highlight=${encodeURIComponent(proposalId)}`)
          }
        });
        navigate(`/proposals?highlight=${encodeURIComponent(proposalId)}`);
      } catch (err) {
        if ((err as ApiError).status === 401) return;
        showToast({
          type: "error",
          message: err instanceof Error ? err.message : t("drawer:action.proposalFailed")
        });
      }
    },
    [navigate, showToast, t, workspaceId]
  );

  const handleNodeClick = useCallback((node: GraphNode, event?: MouseEvent) => {
    setSelectedNode(node);
    if ((event?.detail ?? 1) >= 2) {
      setSearchTerm(node.id);
    }
  }, [setSearchTerm]);

  if (workspaceId === null) {
    return <NoWorkspaceAlert testId="graph-no-workspace" />;
  }

  return (
    <div
      ref={viewportRef}
      data-graph-viewport="true"
      className="relative flex-1 overflow-hidden bg-beige-100"
    >
      <GraphToolbar
        effectiveMode={effectiveMode}
        matchCount={matchCount}
        matchCursor={matchCursor}
        onModeChange={setViewMode}
        searchInputRef={searchInputRef}
        searchTerm={searchTerm}
        setSearchTerm={setSearchTerm}
        spotlightActive={spotlightActive}
        webglSupported={webglSupported}
      />

      <GraphOverlays
        data={data}
        effectiveMode={effectiveMode}
        error={error}
        largeGraphMode={largeGraphMode}
        loading={loading}
        lowFpsDetected={lowFpsDetected}
        searchError={searchError}
        searchTimeHits={searchTimeHits}
        webglSupported={webglSupported}
      />

      {data ? (
        <GraphRenderer
          data={data}
          effectiveMode={effectiveMode}
          fg2dRef={fg2dRef}
          fg3dRef={fg3dRef}
          largeGraphMode={largeGraphMode}
          matchIds={matchIds}
          nodeSpotlightState={nodeSpotlightState}
          now={now}
          onBackgroundClick={() => setSelectedNode(null)}
          onEngineTick={handleGraphEngineTick}
          onNodeClick={handleNodeClick}
          selectedNode={selectedNode}
          spotlightActive={spotlightActive}
          viewport={viewport}
        />
      ) : null}

      <DetailDrawer
        node={selectedNode}
        onClose={() => setSelectedNode(null)}
        onFocusSubgraph={(id) => setSearchTerm(id)}
        onCopyCli={copyToClipboard}
        onCreateProposal={createMemoryProposal}
      />
    </div>
  );
}
