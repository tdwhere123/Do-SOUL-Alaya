import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from "react";
import { Copy, Search, Terminal, X } from "lucide-react";
import { clsx } from "clsx";
import { drag, type D3DragEvent } from "d3-drag";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  type Simulation,
  type SimulationLinkDatum,
  type SimulationNodeDatum
} from "d3-force";
import { select } from "d3-selection";
import { zoom, zoomIdentity } from "d3-zoom";
import { apiFetch, getWorkspaceId, type ApiError } from "../api";
import { useToasts } from "../components/Toast";
import type { SoulGraph } from "@do-soul/alaya-protocol";

interface GraphNode extends SimulationNodeDatum {
  id: string;
  kind: string;
  label: string;
  summary?: string;
  scope_id?: string;
  workspace_id?: string;
  created_at?: string;
  origin_plane?: "project" | "global";
  degree?: number;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  id: string;
  kind: string;
}

type SpotlightState = "match" | "adjacent" | "background";

interface SoulGraphEnvelope {
  readonly success: boolean;
  readonly data: SoulGraph;
}

const NODE_COLOR: Record<string, string> = {
  signal: "#96AD90",
  memory: "#92A8B3",
  scope: "#C9ADA7",
  projection: "#D4AF37"
};

// Caps degree-driven size variance so a 30-degree hub does not balloon to 70px.
function nodeRadius(d: GraphNode): number {
  return 8 + Math.min(6, Math.log2((d.degree ?? 0) + 1) * 2);
}

