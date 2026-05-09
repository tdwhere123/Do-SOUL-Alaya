import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useNavigate } from "react-router-dom";
import { Search, X, Box, Square } from "lucide-react";
import ForceGraph2D from "react-force-graph-2d";
import ForceGraph3D from "react-force-graph-3d";
import type { ForceGraphMethods as ForceGraphMethods2D } from "react-force-graph-2d";
import type { ForceGraphMethods as ForceGraphMethods3D } from "react-force-graph-3d";
import { apiFetch, getWorkspaceId, type ApiError } from "../api";
import { useToasts } from "../components/Toast";
import { DetailDrawer } from "../components/DetailDrawer";
import type { GraphNode, GraphLink, SpotlightState } from "../types/graph";
import {
  EDGE_TYPE_BASE_COLOR,
  ORIGIN_KIND_COLOR,
  STABILITY_DASH,
  isRecentlyReinforced,
  linkAlpha,
  linkDistance,
  linkWidth,
  nodeInfluenceSize,
  recencyAlpha,
  rgba
} from "../utils/graph";
import type { SoulGraph } from "@do-soul/alaya-protocol";

interface SoulGraphEnvelope {
  readonly success: boolean;
  readonly data: SoulGraph;
}

interface ProposalCreateEnvelope {
  readonly success: boolean;
  readonly data: {
    readonly proposal_id: string;
    readonly status: "created" | "already_pending";
  };
}

interface GraphData {
  readonly nodes: GraphNode[];
  readonly links: GraphLink[];
  readonly meta: {
    readonly truncated: boolean;
    readonly nodeTotal: number;
    readonly edgeTotal: number;
  };
}

type ViewMode = "2d" | "3d";

const DEFAULT_NODE_FALLBACK_COLOR = "#586E75";
const SPOTLIGHT_BG_ALPHA = 0.12;
const SPOTLIGHT_ADJ_ALPHA = 0.55;
const REINFORCED_GLOW_ALPHA = 0.95;

