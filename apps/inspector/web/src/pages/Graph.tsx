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
import { zoom } from "d3-zoom";
import { apiFetch, getWorkspaceId, type ApiError } from "../api";
import { useToasts } from "../components/Toast";
import type { SoulGraph } from "@do-soul/alaya-protocol";

interface GraphNode extends SimulationNodeDatum {
  id: string;
  kind: string;
  label: string;
  summary?: string;
  degree?: number;
}

interface GraphLink extends SimulationLinkDatum<GraphNode> {
  id: string;
  kind: string;
}

type SpotlightState = "match" | "adjacent" | "background";

const NODE_COLOR: Record<string, string> = {
  signal: "#96AD90",
  memory: "#92A8B3",
  scope: "#C9ADA7",
  projection: "#D4AF37"
};

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
        const result = await apiFetch<SoulGraph>(
          `/graph/${workspaceId ?? "default"}`
        );
        if (cancelled) return;
        const nodes: GraphNode[] = result.nodes.map((n) => ({ ...n }));
        const links: GraphLink[] = result.edges.map((e) => ({
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

  // Render D3 graph
  useEffect(() => {
    if (!data || !svgRef.current) return;
    const svgElement = svgRef.current;
    const width = svgElement.clientWidth;
    const height = svgElement.clientHeight;
    const svg = select(svgElement);
    svg.selectAll("*").remove();

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
      .attr("stdDeviation", "2")
      .attr("result", "blur");
    filter
      .append("feColorMatrix")
      .attr("in", "blur")
      .attr("mode", "matrix")
      .attr("values", "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7")
      .attr("result", "bleed");

    const g = svg.append("g");

    const simulation: Simulation<GraphNode, GraphLink> = forceSimulation<GraphNode>(
      data.nodes
    )
      .force(
        "link",
        forceLink<GraphNode, GraphLink>(data.links)
          .id((d) => d.id)
          .distance(100)
      )
      .force("charge", forceManyBody().strength(-400))
      .force("center", forceCenter(width / 2, height / 2))
      .force(
        "collision",
        forceCollide<GraphNode>().radius((d) => (d.degree ?? 1) * 3 + 25)
      )
      .velocityDecay(0.7);

    const link = g
      .append("g")
      .attr("stroke", "#93A1A1")
      .attr("stroke-opacity", 0.6)
      .selectAll<SVGLineElement, GraphLink>("line")
      .data(data.links)
      .join("line")
      .attr("stroke-width", () => Math.sqrt(2))
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
        select(this).select<SVGCircleElement>("circle").attr("r", function (d) {
          const datum = d as GraphNode;
          return ((datum.degree ?? 1) * 2 + 8) * 1.2;
        });
      })
      .on("mouseleave", function () {
        select(this).select<SVGCircleElement>("circle").attr("r", function (d) {
          const datum = d as GraphNode;
          return (datum.degree ?? 1) * 2 + 8;
        });
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

    nodeSel
      .append("circle")
      .attr("r", (d) => (d.degree ?? 1) * 2 + 8)
      .attr("fill", (d) => NODE_COLOR[d.kind] ?? "#586E75")
      .attr("filter", "url(#ink-bleed)");

    nodeSel
      .append("text")
      .attr("dy", (d) => (d.degree ?? 1) * 2 + 20)
      .attr("text-anchor", "middle")
      .attr("font-size", "10px")
      .attr("font-family", "monospace")
      .attr("fill", "#586E75")
      .text((d) => d.label);

    simulation.on("tick", () => {
      link
        .attr("x1", (d) => (d.source as GraphNode).x ?? 0)
        .attr("y1", (d) => (d.source as GraphNode).y ?? 0)
        .attr("x2", (d) => (d.target as GraphNode).x ?? 0)
        .attr("y2", (d) => (d.target as GraphNode).y ?? 0);
      nodeSel.attr("transform", (d) => `translate(${d.x ?? 0},${d.y ?? 0})`);
    });

    svg.call(
      zoom<SVGSVGElement, unknown>()
        .extent([
          [0, 0],
          [width, height]
        ])
        .scaleExtent([0.1, 4])
        .on("zoom", (event) => {
          g.attr("transform", event.transform);
        })
    );

    return () => {
      simulation.stop();
    };
  }, [data]);

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

function DetailDrawer({ node, onClose, onFocusSubgraph, onCopyCli }: DetailDrawerProps) {
  const cliCommand = node
    ? `alaya tools call --json soul.open_pointer '{"pointer_id":"${node.id}"}'`
    : "";

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
        <div className="h-full flex flex-col p-6 font-mono overflow-y-auto">
          <div className="flex justify-between items-start mb-8">
            <div className="flex flex-col">
              <span className="text-[10px] text-ink-700/60 uppercase tracking-widest mb-1">
                {node.kind}
              </span>
              <h2 className="text-xl font-bold text-ink-600 break-words">
                {node.label}
              </h2>
            </div>
            <button
              onClick={onClose}
              className="p-1 hover:bg-beige-200 rounded transition-colors"
              aria-label="Close detail drawer"
            >
              <X className="w-5 h-5 text-ink-700/40" />
            </button>
          </div>

          <div className="space-y-6 flex-1">
            <section>
              <h4 className="text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">
                Summary
              </h4>
              <p className="text-sm text-ink-700 leading-relaxed italic">
                "{node.summary ?? "No summary available for this node."}"
              </p>
            </section>

            <section>
              <h4 className="text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">
                Metadata
              </h4>
              <div className="bg-beige-100 p-3 rounded text-xs space-y-2">
                <div className="flex justify-between">
                  <span className="text-ink-700/60">ID:</span>
                  <span className="text-ink-700 select-all">{node.id}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-ink-700/60">Connections:</span>
                  <span className="text-ink-700">{node.degree ?? 0}</span>
                </div>
              </div>
            </section>

            <section>
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
          </div>

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

function extractId(endpoint: string | number | GraphNode): string {
  if (typeof endpoint === "string") return endpoint;
  if (typeof endpoint === "number") return String(endpoint);
  return endpoint.id;
}