export default function GraphPage() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [data, setData] = useState<{ nodes: GraphNode[]; links: GraphLink[] } | null>(
    null
  );
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
        setData({ nodes, links });
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
    if (!data || !svgRef.current) return;
    const svgElement = svgRef.current;
    const svg = select(svgElement);

    let lastWidth = 0;
    let lastHeight = 0;
    let cleanup: (() => void) | null = null;

    const renderForBox = (width: number, height: number): (() => void) => {
      svg.selectAll("*").remove();

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
        .on("click", (event, d) => {
          setSelectedNode(d);
          event.stopPropagation();
        })
        .on("mouseenter", function () {
          select(this)
            .select<SVGCircleElement>("circle.node-body")
            .attr("stroke", "#586E75")
            .attr("stroke-width", 1.5);
        })
        .on("mouseleave", function () {
          select(this)
            .select<SVGCircleElement>("circle.node-body")
            .attr("stroke", "rgba(88,110,117,0.35)")
            .attr("stroke-width", 0.5);
        })
        .call(
          drag<SVGGElement, GraphNode>()
            .on("start", (event: D3DragEvent<SVGGElement, GraphNode, GraphNode>) => {
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

      simulation.on("tick", () => {
        link
          .attr("x1", (d) => (d.source as GraphNode).x ?? 0)
          .attr("y1", (d) => (d.source as GraphNode).y ?? 0)
          .attr("x2", (d) => (d.target as GraphNode).x ?? 0)
          .attr("y2", (d) => (d.target as GraphNode).y ?? 0);
        nodeSel.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
      });

      const zoomBehavior = zoom<SVGSVGElement, unknown>()
        .scaleExtent([0.05, 4])
        .on("zoom", (event) => {
          g.attr("transform", event.transform);
        });
      svg.call(zoomBehavior);

      let didFit = false;
      const fitToBounds = () => {
        if (didFit || data.nodes.length === 0) return;
        didFit = true;
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
          (width - padding * 2) / bboxW,
          (height - padding * 2) / bboxH
        );
        const scale = Math.max(0.2, Math.min(rawScale, 1.2));
        const cx = (minX + maxX) / 2;
        const cy = (minY + maxY) / 2;
        const tx = width / 2 - cx * scale;
        const ty = height / 2 - cy * scale;
        svg.call(zoomBehavior.transform, zoomIdentity.translate(tx, ty).scale(scale));
      };

      simulation.on("end", fitToBounds);
      // Fallback: if simulation never settles in 1.5s (cold rebuilds, large graphs),
      // fit anyway so the user is not stuck staring at an off-center cluster.
      const fitTimer = window.setTimeout(fitToBounds, 1500);

      return () => {
        window.clearTimeout(fitTimer);
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
    observer.observe(svgElement);

    const initialRect = svgElement.getBoundingClientRect();
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
    <div className="flex-1 relative flex overflow-hidden bg-[#FDF6E3]">
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

      <svg
        ref={svgRef}
        className="flex-1 w-full h-full"
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

interface DetailDrawerProps {
  readonly node: GraphNode | null;
  readonly onClose: () => void;
  readonly onFocusSubgraph: (id: string) => void;
  readonly onCopyCli: (text: string) => void;
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

function DetailDrawer({ node, onClose, onFocusSubgraph, onCopyCli }: DetailDrawerProps) {
  const cliCommand = node
    ? `alaya tools call --json soul.open_pointer '{"pointer_id":"${node.id}"}'`
    : "";
  const kindColor = node ? NODE_COLOR[node.kind] ?? "#586E75" : "#586E75";

  return (
    <div
      className={clsx(
        "absolute right-0 top-0 h-full w-96 bg-beige-50 border-l border-beige-200 shadow-2xl transition-transform duration-300 transform",
        node ? "translate-x-0" : "translate-x-full"
      )}
      role="complementary"
      aria-label="Node details"
    >
      {node ? (
        <div className="relative h-full flex flex-col p-6 pl-7 font-mono overflow-y-auto">
          <div
            className="absolute left-0 top-0 bottom-0 w-1"
            style={{ backgroundColor: kindColor }}
            aria-hidden
          />

          <div className="flex justify-between items-start mb-4">
            <div className="flex items-center gap-2 flex-wrap">
              <span
                className="px-2 py-0.5 text-[10px] uppercase tracking-widest rounded text-ink-700"
                style={{ backgroundColor: `${kindColor}33` }}
              >
                {node.kind}
              </span>
              {node.origin_plane === "global" ? (
                <span className="px-2 py-0.5 text-[10px] uppercase tracking-widest rounded bg-[#D4AF37]/20 text-[#7A5A0F]">
                  global
                </span>
              ) : null}
            </div>
            <button
              onClick={onClose}
              className="p-1 hover:bg-beige-200 rounded transition-colors -mr-1"
              aria-label="Close detail drawer"
            >
              <X className="w-5 h-5 text-ink-700/40" />
            </button>
          </div>

          <h2 className="text-lg font-bold text-ink-600 break-words leading-tight mb-5">
            {node.label}
          </h2>

          {node.summary ? (
            <section className="mb-6">
              <h4 className="text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">
                Summary
              </h4>
              <p className="text-sm text-ink-700 leading-relaxed whitespace-pre-wrap max-h-[36vh] overflow-y-auto pr-1">
                {node.summary}
              </p>
            </section>
          ) : null}

          <section className="mb-6">
            <h4 className="text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">
              Metadata
            </h4>
            <dl className="bg-beige-100 p-3 rounded text-xs grid grid-cols-[5rem_1fr_auto] gap-x-3 gap-y-2 items-baseline">
              <dt className="text-ink-700/60">id</dt>
              <dd className="text-ink-700 break-all select-all">{node.id}</dd>
              <button
                onClick={() => onCopyCli(node.id)}
                className="text-ink-700/40 hover:text-ink-700"
                aria-label="Copy node id"
              >
                <Copy className="w-3 h-3" />
              </button>

              <dt className="text-ink-700/60">scope</dt>
              <dd className="text-ink-700 break-all col-span-2">
                {node.scope_id ?? <span className="text-ink-700/30">—</span>}
              </dd>

              <dt className="text-ink-700/60">workspace</dt>
              <dd className="text-ink-700 break-all col-span-2">
                {node.workspace_id ?? <span className="text-ink-700/30">—</span>}
              </dd>

              <dt className="text-ink-700/60">created</dt>
              <dd className="text-ink-700 col-span-2" title={node.created_at}>
                {node.created_at ? (
                  formatRelativeTime(node.created_at)
                ) : (
                  <span className="text-ink-700/30">—</span>
                )}
              </dd>

              <dt className="text-ink-700/60">degree</dt>
              <dd className="text-ink-700 col-span-2">
                {node.degree ?? 0}{" "}
                <span className="text-ink-700/40">
                  connection{node.degree === 1 ? "" : "s"}
                </span>
              </dd>
            </dl>
          </section>

          <section className="mb-6">
            <h4 className="text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">
              Spotlight
            </h4>
            <button
              onClick={() => onFocusSubgraph(node.id)}
              className="text-xs font-mono text-ink-600 underline hover:text-ink-700"
            >
              Focus 1-hop subgraph around this node →
            </button>
          </section>

          <div className="mt-auto pt-6 border-t border-beige-200">
            <button
              onClick={() => onCopyCli(cliCommand)}
              className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-ink-600 text-beige-50 rounded hover:bg-ink-700 transition-colors text-xs font-bold uppercase tracking-widest"
            >
              <Terminal className="w-4 h-4" />
              Open in CLI
              <Copy className="w-3 h-3 ml-auto opacity-60" />
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function formatRelativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return iso;
  const diffMs = Date.now() - then;
  if (diffMs < 0) return "in the future";
  const sec = Math.round(diffMs / 1000);
  if (sec < 45) return "just now";
  const min = Math.round(sec / 60);
  if (min < 60) return `${min}m ago`;
  const hr = Math.round(min / 60);
  if (hr < 36) return `${hr}h ago`;
  const day = Math.round(hr / 24);
  if (day < 14) return `${day}d ago`;
  const wk = Math.round(day / 7);
  if (wk < 9) return `${wk}w ago`;
  const mo = Math.round(day / 30);
  if (mo < 12) return `${mo}mo ago`;
  const yr = Math.round(day / 365);
  return `${yr}y ago`;
}

function extractId(endpoint: string | number | GraphNode): string {
  if (typeof endpoint === "string") return endpoint;
  if (typeof endpoint === "number") return String(endpoint);
  return endpoint.id;
}
