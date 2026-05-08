import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Search, X } from "lucide-react";
import { drag, type D3DragEvent } from "d3-drag";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
} from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity } from "d3-zoom";
import { apiFetch, getWorkspaceId, type ApiError } from "../api";
import { useToasts } from "../components/Toast";
import { DetailDrawer } from "../components/DetailDrawer";
import type { GraphNode, GraphLink, SpotlightState } from "../types/graph";
import { extractId, nodeRadius, NODE_COLOR } from "../utils/graph";
import type { SoulGraph } from "@do-soul/alaya-protocol";

interface SoulGraphEnvelope {
  readonly success: boolean;
  readonly data: SoulGraph;
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

const LARGE_GRAPH_LABEL_THRESHOLD = 80;
const TOP_DEGREE_LABEL_LIMIT = 24;

export default function GraphPage() {
  const viewportRef = useRef<HTMLDivElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const userInteractedRef = useRef(false);
  const [data, setData] = useState<GraphData | null>(null);
  const [selectedNode, setSelectedNode] = useState<GraphNode | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [searchTerm, setSearchTerm] = useState("");
  const [matchCursor, setMatchCursor] = useState(0);
  const searchInputRef = useRef<HTMLInputElement | null>(null);
  const { showToast } = useToasts();

  const workspaceId = getWorkspaceId();

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
          target: e.target_id
        }));
        nodes.forEach((n) => {
          n.degree = links.filter(
            (l) => extractId(l.source) === n.id || extractId(l.target) === n.id
          ).length;
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

  // Render D3 graph: rebuild on data change OR container resize, then fit-to-bounds.
  useEffect(() => {
    if (!data || !viewportRef.current || !svgRef.current) return;
    userInteractedRef.current = false;
    const viewportElement = viewportRef.current;
    const svgElement = svgRef.current;
    const svg = select(svgElement);

    let lastWidth = 0;
    let lastHeight = 0;
    let cleanup: (() => void) | null = null;

    const renderForBox = (width: number, height: number): (() => void) => {
      svg.selectAll("*").remove();

      // viewBox normalises the SVG user-coordinate system to the simulation's
      // width×height. Without it, user coords equal CSS pixels — so a sim
      // centred at (width/2,height/2) ends up in the upper-left quadrant of a
      // larger rendered SVG. preserveAspectRatio="xMidYMid meet" centres the
      // viewBox visually with letterbox bands when aspect ratios disagree.
      svg
        .attr("viewBox", `0 0 ${width} ${height}`)
        .attr("width", width)
        .attr("height", height)
        .attr("preserveAspectRatio", "xMidYMid meet")
        .attr(
          "data-large-graph",
          data.nodes.length > LARGE_GRAPH_LABEL_THRESHOLD ? "true" : "false"
        );

      // Softened ink-bleed: keeps the paper aesthetic but stops drowning edges.
      const defs = svg.append("defs");
      const filter = defs
        .append("filter")
        .attr("id", "ink-bleed")
        .attr("x", "-20%")
        .attr("y", "-20%")
        .attr("width", "140%")
        .attr("height", "140%");
      filter
        .append("feGaussianBlur")
        .attr("in", "SourceGraphic")
        .attr("stdDeviation", "0.6")
        .attr("result", "blur");
      filter
        .append("feColorMatrix")
        .attr("in", "blur")
        .attr("mode", "matrix")
        .attr("values", "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 14 -5")
        .attr("result", "bleed");

      const g = svg.append("g");

      const simulation: Simulation<GraphNode, GraphLink> = forceSimulation<GraphNode>(
        data.nodes
      )
        .force(
          "link",
          forceLink<GraphNode, GraphLink>(data.links)
            .id((d) => d.id)
            .distance(110)
        )
        .force("charge", forceManyBody().strength(-450))
        .force("center", forceCenter(width / 2, height / 2))
        .force(
          "collision",
          forceCollide<GraphNode>().radius((d) => nodeRadius(d) + 18)
        )
        .velocityDecay(0.7);
      simulation.stop();
      for (let i = 0; i < preTickCount(data.nodes.length, data.links.length); i += 1) {
        simulation.tick();
      }

      const isLargeGraph = data.nodes.length > LARGE_GRAPH_LABEL_THRESHOLD;
      const defaultLabelIds = selectDefaultLabelNodeIds(
        data.nodes,
        isLargeGraph ? TOP_DEGREE_LABEL_LIMIT : data.nodes.length
      );

      const link = g
        .append("g")
        .attr("stroke", "#93A1A1")
        .attr("stroke-opacity", 0.55)
        .selectAll<SVGLineElement, GraphLink>("line")
        .data(data.links)
        .join("line")
        .attr("stroke-width", 1.2)
        .attr("data-edge-id", (d) => d.id);

      const nodeSel = g
        .append("g")
        .selectAll<SVGGElement, GraphNode>("g")
        .data(data.nodes)
        .join("g")
        .attr("class", "cursor-pointer")
        .attr("data-node-id", (d) => d.id)
        .attr("data-hovered", "false")
        .attr("data-label-visible", (d) => (defaultLabelIds.has(d.id) ? "true" : "false"))
        .on("click", (event, d) => {
          setSelectedNode(d);
          event.stopPropagation();
        })
        .on("mouseenter", function () {
          select(this).attr("data-hovered", "true");
          select(this)
            .select<SVGCircleElement>("circle.node-body")
            .attr("stroke", "#586E75")
            .attr("stroke-width", 1.5);
        })
        .on("mouseleave", function () {
          select(this).attr("data-hovered", "false");
          select(this)
            .select<SVGCircleElement>("circle.node-body")
            .attr("stroke", "rgba(88,110,117,0.35)")
            .attr("stroke-width", 0.5);
        })
        .call(
          drag<SVGGElement, GraphNode>()
            .on("start", (event: D3DragEvent<SVGGElement, GraphNode, GraphNode>) => {
              userInteractedRef.current = true;
              if (!event.active) simulation.alphaTarget(0.3).restart();
              event.subject.fx = event.subject.x;
              event.subject.fy = event.subject.y;
            })
            .on("drag", (event: D3DragEvent<SVGGElement, GraphNode, GraphNode>) => {
              event.subject.fx = event.x;
              event.subject.fy = event.y;
            })
            .on("end", (event: D3DragEvent<SVGGElement, GraphNode, GraphNode>) => {
              if (!event.active) simulation.alphaTarget(0);
              event.subject.fx = null;
              event.subject.fy = null;
            })
        );

      // Selection ring (toggled via [data-selected="true"] CSS rule).
      nodeSel
        .append("circle")
        .attr("class", "node-ring")
        .attr("r", (d) => nodeRadius(d) + 4)
        .attr("fill", "none")
        .attr("stroke", (d) => NODE_COLOR[d.kind] ?? "#586E75")
        .attr("stroke-width", 1.4)
        .attr("stroke-dasharray", "3 2");

      nodeSel
        .append("circle")
        .attr("class", "node-body")
        .attr("r", (d) => nodeRadius(d))
        .attr("fill", (d) => NODE_COLOR[d.kind] ?? "#586E75")
        .attr("stroke", "rgba(88,110,117,0.35)")
        .attr("stroke-width", 0.5)
        .attr("filter", "url(#ink-bleed)");

      // Paper-color stroke around label so it stays readable on top of any node color.
      nodeSel
        .append("text")
        .attr("class", "node-label")
        .attr("dy", (d) => nodeRadius(d) + 14)
        .attr("text-anchor", "middle")
        .attr("font-size", "11px")
        .attr("font-family", "ui-monospace, SFMono-Regular, Menlo, monospace")
        .attr("fill", "#586E75")
        .style("paint-order", "stroke fill")
        .style("stroke", "#FDF6E3")
        .style("stroke-width", "3.5px")
        .style("stroke-linejoin", "round")
        .text((d) => d.label);

      const updatePositions = () => {
        link
          .attr("x1", (d) => (d.source as GraphNode).x ?? 0)
          .attr("y1", (d) => (d.source as GraphNode).y ?? 0)
          .attr("x2", (d) => (d.target as GraphNode).x ?? 0)
          .attr("y2", (d) => (d.target as GraphNode).y ?? 0);
        nodeSel.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
      };

      const zoomBehavior = zoom<SVGSVGElement, unknown>()
        .extent([
          [0, 0],
          [width, height]
        ])
        .scaleExtent([0.05, 4])
        .on("zoom", (event) => {
          if (event.sourceEvent != null) {
            userInteractedRef.current = true;
          }
          g.attr("transform", event.transform);
        });
      svg.call(zoomBehavior);

      const fitToBounds = () => {
        if (userInteractedRef.current || data.nodes.length === 0) return;
        let minX = Infinity;
        let maxX = -Infinity;
        let minY = Infinity;
        let maxY = -Infinity;
        for (const n of data.nodes) {
          const x = n.x ?? 0;
          const y = n.y ?? 0;
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
        const padding = 60;
        const bboxW = Math.max(maxX - minX, 1);
        const bboxH = Math.max(maxY - minY, 1);
        const rawScale = Math.min(
          Math.max(width - padding * 2, 1) / bboxW,
          Math.max(height - padding * 2, 1) / bboxH
        );
        const scale = Math.max(0.2, Math.min(rawScale, 1.2));
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const tx = width / 2 - cx * scale;
        const ty = height / 2 - cy * scale;
        svg.call(zoomBehavior.transform, zoomIdentity.translate(tx, ty).scale(scale));
      };

      updatePositions();
      fitToBounds();
      simulation.on("tick", updatePositions);

      return () => {
        simulation.stop();
      };
    };

    const ensureRender = (rawWidth: number, rawHeight: number) => {
      // Headless contexts (jsdom, SSR) report 0×0; downstream effects still need
      // a populated SVG, so fall back to a sane viewport-sized box.
      const width = rawWidth > 0 ? rawWidth : 800;
      const height = rawHeight > 0 ? rawHeight : 600;
      if (
        Math.abs(width - lastWidth) < 1 &&
        Math.abs(height - lastHeight) < 1
      )
        return;
      lastWidth = width;
      lastHeight = height;
      cleanup?.();
      cleanup = renderForBox(width, height);
    };

    const observer = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (!rect) return;
      ensureRender(rect.width, rect.height);
    });
    observer.observe(viewportElement);

    const initialRect = viewportElement.getBoundingClientRect();
    ensureRender(initialRect.width, initialRect.height);

    return () => {
      observer.disconnect();
      cleanup?.();
    };
  }, [data]);

  // Selection: reflect React state onto graph DOM via [data-selected].
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = select(svgRef.current);
    svg
      .selectAll<SVGGElement, GraphNode>("g[data-node-id]")
      .attr("data-selected", function () {
        const id = (this as SVGGElement).getAttribute("data-node-id") ?? "";
        return selectedNode?.id === id ? "true" : "false";
      });
  }, [selectedNode]);

  // Spotlight: apply match/adjacent/background classes to existing nodes/edges
  useEffect(() => {
    if (!svgRef.current) return;
    const svg = select(svgRef.current);
    const nodeIdState = (id: string): SpotlightState => {
      if (!spotlightActive) return "match";
      if (matchIds.has(id)) return "match";
      if (adjacentIds.has(id)) return "adjacent";
      return "background";
    };
    svg
      .selectAll<SVGGElement, GraphNode>("g[data-node-id]")
      .attr("data-state", function () {
        const id = (this as SVGGElement).getAttribute("data-node-id") ?? "";
        return nodeIdState(id);
      });
    svg.selectAll<SVGLineElement, GraphLink>("line[data-edge-id]").attr(
      "data-state",
      function (d) {
        if (!spotlightActive) return "match";
        const a = extractId(d.source);
        const b = extractId(d.target);
        const aMatch = matchIds.has(a);
        const bMatch = matchIds.has(b);
        if (aMatch && bMatch) return "match";
        if (aMatch || bMatch) return "adjacent";
        return "background";
      }
    );
  }, [matchIds, adjacentIds, spotlightActive]);

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

  const copyToClipboard = useCallback(
    (text: string) => {
      void navigator.clipboard.writeText(text);
      showToast({ message: "copied to clipboard", type: "success", duration: 2500 });
    },
    [showToast]
  );

  return (
    <div
      ref={viewportRef}
      data-graph-viewport="true"
      className="flex-1 min-h-0 relative overflow-hidden bg-[#FDF6E3]"
    >
      {/* Search overlay */}
      <div className="absolute top-4 left-1/2 -translate-x-1/2 z-20 flex items-center gap-3 bg-beige-50/95 backdrop-blur-sm border border-beige-200 rounded-full px-4 py-2 shadow-sm">
        <Search className="w-3 h-3 text-ink-700/40" />
        <input
          ref={searchInputRef}
          type="text"
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
          placeholder="probe label / id / summary  (press /)"
          className="bg-transparent outline-none text-xs font-mono text-ink-700 placeholder:text-ink-700/30 w-[280px]"
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

      <svg
        ref={svgRef}
        className="absolute inset-0 block h-full w-full"
        data-spotlight-active={spotlightActive ? "true" : "false"}
        data-focused-match={focusedMatchId ?? ""}
        onClick={() => setSelectedNode(null)}
        onContextMenu={(e) => e.preventDefault()}
      />

      <DetailDrawer
        node={selectedNode}
        onClose={() => setSelectedNode(null)}
        onFocusSubgraph={(id) => setSearchTerm(id)}
        onCopyCli={copyToClipboard}
      />
    </div>
  );
}

function preTickCount(nodeCount: number, edgeCount: number): number {
  const graphSize = nodeCount + edgeCount;
  if (graphSize > 1500) return 240;
  if (graphSize > 500) return 180;
  if (graphSize > 150) return 120;
  return 80;
}

function selectDefaultLabelNodeIds(nodes: readonly GraphNode[], limit: number): Set<string> {
  if (limit >= nodes.length) {
    return new Set(nodes.map((node) => node.id));
  }
  return new Set(
    [...nodes]
      .sort((a, b) => {
        const degreeDelta = (b.degree ?? 0) - (a.degree ?? 0);
        if (degreeDelta !== 0) return degreeDelta;
        return a.label.localeCompare(b.label);
      })
      .slice(0, limit)
      .map((node) => node.id)
  );
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
