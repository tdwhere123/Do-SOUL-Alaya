import {
  Suspense,
  lazy,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { useNavigate } from "react-router-dom";
import { Search, X, Box, Square } from "lucide-react";
import ForceGraph2D from "react-force-graph-2d";
import type { ForceGraphMethods as ForceGraphMethods2D } from "react-force-graph-2d";
import type ForceGraph3DType from "react-force-graph-3d";
import type { ForceGraphMethods as ForceGraphMethods3D } from "react-force-graph-3d";

const ForceGraph3D = lazy(() => import("react-force-graph-3d")) as unknown as typeof ForceGraph3DType;
import { apiFetch, getWorkspaceId, type ApiError } from "../api";
import { useToasts } from "../components/Toast";
import { DetailDrawer } from "../components/DetailDrawer";
import type { GraphNode, GraphLink, SpotlightState } from "../types/graph";
import { parseSearchQuery } from "../utils/parse-search-query";
import { useI18n } from "../i18n/Locale";
import type { DictKey } from "../i18n/dict";
import {
  EDGE_TYPE_BASE_COLOR,
  ORIGIN_KIND_COLOR,
  STABILITY_DASH,
  extractId,
  formatRelativeTime,
  isRecentlyReinforced,
  linkAlpha,
  linkDistance,
  linkStrength,
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
type ForceGraphWithForces = {
  d3Force?: (name: string) => unknown;
  d3ReheatSimulation?: () => unknown;
};
type TunedForceKey = "twoD" | "threeD";

const DEFAULT_NODE_FALLBACK_COLOR = "#586E75";
const SPOTLIGHT_BG_ALPHA = 0.12;
const SPOTLIGHT_ADJ_ALPHA = 0.55;
const REINFORCED_GLOW_ALPHA = 0.95;
const LARGE_GRAPH_NODE_THRESHOLD = 500;
const LOW_FPS_THRESHOLD = 30;
const LOW_FPS_FRAME_COUNT = 15;
const RECOVERED_FPS_FRAME_COUNT = 15;

export default function GraphPage() {
  const { t } = useI18n();
  const viewportRef = useRef<HTMLDivElement>(null);
  const fg2dRef = useRef<ForceGraphMethods2D<GraphNode, GraphLink> | undefined>(undefined);
  const fg3dRef = useRef<ForceGraphMethods3D<GraphNode, GraphLink> | undefined>(undefined);
  const nodePositionsRef = useRef<Map<string, { x?: number; y?: number; z?: number }>>(new Map());
  const tunedForceRefs = useRef<Record<TunedForceKey, ForceGraphWithForces | null>>({
    twoD: null,
    threeD: null
  });
  const [data, setData] = useState<GraphData | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [debouncedSearchTerm, setDebouncedSearchTerm] = useState("");
  // When the debounced search term parses to a time window, the spotlight
  // hits come from the daemon /soul/search endpoint instead of the in-memory
  // substring scan. Null = use substring fallback. The chip below the search
  // bar shows the parsed window label so operators see why the result set
  // changed.
  const [searchTimeHits, setSearchTimeHits] = useState<{
    readonly ids: ReadonlySet<string>;
    readonly windowLabel: string;
  } | null>(null);
  const [searchError, setSearchError] = useState<string | null>(null);
  // Keyword remainder after the parser strips a recognised time expression.
  // When the daemon errors out and we fall back to substring matching, we
  // search this rather than the full `debouncedSearchTerm` so the matcher
  // is not fed "5月20号 inspector" — which would match almost nothing —
  // and instead sees just "inspector".
  const [searchKeywordFallback, setSearchKeywordFallback] = useState<string>("");
  const [matchCursor, setMatchCursor] = useState(0);
  const [viewMode, setViewMode] = useState<ViewMode>("2d");
  const [webglSupported] = useState<boolean>(() => probeWebgl());
  const [lowFpsDetected, setLowFpsDetected] = useState(false);
  const [viewport, setViewport] = useState<{ width: number; height: number }>(() => ({
    width: 800,
    height: 600
  }));
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const { showToast } = useToasts();
  const navigate = useNavigate();

  const workspaceId = getWorkspaceId();
  const [now, setNow] = useState<number>(() => Date.now());
  useEffect(() => {
    const id = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(id);
  }, []);

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
    if (workspaceId === null) {
      setLoading(false);
      return;
    }
    let cancelled = false;
    const fetchData = async () => {
      try {
        setLoading(true);
        const result = await apiFetch<SoulGraph | SoulGraphEnvelope>(
          `/graph/${workspaceId}`
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

  const tuneGraphForces = useCallback((instance: ForceGraphWithForces | undefined, reheat = false) => {
    if (!instance?.d3Force) return;
    const linkForce = instance.d3Force("link") as
      | {
          distance: (fn: (l: GraphLink) => number) => unknown;
          strength: (fn: (l: GraphLink) => number) => unknown;
        }
      | undefined;
    if (!linkForce) return;
    linkForce.distance((l: GraphLink) => linkDistance(l.strength_normalized, l.weight));
    linkForce.strength(
      (l: GraphLink) => 0.1 + 0.9 * linkStrength(l.strength_normalized, l.weight)
    );
    if (reheat) instance.d3ReheatSimulation?.();
  }, []);

  useEffect(() => {
    if (!data) return;
    tunedForceRefs.current = { twoD: null, threeD: null };
    tuneGraphForces(fg2dRef.current, true);
    tuneGraphForces(fg3dRef.current, true);
  }, [data, viewMode, tuneGraphForces]);

  const handleGraphEngineTick = useCallback(
    (mode: ViewMode) => {
      const key: TunedForceKey = mode === "2d" ? "twoD" : "threeD";
      const instance = mode === "2d" ? fg2dRef.current : fg3dRef.current;
      if (!instance || tunedForceRefs.current[key] === instance) return;
      tuneGraphForces(instance, true);
      tunedForceRefs.current[key] = instance;
    },
    [tuneGraphForces]
  );

  // Spotlight: compute match + adjacent sets from the *debounced* search term
  // so 5k+ node workspaces don't re-scan on every keystroke. Two paths feed
  // matchIds: time-window queries fetch from the daemon (searchTimeHits),
  // pure-keyword queries fall through to in-memory substring matching.
  const { matchIds, adjacentIds, matchOrder } = useMemo(() => {
    if (!data || debouncedSearchTerm.trim() === "") {
      return {
        matchIds: new Set<string>(),
        adjacentIds: new Set<string>(),
        matchOrder: [] as string[]
      };
    }
    let matchSet: Set<string>;
    let order: string[];
    if (searchTimeHits) {
      matchSet = new Set(searchTimeHits.ids);
      order = data.nodes
        .filter((n) => matchSet.has(n.id))
        .map((n) => n.id);
    } else {
      // When a time expression was parsed but the daemon errored (or no
      // time expression was found at all), fall back to substring matching
      // on the parsed keyword remainder. searchKeywordFallback equals
      // debouncedSearchTerm when the parser found no time window, so the
      // legacy behaviour is preserved.
      const fallbackText =
        searchKeywordFallback.length > 0 ? searchKeywordFallback : debouncedSearchTerm.trim();
      const needle = fallbackText.toLowerCase();
      const matches =
        needle.length === 0
          ? []
          : data.nodes.filter((n) => {
              const haystack = `${n.id} ${n.label} ${n.summary ?? ""}`.toLowerCase();
              return haystack.includes(needle);
            });
      matchSet = new Set(matches.map((n) => n.id));
      order = matches.map((n) => n.id);
    }
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
      matchOrder: order
    };
  }, [data, debouncedSearchTerm, searchTimeHits, searchKeywordFallback]);

  // The chip + clear-button still react to the live `searchTerm` so the user
  // sees their input immediately; only the heavy spotlight scan is debounced.
  const spotlightActive = searchTerm.trim() !== "" && debouncedSearchTerm.trim() !== "";
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

  const effectiveMode: ViewMode = webglSupported ? viewMode : "2d";
  const largeGraphMode =
    effectiveMode === "3d" && (data?.nodes.length ?? 0) > LARGE_GRAPH_NODE_THRESHOLD;

  useEffect(() => {
    if (!largeGraphMode || typeof window.requestAnimationFrame !== "function") {
      setLowFpsDetected(false);
      return;
    }
    let frameId = 0;
    let last = 0;
    let lowFrames = 0;
    let recoveredFrames = 0;
    let warningVisible = false;
    const updateLowFpsDetected = (next: boolean) => {
      if (warningVisible === next) return;
      warningVisible = next;
      setLowFpsDetected(next);
    };
    const sampleFrame = (timestamp: number) => {
      if (last > 0) {
        const delta = timestamp - last;
        const fps = delta > 0 ? 1000 / delta : LOW_FPS_THRESHOLD;
        if (fps < LOW_FPS_THRESHOLD) {
          lowFrames += 1;
          recoveredFrames = 0;
          if (lowFrames >= LOW_FPS_FRAME_COUNT) updateLowFpsDetected(true);
        } else {
          lowFrames = 0;
          recoveredFrames += 1;
          if (recoveredFrames >= RECOVERED_FPS_FRAME_COUNT) updateLowFpsDetected(false);
        }
      }
      last = timestamp;
      frameId = window.requestAnimationFrame(sampleFrame);
    };
    frameId = window.requestAnimationFrame(sampleFrame);
    return () => window.cancelAnimationFrame(frameId);
  }, [largeGraphMode]);

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

  useEffect(() => {
    if (searchTerm === debouncedSearchTerm) return;
    const id = window.setTimeout(() => setDebouncedSearchTerm(searchTerm), 120);
    return () => window.clearTimeout(id);
  }, [searchTerm, debouncedSearchTerm]);

  // Parse the debounced query. When a time window is detected, fetch
  // ranked hits from /api/soul/search/:workspaceId; otherwise fall through
  // to the legacy in-memory substring spotlight.
  useEffect(() => {
    if (workspaceId === null) return;
    const trimmed = debouncedSearchTerm.trim();
    if (trimmed.length === 0) {
      setSearchTimeHits(null);
      setSearchError(null);
      setSearchKeywordFallback("");
      return;
    }
    let cancelled = false;
    void (async () => {
      const parsed = await parseSearchQuery(trimmed);
      if (cancelled) return;
      setSearchKeywordFallback(parsed.text);
      if (parsed.since === null && parsed.until === null) {
        setSearchTimeHits(null);
        setSearchError(null);
        return;
      }
      try {
        const envelope = await apiFetch<{
          success: boolean;
          data: {
            results: ReadonlyArray<{ object_id: string }>;
            total_count?: number;
          };
        }>(`/soul/search/${workspaceId}`, {
          method: "POST",
          body: {
            text: parsed.text.length > 0 ? parsed.text : (parsed.windowLabel ?? trimmed),
            since: parsed.since,
            until: parsed.until,
            max_results: 50
          }
        });
        if (cancelled) return;
        const ids = new Set(envelope.data.results.map((r) => r.object_id));
        setSearchTimeHits({
          ids,
          windowLabel: parsed.windowLabel ?? trimmed
        });
        setSearchError(null);
      } catch (err) {
        if (cancelled) return;
        if ((err as ApiError).status === 401) return;
        setSearchTimeHits(null);
        setSearchError(err instanceof Error ? err.message : "search failed");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [debouncedSearchTerm, workspaceId]);

  useEffect(() => {
    return () => {
      if (!data) return;
      for (const n of data.nodes) {
        const z = (n as { z?: number }).z;
        if (n.x !== undefined || n.y !== undefined || z !== undefined) {
          nodePositionsRef.current.set(n.id, { x: n.x, y: n.y, z });
        }
      }
    };
  }, [viewMode, data]);

  useEffect(() => {
    if (!data) return;
    const cache = nodePositionsRef.current;
    if (cache.size === 0) return;
    for (const n of data.nodes) {
      const cached = cache.get(n.id);
      if (!cached) continue;
      if (cached.x !== undefined) n.x = cached.x;
      if (cached.y !== undefined) n.y = cached.y;
      if (cached.z !== undefined) (n as { z?: number }).z = cached.z;
    }
  }, [data, viewMode]);

  const focusedMatchId = matchOrder[matchCursor];

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
        if ((err as ApiError).status === 401) {
          return;
        }
        showToast({
          type: "error",
          message: err instanceof Error ? err.message : t("drawer:action.proposalFailed")
        });
      }
    },
    [navigate, showToast, workspaceId, t]
  );

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

  const computeLinkColor = useCallback(
    (link: GraphLink): string => {
      const rgb = EDGE_TYPE_BASE_COLOR[link.kind] ?? [147, 161, 161];
      const baseAlpha = linkAlpha(link.strength_normalized, link.weight);
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

  const handleNodeClick = useCallback((node: GraphNode, event?: MouseEvent) => {
    setSelectedNode(node);
    if ((event?.detail ?? 1) >= 2) {
      setSearchTerm(node.id);
    }
  }, []);

  const handleBackgroundClick = useCallback(() => {
    setSelectedNode(null);
  }, []);

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

  const linkLineDashFor = (link: GraphLink): number[] | null => {
    const dash = STABILITY_DASH[link.stability_class ?? "stable"];
    return dash === undefined ? null : (dash as unknown as number[] | null);
  };

  const linkCanvasObject = useCallback(
    (link: GraphLink, ctx: CanvasRenderingContext2D) => {
      const sourceNode = link.source as GraphNode;
      const targetNode = link.target as GraphNode;
      const x1 = sourceNode.x ?? 0;
      const y1 = sourceNode.y ?? 0;
      const x2 = targetNode.x ?? 0;
      const y2 = targetNode.y ?? 0;
      const baseColor = computeLinkColor(link);
      const width = linkWidth(link.strength_normalized, link.weight);
      const dash = linkLineDashFor(link);
      ctx.save();
      if (isRecentlyReinforced(link.last_reinforced_at, now)) {
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

  if (workspaceId === null) {
    return (
      <div
        role="alert"
        data-testid="graph-no-workspace"
        className="flex-1 min-h-0 flex items-center justify-center bg-[#FDF6E3] p-8"
      >
        <p className="font-mono text-sm text-ink-700">
          {t("common:noWorkspace")}
        </p>
      </div>
    );
  }

  return (
    <div
      ref={viewportRef}
      data-graph-viewport="true"
      className="flex-1 min-h-0 relative overflow-hidden bg-[#FDF6E3]"
    >
      <div className="absolute left-4 right-4 top-4 z-20 flex items-center justify-between gap-3 sm:flex-row">
        <div className="flex flex-1 items-center gap-3 rounded-full border border-beige-200 bg-beige-50/95 px-4 py-2 shadow-sm backdrop-blur-sm sm:max-w-md">
          <Search className="w-3 h-3 text-ink-700/40" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)}
            placeholder={t("graph:search.placeholder")}
            className="min-w-0 flex-1 bg-transparent font-mono text-xs text-ink-700 outline-none placeholder:text-ink-700/30"
            aria-label={t("graph:search.placeholder")}
          />
          {spotlightActive ? (
            <span className="text-[10px] text-ink-700/40 font-mono whitespace-nowrap">
              {matchCount === 0
                ? t("graph:search.noMatch")
                : t("graph:search.matchCounter", {
                    current: matchCursor + 1,
                    total: matchCount
                  })}
            </span>
          ) : null}
          {searchTerm ? (
            <button
              onClick={() => setSearchTerm("")}
              className="text-ink-700/40 hover:text-ink-700"
              aria-label={t("graph:search.clear")}
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

      {data && !webglSupported ? (
        <div className="absolute left-4 top-16 z-20 max-w-md rounded-md border border-[#D4AF37]/35 bg-beige-50/95 px-3 py-2 font-mono text-[10px] uppercase tracking-wide text-ink-700/65 shadow-sm">
          {t("graph:webgl.locked")}
        </div>
      ) : null}

      {searchTimeHits ? (
        <div
          className="absolute left-1/2 top-16 z-20 -translate-x-1/2 rounded-full border border-[#4A90A4]/35 bg-beige-50/95 px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-ink-700/70 shadow-sm"
          data-testid="search-time-window-chip"
        >
          {t("graph:search.windowChip", {
            window: searchTimeHits.windowLabel,
            hits: searchTimeHits.ids.size
          })}
        </div>
      ) : null}

      {searchError ? (
        <div
          className="absolute left-1/2 top-16 z-20 -translate-x-1/2 rounded-md border border-[#C9ADA7] bg-beige-50/95 px-3 py-1 font-mono text-[10px] uppercase tracking-wide text-[#8B4536] shadow-sm"
          data-testid="search-error-chip"
        >
          {t("graph:search.errorChip", { message: searchError })}
        </div>
      ) : null}

      {data && largeGraphMode ? (
        <div className="absolute left-4 top-16 z-20 max-w-md rounded-md border border-beige-200 bg-beige-50/95 px-3 py-2 font-mono text-[10px] uppercase tracking-wide text-ink-700/65 shadow-sm">
          {t("graph:largeGraphMode")}
          {lowFpsDetected ? ` ${t("graph:largeGraphMode.lowFps")}` : ""}
        </div>
      ) : null}

      {loading ? (
        <div className="absolute inset-0 flex items-center justify-center bg-beige-100/50 z-10">
          <div className="flex flex-col items-center gap-3">
            <div className="w-10 h-10 border-2 border-[#586E75]/20 border-t-[#586E75] rounded-full animate-spin" />
            <p className="font-mono text-xs uppercase text-ink-600 tracking-widest">
              {t("graph:scanning")}
            </p>
          </div>
        </div>
      ) : null}

      {error ? (
        <div className="absolute inset-0 flex items-center justify-center z-10 p-8">
          <div className="bg-beige-50 border border-[#C9ADA7] p-4 rounded-md max-w-md">
            <h3 className="text-ink-600 font-bold mb-2 font-mono">{t("graph:loadError")}</h3>
            <p className="text-ink-700 text-sm font-mono">{error}</p>
          </div>
        </div>
      ) : null}

      {data ? (
        <div className="absolute bottom-4 left-4 z-20 flex items-center gap-2 rounded-md border border-beige-200 bg-beige-50/95 px-3 py-2 text-[10px] font-mono uppercase text-ink-700/55 shadow-sm">
          <span>
            {t("graph:meta.nodes", { shown: data.nodes.length, total: data.meta.nodeTotal })}
          </span>
          <span>·</span>
          <span>
            {t("graph:meta.edges", { shown: data.links.length, total: data.meta.edgeTotal })}
          </span>
          <span className="rounded-sm bg-[#586E75]/10 px-1.5 py-0.5 text-ink-700/65">
            {data.meta.truncated ||
            data.nodes.length < data.meta.nodeTotal ||
            data.links.length < data.meta.edgeTotal
              ? t("graph:meta.sampled")
              : t("graph:meta.complete")}
          </span>
        </div>
      ) : null}

      {data ? <OriginLegend /> : null}

      {data && effectiveMode === "3d" ? (
        <div className="absolute bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-md border border-beige-200 bg-beige-50/95 px-3 py-1.5 font-mono text-[10px] uppercase tracking-wide text-ink-700/55 shadow-sm">
          {t("graph:hint3d")}
        </div>
      ) : null}

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
            nodeLabel={formatGraphNodeTooltip}
            nodeCanvasObject={nodeCanvasObject}
            nodeCanvasObjectMode={() => "replace"}
            linkSource="source"
            linkTarget="target"
            linkColor={computeLinkColor}
            linkWidth={(l) => linkWidth(l.strength_normalized, l.weight)}
            linkCanvasObjectMode={() => "replace"}
            linkCanvasObject={linkCanvasObject}
            cooldownTicks={120}
            d3VelocityDecay={0.4}
            onEngineTick={() => handleGraphEngineTick("2d")}
            onNodeClick={handleNodeClick}
            onBackgroundClick={handleBackgroundClick}
          />
        ) : null}
        {data && effectiveMode === "3d" ? (
          <Suspense
            fallback={
              <div className="absolute inset-0 flex items-center justify-center">
                <p className="font-mono text-xs uppercase tracking-wider text-ink-700/40">
                  loading 3D engine…
                </p>
              </div>
            }
          >
            <ForceGraph3D
              ref={fg3dRef}
              graphData={data}
              width={viewport.width}
              height={viewport.height}
              backgroundColor="#FDF6E3"
              controlType="orbit"
              nodeId="id"
              nodeRelSize={4}
              nodeVal={(n) => nodeInfluenceSize(n)}
              nodeColor={computeNodeColor}
              nodeLabel={formatGraphNodeTooltip}
              nodeOpacity={0.92}
              linkSource="source"
              linkTarget="target"
              linkColor={computeLinkColor}
              linkWidth={(l) => linkWidth(l.strength_normalized, l.weight)}
              linkOpacity={0.85}
              linkDirectionalParticles={(l) =>
                largeGraphMode ? 0 : isRecentlyReinforced(l.last_reinforced_at, now) ? 2 : 0
              }
              linkDirectionalParticleSpeed={(l) =>
                0.005 + 0.012 * linkStrength(l.strength_normalized, l.weight)
              }
              linkDirectionalParticleWidth={2}
              cooldownTicks={largeGraphMode ? 60 : 120}
              d3VelocityDecay={largeGraphMode ? 0.55 : 0.4}
              onEngineTick={() => handleGraphEngineTick("3d")}
              onEngineStop={() => handleGraphEngineTick("3d")}
              onNodeClick={handleNodeClick}
              onBackgroundClick={handleBackgroundClick}
            />
          </Suspense>
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
  const { t } = useI18n();
  return (
    <div
      className="flex items-center gap-1 rounded-full border border-beige-200 bg-beige-50/95 p-1 shadow-sm"
      role="group"
      aria-label={t("graph:viewMode.label")}
    >
      <button
        type="button"
        onClick={() => onChange("2d")}
        className={`flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[10px] uppercase transition-colors ${
          mode === "2d" ? "bg-[#586E75] text-beige-50" : "text-ink-700/60 hover:text-ink-700"
        }`}
        aria-pressed={mode === "2d"}
      >
        <Square className="w-3 h-3" /> {t("graph:viewMode.2d")}
      </button>
      <button
        type="button"
        onClick={() => webglSupported && onChange("3d")}
        disabled={!webglSupported}
        className={`flex items-center gap-1 rounded-full px-2.5 py-1 font-mono text-[10px] uppercase transition-colors ${
          mode === "3d" ? "bg-[#586E75] text-beige-50" : "text-ink-700/60 hover:text-ink-700"
        } ${webglSupported ? "" : "cursor-not-allowed opacity-40"}`}
        aria-pressed={mode === "3d"}
        title={webglSupported ? undefined : t("graph:viewMode.unavailable")}
      >
        <Box className="w-3 h-3" /> {t("graph:viewMode.3d")}
      </button>
    </div>
  );
}

function OriginLegend() {
  const { t } = useI18n();
  const items: ReadonlyArray<{
    readonly kind: string;
    readonly labelKey: DictKey;
    readonly tipKey: DictKey;
    readonly glyph: string;
  }> = [
    { kind: "user_memory", labelKey: "graph:legend.user_memory", tipKey: "graph:legend.user_memory.tip", glyph: "U" },
    { kind: "engineering_chunk", labelKey: "graph:legend.engineering_chunk", tipKey: "graph:legend.engineering_chunk.tip", glyph: "E" },
    { kind: "reviewed_engineering_chunk", labelKey: "graph:legend.reviewed_engineering_chunk", tipKey: "graph:legend.reviewed_engineering_chunk.tip", glyph: "R" },
    { kind: "proposal_pending", labelKey: "graph:legend.proposal_pending", tipKey: "graph:legend.proposal_pending.tip", glyph: "P" },
    { kind: "system", labelKey: "graph:legend.system", tipKey: "graph:legend.system.tip", glyph: "S" }
  ];
  return (
    <div className="absolute bottom-4 right-4 z-20 flex flex-col gap-1 rounded-md border border-beige-200 bg-beige-50/95 px-3 py-2 text-[10px] font-mono uppercase text-ink-700/65 shadow-sm">
      {items.map((item) => {
        const label = t(item.labelKey);
        return (
          <div key={item.kind} className="flex items-center gap-2" title={t(item.tipKey)}>
            <span
              className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-bold text-beige-50"
              style={{ backgroundColor: ORIGIN_KIND_COLOR[item.kind] }}
              aria-label={`${label} (${item.glyph})`}
            >
              {item.glyph}
            </span>
            <span>{label}</span>
          </div>
        );
      })}
    </div>
  );
}

function formatGraphNodeTooltip(node: GraphNode): string {
  const lines = [node.label];
  if (node.summary) lines.push(node.summary);
  if (typeof node.influence_count === "number") lines.push(`influence: ${node.influence_count}`);
  if (node.last_used_at) lines.push(`last used: ${formatRelativeTime(node.last_used_at)}`);
  return lines.join("\n");
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
      ctx.rect(x - r, y - r, r * 2, r * 2);
      break;
    case "signal":
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y + r);
      ctx.lineTo(x - r, y + r);
      ctx.closePath();
      break;
    case "projection":
      ctx.moveTo(x, y - r);
      ctx.lineTo(x + r, y);
      ctx.lineTo(x, y + r);
      ctx.lineTo(x - r, y);
      ctx.closePath();
      break;
    case "memory":
    default:
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

function probeWebgl(): boolean {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return false;
  }
  try {
    const canvas = document.createElement("canvas");
    canvas.width = 2;
    canvas.height = 2;
    const gl =
      (canvas.getContext("webgl2") as WebGL2RenderingContext | null) ??
      (canvas.getContext("webgl") as WebGLRenderingContext | null);
    if (!gl) return false;
    const program = gl.createProgram();
    if (!program) return false;
    gl.deleteProgram(program);
    gl.clearColor(0.4, 0.6, 0.8, 1.0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    const pixel = new Uint8Array(4);
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, pixel);
    const matchesClear =
      Math.abs(pixel[0]! - 102) < 16 &&
      Math.abs(pixel[1]! - 153) < 16 &&
      Math.abs(pixel[2]! - 204) < 16;
    return matchesClear;
  } catch {
    return false;
  }
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