export default function GraphPage() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const fg2dRef = useRef<ForceGraphMethods2D<GraphNode, GraphLink> | undefined>(undefined);
  const fg3dRef = useRef<ForceGraphMethods3D<GraphNode, GraphLink> | undefined>(undefined);
  const [data, setData] = useState<GraphData | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [matchCursor, setMatchCursor] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("2d");
  const [webglSupported, setWebglSupported] = useState<boolean>(true);
  const [viewport, setViewport] = useState<{ width: number; height: number }>(() => ({
    width: 800,
    height: 600
  }));
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const { showToast } = useToasts();
  const navigate = useNavigate();

  const workspaceId = getWorkspaceId();
  const now = useMemo(() => Date.now(), [data]);

  // WebGL availability probe — ForceGraph3D needs a working WebGL context.
  // WSL2/headless environments often expose WebGL but throw on draw, so we
  // also test a minimal createProgram round-trip.
  useEffect(() => {
    try {
      const canvas = document.createElement("canvas");
      const gl =
        (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
        (canvas.getContext("webgl") as WebGLRenderingContext | null);
      if (!gl) {
        setWebglSupported(false);
        return;
      }
      const program = gl.createProgram();
      if (!program) {
        setWebglSupported(false);
        return;
      }
      gl.deleteProgram(program);
      setWebglSupported(true);
    } catch {
      setWebglSupported(false);
    }
  }, []);

  // Track viewport dimensions; ForceGraph requires explicit width/height props.
  useEffect(() => {
    if (!viewportRef.current) return;
    const element = viewportRef.current;
    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      const width = rect.width > 0 ? rect.width : 800;
      const height = rect.height > 0 ? rect.height : 600;
      setViewport({ width, height });
    });
    observer.observe(element);
    const initial = element.getBoundingClientRect();
    setViewport({
      width: initial.width > 0 ? initial.width : 800,
      height: initial.height > 0 ? initial.height : 600
    });
    return () => observer.disconnect();
  }, []);

  // Fetch graph payload
  useEffect(() => {
    let cancelled = false;
    const fetchData = async () => {
      try {
        setLoading(true);
        const result = await apiFetch<SoulGraph | SoulGraphEnvelope>(
          `/graph/${workspaceId ?? "default"}`
        );
        if (cancelled) return;
        const graph = unwrapSoulGraph(result);
        const nodes: GraphNode[] = (graph.nodes ?? []).map((n) => ({ ...n }));
        const links: GraphLink[] = (graph.edges ?? []).map((e) => ({
          id: e.id,
          kind: e.kind,
          source: e.source_id,
          target: e.target_id,
          weight: e.weight,
          strength_normalized: e.strength_normalized,
          stability_class: e.stability_class,
          last_reinforced_at: e.last_reinforced_at
        }));
        const degreeBy = new Map<string, number>();
        links.forEach((l) => {
          degreeBy.set(extractId(l.source), (degreeBy.get(extractId(l.source)) ?? 0) + 1);
          degreeBy.set(extractId(l.target), (degreeBy.get(extractId(l.target)) ?? 0) + 1);
        });
        nodes.forEach((n) => {
          n.degree = degreeBy.get(n.id) ?? 0;
        });
        setData({
          nodes,
          links,
          meta: {
            truncated: graph.truncated,
            nodeTotal: graph.node_total,
            edgeTotal: graph.edge_total
          }
        });
      } catch (err) {
        if ((err as ApiError).status === 401) return;
        setError((err as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };
    void fetchData();
    return () => {
      cancelled = true;
    };
  }, [workspaceId]);

  // Tune the d3 force-link distance / strength based on edge.strength_normalized.
  // ForceGraph exposes the underlying d3 simulation via ref.d3Force(...). We
  // re-apply on every data change so a refetch picks up new edge weights.
  useEffect(() => {
    if (!data) return;
    const apply = (instance: { d3Force?: (name: string) => unknown } | undefined) => {
      if (!instance?.d3Force) return;
      const linkForce = instance.d3Force("link") as
        | {
            distance: (fn: (l: GraphLink) => number) => unknown;
            strength: (fn: (l: GraphLink) => number) => unknown;
          }
        | undefined;
      if (!linkForce) return;
      linkForce.distance((l: GraphLink) => linkDistance(l.strength_normalized));
      linkForce.strength((l: GraphLink) => 0.1 + 0.9 * (l.strength_normalized ?? 0.4));
    };
    apply(fg2dRef.current);
    apply(fg3dRef.current);
  }, [data, viewMode]);

  // Spotlight: compute match + adjacent sets from search term
  const { matchIds, adjacentIds, matchOrder } = useMemo(() => {
    if (!data || searchTerm.trim() === "") {
      return {
        matchIds: new Set<string>(),
        adjacentIds: new Set<string>(),
        matchOrder: [] as string[]
      };
    }
    const needle = searchTerm.trim().toLowerCase();
    const matches = data.nodes.filter((n) => {
      const haystack = `${n.id} ${n.label} ${n.summary ?? ""}`.toLowerCase();
      return haystack.includes(needle);
    });
    const matchSet = new Set(matches.map((n) => n.id));
    const adjacent = new Set<string>();
    data.links.forEach((l) => {
      const a = extractId(l.source);
      const b = extractId(l.target);
      if (matchSet.has(a)) adjacent.add(b);
      if (matchSet.has(b)) adjacent.add(a);
    });
    matchSet.forEach((id) => adjacent.delete(id));
    return {
      matchIds: matchSet,
      adjacentIds: adjacent,
      matchOrder: matches.map((n) => n.id)
    };
  }, [data, searchTerm]);

  const spotlightActive = searchTerm.trim() !== "";
  const matchCount = matchOrder.length;

  const nodeSpotlightState = useCallback(
    (id: string): SpotlightState => {
      if (!spotlightActive) return "match";
      if (matchIds.has(id)) return "match";
      if (adjacentIds.has(id)) return "adjacent";
      return "background";
    },
    [matchIds, adjacentIds, spotlightActive]
  );

  // Lock to 2D when WebGL is unavailable so we never mount the 3D component.
  const effectiveMode: ViewMode = webglSupported ? viewMode : "2d";

  // Keyboard shortcuts: '/', Cmd/Ctrl+K → focus search; Esc → clear/close drawer
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const isTyping =
        target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement;
      if ((e.key === "/" && !isTyping) || (e.key.toLowerCase() === "k" && (e.metaKey || e.ctrlKey))) {
        e.preventDefault();
        searchInputRef.current?.focus();
      } else if (e.key === "Escape") {
        if (selectedNode) {
          setSelectedNode(null);
        } else if (searchTerm) {
          setSearchTerm("");
        }
      } else if (e.key === "ArrowDown" && spotlightActive && matchCount > 0) {
        if (isTyping && target === searchInputRef.current) {
          e.preventDefault();
          setMatchCursor((c) => (c + 1) % matchCount);
        }
      } else if (e.key === "ArrowUp" && spotlightActive && matchCount > 0) {
        if (isTyping && target === searchInputRef.current) {
          e.preventDefault();
          setMatchCursor((c) => (c - 1 + matchCount) % matchCount);
        }
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [selectedNode, searchTerm, spotlightActive, matchCount]);

  useEffect(() => {
    setMatchCursor(0);
  }, [searchTerm]);

  const focusedMatchId = matchOrder[matchCursor];

  // Recenter view on the focused search match.
  useEffect(() => {
    if (!focusedMatchId || !data) return;
    const node = data.nodes.find((n) => n.id === focusedMatchId);
    if (!node || node.x === undefined || node.y === undefined) return;
    if (effectiveMode === "2d" && fg2dRef.current?.centerAt) {
      fg2dRef.current.centerAt(node.x, node.y, 600);
      fg2dRef.current.zoom?.(2, 600);
    } else if (effectiveMode === "3d" && fg3dRef.current?.cameraPosition) {
      const distance = 220;
      const dist = Math.hypot(node.x ?? 0, node.y ?? 0, (node as { z?: number }).z ?? 0) || 1;
      fg3dRef.current.cameraPosition(
        {
          x: ((node.x ?? 0) / dist) * distance,
          y: ((node.y ?? 0) / dist) * distance,
          z: (((node as { z?: number }).z ?? 0) / dist) * distance
        },
        node as unknown as { x: number; y: number; z: number },
        800
      );
    }
  }, [focusedMatchId, data, effectiveMode]);

  const copyToClipboard = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text);
      showToast({ message: "copied to clipboard", type: "success", duration: 2500 });
    },
    [showToast]
  );

  const createMemoryProposal = useCallback(
    async (
      action: "keep" | "rewrite" | "downgrade" | "retire",
      nodeId: string,
      newContent?: string
    ) => {
      if (workspaceId === null) {
        showToast({ type: "error", message: "No workspace selected." });
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
            ? "Proposal already pending. Review at Pending Proposals."
            : "Proposal created. Review at Pending Proposals.",
          action: {
            label: "Review",
            onClick: () => navigate(`/proposals?highlight=${encodeURIComponent(proposalId)}`)
          }
        });
        navigate(`/proposals?highlight=${encodeURIComponent(proposalId)}`);
      } catch (err) {
        if ((err as ApiError).status === 401) {
          return;
        }
        showToast({
          type: "error",
          message: err instanceof Error ? err.message : "proposal creation failed"
        });
      }
    },
    [navigate, showToast, workspaceId]
  );

  // Node color is the central visual encoding: origin_kind hue, recency alpha,
  // and spotlight dim/highlight all collapse here so ForceGraph repaint stays
  // a per-frame function call rather than a re-render.
  const computeNodeColor = useCallback(
    (node: GraphNode): string => {
      const baseHex =
        ORIGIN_KIND_COLOR[node.origin_kind ?? ""] ??
        ORIGIN_KIND_COLOR.system ??
        DEFAULT_NODE_FALLBACK_COLOR;
      const rgb = hexToRgb(baseHex);
      const recency = recencyAlpha(node.last_used_at, now);
      const state = nodeSpotlightState(node.id);
      let alpha = recency;
      if (state === "background") alpha = SPOTLIGHT_BG_ALPHA;
      else if (state === "adjacent") alpha = Math.min(recency, SPOTLIGHT_ADJ_ALPHA);
      return rgba(rgb, alpha);
    },
    [now, nodeSpotlightState]
  );

  // Link color = type base RGB + strength_normalized alpha + stability dimming.
  // A reinforced-in-24h glow rides on top via linkColor returning a brighter
  // alpha so eyes are drawn to "what just changed."
  const computeLinkColor = useCallback(
    (link: GraphLink): string => {
      const rgb = EDGE_TYPE_BASE_COLOR[link.kind] ?? [147, 161, 161];
      const baseAlpha = linkAlpha(link.strength_normalized);
      const reinforced = isRecentlyReinforced(link.last_reinforced_at, now);
      const aSrc = extractId(link.source);
      const aTgt = extractId(link.target);
      let alpha = baseAlpha;
      if (spotlightActive) {
        const both = matchIds.has(aSrc) && matchIds.has(aTgt);
        const either = matchIds.has(aSrc) || matchIds.has(aTgt);
        if (!both && !either) alpha = baseAlpha * 0.15;
        else if (!both) alpha = Math.min(baseAlpha, 0.55);
      }
      if (reinforced) alpha = Math.max(alpha, REINFORCED_GLOW_ALPHA);
      return rgba(rgb, alpha);
    },
    [now, matchIds, spotlightActive]
  );

  const handleNodeClick = useCallback((node: GraphNode) => {
    setSelectedNode(node);
  }, []);

  const handleBackgroundClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

  // 2D nodeCanvasObject draws kind-as-shape (memory=circle, scope=square,
  // signal=triangle, projection=diamond) plus an optional ring for selection
  // and the recency/origin-tinted fill the rest of the encoding builds on.
  const nodeCanvasObject = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const radius = nodeInfluenceSize(node);
      const fill = computeNodeColor(node);
      ctx.save();
      drawNodeShape(ctx, node.kind, x, y, radius, fill);
      if (selectedNode?.id === node.id) {
        ctx.strokeStyle = "#586E75";
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(x, y, radius + 3, 0, 2 * Math.PI);
        ctx.stroke();
      }
      // Show labels when zoomed in OR for high-degree hubs OR when this node
      // is in the search match set. Background spotlight nodes never show
      // labels regardless of zoom.
      const state = nodeSpotlightState(node.id);
      const showLabel =
        state !== "background" &&
        (globalScale > 1.2 || (node.degree ?? 0) >= 8 || matchIds.has(node.id));
      if (showLabel && node.label) {
        ctx.font = `${Math.max(10, 11 / Math.max(0.5, globalScale))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
        ctx.textAlign = "center";
        ctx.textBaseline = "top";
        ctx.lineWidth = 3;
        ctx.strokeStyle = "rgba(253, 246, 227, 0.95)";
        ctx.fillStyle = "#586E75";
        const ty = y + radius + 6;
        ctx.strokeText(node.label, x, ty);
        ctx.fillText(node.label, x, ty);
      }
      ctx.restore();
    },
    [computeNodeColor, selectedNode, matchIds, nodeSpotlightState]
  );

  // Link line dash for 2D — encodes stability_class as solid/dashed.
  const linkLineDashFor = (link: GraphLink): number[] | null => {
    const dash = STABILITY_DASH[link.stability_class ?? "stable"];
    return dash === undefined ? null : (dash as unknown as number[] | null);
  };

  // 2D-mode link override so we can paint the reinforced-glow underlay before
  // the actual stroke — react-force-graph's default linkCanvasObject would skip
  // the glow band entirely otherwise.
  const linkCanvasObject = useCallback(
    (link: GraphLink, ctx: CanvasRenderingContext2D) => {
      const sourceNode = link.source as GraphNode;
      const targetNode = link.target as GraphNode;
      const x1 = sourceNode.x ?? 0;
      const y1 = sourceNode.y ?? 0;
      const x2 = targetNode.x ?? 0;
      const y2 = targetNode.y ?? 0;
      const baseColor = computeLinkColor(link);
      const width = linkWidth(link.strength_normalized);
      const dash = linkLineDashFor(link);
      ctx.save();
      if (isRecentlyReinforced(link.last_reinforced_at, now)) {
        // Subtle outer glow for paths reinforced in the last 24h.
        const rgb = EDGE_TYPE_BASE_COLOR[link.kind] ?? [147, 161, 161];
        ctx.strokeStyle = rgba(rgb, 0.35);
        ctx.lineWidth = width + 4;
        ctx.beginPath();
        ctx.moveTo(x1, y1);
        ctx.lineTo(x2, y2);
        ctx.stroke();
      }
      ctx.strokeStyle = baseColor;
      ctx.lineWidth = width;
      if (dash) ctx.setLineDash(dash);
      ctx.beginPath();
      ctx.moveTo(x1, y1);
      ctx.lineTo(x2, y2);
      ctx.stroke();
      ctx.restore();
    },
    [computeLinkColor, now]
  );

  return (
    <div
      ref={viewportRef}
      data-graph-viewport="true"
      className="flex-1 min-h-0 relative overflow-hidden bg-[#FDF6E3]"
    >
      {/* Top overlay row: search + 2D/3D toggle */}
      <div className="absolute left-4 right-4 top-4 z-20 flex items-center justify-between gap-3 sm:flex-row">
        <div className="flex flex-1 items-center gap-3 rounded-full border border-beige-200 bg-beige-50/95 px-4 py-2 shadow-sm backdrop-blur-sm sm:max-w-md">
          <Search className="w-3 h-3 text-ink-700/40" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder="probe label / id / summary  (press /)"
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink-700 outline-none placeholder:text-ink-700/30"
            aria-label="Search graph nodes"
          />
          {spotlightActive ? (
            <span className="text-[10px] text-ink-700/40 font-mono whitespace-nowrap">
              {matchCount === 0 ? "no nodes match" : `${matchCursor + 1}/${matchCount}`}
            </span>
          ) : null}
          {searchTerm ? (
            <button
              onClick={() => setSearchTerm("")}
              className="text-ink-700/40 hover:text-ink-700"
              aria-label="Clear search"
            >
              <X className="w-3 h-3" />
            </button>
          ) : null}
        </div>
        <ViewModeToggle
          mode={effectiveMode}
          webglSupported={webglSupported}
          onChange={setViewMode}
        />
      </div>

      {loading ? (
        <div className="absolute inset-0 flex items-center justify-center bg-beige-100/50 z-10">
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 border-2 border-[#586E75]/20 border-t-[#586E75] rounded-full animate-spin" />
            <p className="font-mono text-xs uppercase text-ink-600 tracking-widest">
              Scanning Memory Fabric...
            </p>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="absolute inset-0 flex items-center justify-center z-10 p-8">
          <div className="bg-beige-50 border border-[#C9ADA7] p-4 rounded-md max-w-md">
            <h3 className="text-ink-600 font-bold mb-2 font-mono">Graph Error</h3>
            <p className="text-ink-700 text-sm font-mono">{error}</p>
          </div>
        </div>
      ) : null}

      {data ? (
        <div className="absolute bottom-4 left-4 z-20 flex items-center gap-2 rounded-md border border-beige-200 bg-beige-50/95 px-3 py-2 text-[10px] font-mono uppercase text-ink-700/55 shadow-sm">
          <span>
            {data.nodes.length}/{data.meta.nodeTotal} nodes
          </span>
          <span>·</span>
          <span>
            {data.links.length}/{data.meta.edgeTotal} edges
          </span>
          <span className="rounded-sm bg-[#586E75]/10 px-1.5 py-0.5 text-ink-700/65">
            {data.meta.truncated ||
            data.nodes.length < data.meta.nodeTotal ||
            data.links.length < data.meta.edgeTotal
              ? "sampled"
              : "complete"}
          </span>
        </div>
      ) : null}

      {/* Origin-kind legend pinned bottom-right so the new colour vocabulary
          (5 origin kinds incl. reviewed_engineering_chunk) is always findable. */}
      {data ? <OriginLegend /> : null}

      {/* The graph itself. We mount one or the other component (not both) so
          react-force-graph's two simulations never compete for the same data. */}
      <div className="absolute inset-0" data-spotlight-active={spotlightActive ? "true" : "false"}>
        {data && effectiveMode === "2d" ? (
          <ForceGraph2D
            ref={fg2dRef}
            graphData={data}
            width={viewport.width}
            height={viewport.height}
            backgroundColor="#FDF6E3"
            nodeId="id"
            nodeRelSize={1}
            nodeVal={(n) => nodeInfluenceSize(n) * nodeInfluenceSize(n)}
            nodeColor={computeNodeColor}
            nodeLabel={(n) => `${n.label}${n.summary ? `\n${n.summary}` : ""}`}
            nodeCanvasObject={nodeCanvasObject}
            nodeCanvasObjectMode={() => "replace"}
            linkSource="source"
            linkTarget="target"
            linkColor={computeLinkColor}
            linkWidth={(l) => linkWidth(l.strength_normalized)}
            linkCanvasObjectMode={() => "replace"}
            linkCanvasObject={linkCanvasObject}
            cooldownTicks={120}
            d3VelocityDecay={0.4}
            onNodeClick={handleNodeClick}
            onBackgroundClick={handleBackgroundClick}
          />
        ) : null}
        {data && effectiveMode === "3d" ? (
          <ForceGraph3D
            ref={fg3dRef}
            graphData={data}
            width={viewport.width}
            height={viewport.height}
            backgroundColor="#1B1F23"
            nodeId="id"
            nodeRelSize={4}
            nodeVal={(n) => nodeInfluenceSize(n)}
            nodeColor={computeNodeColor}
            nodeLabel={(n) => `${n.label}${n.summary ? `\n${n.summary}` : ""}`}
            nodeOpacity={0.92}
            linkSource="source"
            linkTarget="target"
            linkColor={computeLinkColor}
            linkWidth={(l) => linkWidth(l.strength_normalized)}
            linkOpacity={0.85}
            linkDirectionalParticles={(l) =>
              isRecentlyReinforced(l.last_reinforced_at, now) ? 2 : 0
            }
            linkDirectionalParticleSpeed={(l) =>
              0.005 + 0.012 * (l.strength_normalized ?? 0.4)
            }
            linkDirectionalParticleWidth={2}
            cooldownTicks={120}
            onNodeClick={handleNodeClick}
            onBackgroundClick={handleBackgroundClick}
          />
        ) : null}
      </div>

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

interface ViewModeToggleProps {
  readonly mode: ViewMode;
  readonly webglSupported: boolean;
  readonly onChange: (next: ViewMode) => void;
}

function ViewModeToggle({ mode, webglSupported, onChange }: ViewModeToggleProps) {
  return (
    <div
      className="flex items-center gap-1 rounded-full border border-beige-200 bg-beige-50/95 p-1 shadow-sm"
      role="group"
      aria-label="Graph view mode"
    >
      <button
        type="button"
        onClick={() => onChange("2d")}
        className={`flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[10px] uppercase transition-colors ${
          mode === "2d" ? "bg-[#586E75] text-beige-50" : "text-ink-700/60 hover:text-ink-700"
        }`}
        aria-pressed={mode === "2d"}
      >
        <Square className="w-3 h-3" /> 2D
      </button>
      <button
        type="button"
        onClick={() => webglSupported && onChange("3d")}
        disabled={!webglSupported}
        className={`flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[10px] uppercase transition-colors ${
          mode === "3d" ? "bg-[#586E75] text-beige-50" : "text-ink-700/60 hover:text-ink-700"
        } ${webglSupported ? "" : "cursor-not-allowed opacity-40"}`}
        aria-pressed={mode === "3d"}
        title={webglSupported ? undefined : "3D unavailable: WebGL not supported in this environment"}
      >
        <Box className="w-3 h-3" /> 3D
      </button>
    </div>
  );
}

function OriginLegend() {
  const items: ReadonlyArray<{ kind: string; label: string }> = [
    { kind: "user_memory", label: "user memory" },
    { kind: "engineering_chunk", label: "engineering chunk" },
    { kind: "reviewed_engineering_chunk", label: "reviewed engineering" },
    { kind: "proposal_pending", label: "proposal pending" },
    { kind: "system", label: "system" }
  ];
  return (
    <div className="absolute bottom-4 right-4 z-20 flex flex-col gap-1 rounded-md border border-beige-200 bg-beige-50/95 px-3 py-2 text-[10px] font-mono uppercase text-ink-700/65 shadow-sm">
      {items.map((item) => (
        <div key={item.kind} className="flex items-center gap-2">
          <span
            aria-hidden="true"
            className="inline-block h-2.5 w-2.5 rounded-full"
            style={{ backgroundColor: ORIGIN_KIND_COLOR[item.kind] }}
          />
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

function drawNodeShape(
  ctx: CanvasRenderingContext2D,
  kind: string,
  x: number,
  y: number,
  r: number,
  fill: string
): void {
  ctx.fillStyle = fill;
  ctx.beginPath();
  switch (kind) {
    case "scope":
      // Square: stable, structural scope nodes.
      ctx.rect(x - r, y - r, r * 2, r * 2);
      break;
    case "signal":
      // Triangle: ephemeral candidate signals not yet promoted.
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.lineTo(x - r, y + r);
      ctx.closePath();
      break;
    case "projection":
      // Diamond: derived/projected nodes (proposal projections, etc.).
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      break;
    case "memory":
    default:
      // Circle: durable memory entries.
      ctx.arc(x, y, r, 0, 2 * Math.PI);
      break;
  }
  ctx.fill();
}

function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace(/^#/, "");
  const value = cleaned.length === 3 ? cleaned.split("").map((c) => c + c).join("") : cleaned;
  const num = Number.parseInt(value, 16);
  if (Number.isNaN(num)) return [88, 110, 117];
  return [(num >> 16) & 0xff, (num >> 8) & 0xff, num & 0xff];
}

function extractId(endpoint: string | number | { id: string }): string {
  if (typeof endpoint === "string") return endpoint;
  if (typeof endpoint === "number") return String(endpoint);
  return endpoint.id;
}

function unwrapSoulGraph(value: SoulGraph | SoulGraphEnvelope): SoulGraph {
  if (isSoulGraphEnvelope(value)) {
    return value.data;
  }

  return value;
}

function isSoulGraphEnvelope(value: SoulGraph | SoulGraphEnvelope): value is SoulGraphEnvelope {
  return (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    typeof value.data === "object" &&
    value.data !== null
  );
}
