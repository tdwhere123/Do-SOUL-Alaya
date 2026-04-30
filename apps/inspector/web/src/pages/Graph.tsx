import { useEffect, useRef, useState, useMemo } from 'react';
import * as d3 from 'd3';
import { apiFetch, getWorkspaceId } from '../api';
import { Terminal, Copy, X } from 'lucide-react';
import { clsx } from 'clsx';

interface Node extends d3.SimulationNodeDatum {
  id: string;
  kind: string;
  label: string;
  summary?: string;
  degree?: number;
}

interface Link extends d3.SimulationLinkDatum<Node> {
  id: string;
  kind: string;
}

export default function GraphPage() {
  const svgRef = useRef<SVGSVGElement>(null);
  const [data, setData] = useState<{ nodes: Node[]; links: Link[] } | null>(null);
  const [selectedNode, setSelectedNode] = useState<Node | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const workspaceId = getWorkspaceId();

  useEffect(() => {
    const fetchData = async () => {
      try {
        setLoading(true);
        const workspaceIdToUse = workspaceId || 'default';
        const result = await apiFetch<any>(`/graph/${workspaceIdToUse}`);
        
        // Map data to D3 format
        const nodes: Node[] = result.nodes.map((n: any) => ({ ...n }));
        const links: Link[] = result.edges.map((e: any) => ({
          ...e,
          source: e.source_id,
          target: e.target_id
        }));

        // Calculate degree for sizing
        nodes.forEach(n => {
          n.degree = links.filter(l => l.source === n.id || l.target === n.id).length;
        });

        setData({ nodes, links });
      } catch (err: any) {
        setError(err.message);
      } finally {
        setLoading(false);
      }
    };

    fetchData();
  }, [workspaceId]);

  useEffect(() => {
    if (!data || !svgRef.current) return;

    const width = svgRef.current.clientWidth;
    const height = svgRef.current.clientHeight;

    const svg = d3.select(svgRef.current);
    svg.selectAll("*").remove();

    // Define Ink Bleed Filter
    const defs = svg.append("defs");
    const filter = defs.append("filter")
      .attr("id", "ink-bleed")
      .attr("x", "-20%")
      .attr("y", "-20%")
      .attr("width", "140%")
      .attr("height", "140%");

    filter.append("feGaussianBlur")
      .attr("in", "SourceGraphic")
      .attr("stdDeviation", "2")
      .attr("result", "blur");

    filter.append("feColorMatrix")
      .attr("in", "blur")
      .attr("mode", "matrix")
      .attr("values", "1 0 0 0 0  0 1 0 0 0  0 0 1 0 0  0 0 0 18 -7")
      .attr("result", "bleed");

    const g = svg.append("g");

    const simulation = d3.forceSimulation<Node>(data.nodes)
      .force("link", d3.forceLink<Node, Link>(data.links).id(d => d.id).distance(100))
      .force("charge", d3.forceManyBody().strength(-400))
      .force("center", d3.forceCenter(width / 2, height / 2))
      .force("collision", d3.forceCollide().radius((d: any) => (d.degree || 1) * 3 + 25))
      .velocityDecay(0.7); // High viscosity for "liquid" feel

    const link = g.append("g")
      .attr("stroke", "#93A1A1")
      .attr("stroke-opacity", 0.6)
      .selectAll("line")
      .data(data.links)
      .join("line")
      .attr("stroke-width", d => Math.sqrt(2));

    const node = g.append("g")
      .selectAll("g")
      .data(data.nodes)
      .join("g")
      .attr("class", "cursor-pointer")
      .on("click", (event, d) => {
        setSelectedNode(d);
        event.stopPropagation();
      })
      .call(d3.drag<any, Node>()
        .on("start", dragstarted)
        .on("drag", dragged)
        .on("end", dragended) as any);

    // Morandi palette mapping
    const colorMap: Record<string, string> = {
      signal: "#96AD90", // Sage
      memory: "#92A8B3", // Steel Blue
      scope: "#C9ADA7",   // Dusty Rose
      projection: "#D4AF37" // Dark Gold
    };

    node.append("circle")
      .attr("r", d => (d.degree || 1) * 2 + 8)
      .attr("fill", d => colorMap[d.kind] || "#586E75")
      .attr("filter", "url(#ink-bleed)");

    node.append("text")
      .attr("dy", d => (d.degree || 1) * 2 + 20)
      .attr("text-anchor", "middle")
      .attr("font-size", "10px")
      .attr("font-family", "monospace")
      .attr("fill", "#586E75")
      .text(d => d.label);

    simulation.on("tick", () => {
      link
        .attr("x1", (d: any) => d.source.x)
        .attr("y1", (d: any) => d.source.y)
        .attr("x2", (d: any) => d.target.x)
        .attr("y2", (d: any) => d.target.y);

      node
        .attr("transform", (d: any) => `translate(${d.x},${d.y})`);
    });

    svg.call(d3.zoom<SVGSVGElement, unknown>()
      .extent([[0, 0], [width, height]])
      .scaleExtent([0.1, 4])
      .on("zoom", (event) => {
        g.attr("transform", event.transform);
      }));

    function dragstarted(event: any) {
      if (!event.active) simulation.alphaTarget(0.3).restart();
      event.subject.fx = event.subject.x;
      event.subject.fy = event.subject.y;
    }

    function dragged(event: any) {
      event.subject.fx = event.x;
      event.subject.fy = event.y;
    }

    function dragended(event: any) {
      if (!event.active) simulation.alphaTarget(0);
      event.subject.fx = null;
      event.subject.fy = null;
    }

    return () => { simulation.stop(); };
  }, [data]);

  const copyToClipboard = (text: string) => {
    navigator.clipboard.writeText(text);
    // Could show a small toast here if available
  };

  return (
    <div className="flex-1 relative flex overflow-hidden bg-[#FDF6E3]">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center bg-beige-100/50 z-10">
          <p className="font-mono text-xs uppercase animate-pulse">Scanning Memory Fabric...</p>
        </div>
      )}
      
      {error && (
        <div className="absolute inset-0 flex items-center justify-center z-10 p-8">
          <div className="bg-red-50 border border-red-200 p-4 rounded-md max-w-md">
            <h3 className="text-red-800 font-bold mb-2">Graph Error</h3>
            <p className="text-red-600 text-sm font-mono">{error}</p>
          </div>
        </div>
      )}

      <svg 
        ref={svgRef} 
        className="flex-1 w-full h-full"
        onClick={() => setSelectedNode(null)}
      />

      {/* Detail Drawer */}
      <div className={clsx(
        "absolute right-0 top-0 h-full w-96 bg-beige-50 border-l border-beige-200 shadow-2xl transition-transform duration-500 transform",
        selectedNode ? "translate-x-0" : "translate-x-full"
      )}>
        {selectedNode && (
          <div className="h-full flex flex-col p-6 font-mono overflow-y-auto">
            <div className="flex justify-between items-start mb-8">
              <div className="flex flex-col">
                <span className="text-[10px] text-ink-700/60 uppercase tracking-widest mb-1">{selectedNode.kind}</span>
                <h2 className="text-xl font-bold text-ink-600 break-words">{selectedNode.label}</h2>
              </div>
              <button 
                onClick={() => setSelectedNode(null)}
                className="p-1 hover:bg-beige-200 rounded transition-colors"
              >
                <X className="w-5 h-5 text-ink-700/40" />
              </button>
            </div>

            <div className="space-y-6 flex-1">
              <section>
                <h4 className="text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">Summary</h4>
                <p className="text-sm text-ink-700 leading-relaxed italic">
                  "{selectedNode.summary || 'No summary available for this node.'}"
                </p>
              </section>

              <section>
                <h4 className="text-[10px] uppercase text-ink-700/40 mb-2 tracking-widest">Metadata</h4>
                <div className="bg-beige-100 p-3 rounded text-xs space-y-2">
                  <div className="flex justify-between">
                    <span className="text-ink-700/60">ID:</span>
                    <span className="text-ink-700 select-all">{selectedNode.id}</span>
                  </div>
                  <div className="flex justify-between">
                    <span className="text-ink-700/60">Connections:</span>
                    <span className="text-ink-700">{selectedNode.degree}</span>
                  </div>
                </div>
              </section>
            </div>

            <div className="mt-auto pt-6 border-t border-beige-200">
              <button 
                onClick={() => copyToClipboard(`alaya tools call --json soul.open_pointer --args '{"id": "${selectedNode.id}"}'`)}
                className="w-full flex items-center justify-center gap-2 py-3 px-4 bg-ink-600 text-beige-50 rounded hover:bg-ink-700 transition-colors text-xs font-bold uppercase tracking-widest"
              >
                <Terminal className="w-4 h-4" />
                Open in CLI
                <Copy className="w-3 h-3 ml-auto opacity-60" />
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
