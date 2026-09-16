import ForceGraph3D from "react-force-graph-3d";
import type { ForceGraphMethods as ForceGraphMethods3D } from "react-force-graph-3d";
import type { GraphLink, GraphNode } from "../../types/graph";
import { isRecentlyReinforced, linkStrength, linkWidth, nodeInfluenceSize } from "../../utils/graph";
import type { Graph3DHandle } from "./graph-physics-support";
import { formatGraphNodeTooltip } from "./support";
import type { GraphData } from "./types";

export interface GraphRenderer3DProps {
  readonly data: GraphData;
  readonly fg3dRef: React.MutableRefObject<Graph3DHandle | undefined>;
  readonly largeGraphMode: boolean;
  readonly onBackgroundClick: () => void;
  readonly onEngineTick: () => void;
  readonly onNodeClick: (node: GraphNode, event?: MouseEvent) => void;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly computeNodeColor: (node: GraphNode) => string;
  readonly computeLinkColor: (link: GraphLink) => string;
  readonly now: number;
}

export default function GraphRenderer3D(props: GraphRenderer3DProps) {
  return (
    <ForceGraph3D
      ref={
        // Library ref type stays in this 3D leaf so 2D modules stay uncoupled.
        props.fg3dRef as React.MutableRefObject<
          ForceGraphMethods3D<GraphNode, GraphLink> | undefined
        >
      }
      graphData={props.data}
      width={props.viewport.width}
      height={props.viewport.height}
      backgroundColor="#FDF6E3"
      controlType="orbit"
      nodeId="id"
      nodeRelSize={4}
      nodeVal={(node) => nodeInfluenceSize(node)}
      nodeColor={props.computeNodeColor}
      nodeLabel={formatGraphNodeTooltip}
      nodeOpacity={0.92}
      linkSource="source"
      linkTarget="target"
      linkColor={props.computeLinkColor}
      linkWidth={(link) => linkWidth(link.strength_normalized, link.weight)}
      linkOpacity={0.85}
      linkDirectionalParticles={(link) =>
        linkDirectionalParticles(link, props.largeGraphMode, props.now)
      }
      linkDirectionalParticleSpeed={(link) =>
        0.005 + 0.012 * linkStrength(link.strength_normalized, link.weight)
      }
      linkDirectionalParticleWidth={2}
      cooldownTicks={props.largeGraphMode ? 60 : 120}
      d3VelocityDecay={props.largeGraphMode ? 0.55 : 0.4}
      onEngineTick={props.onEngineTick}
      onEngineStop={props.onEngineTick}
      onNodeClick={props.onNodeClick}
      onBackgroundClick={props.onBackgroundClick}
    />
  );
}

function linkDirectionalParticles(link: GraphLink, largeGraphMode: boolean, now: number): number {
  if (largeGraphMode) return 0;
  return isRecentlyReinforced(link.last_reinforced_at, now) ? 2 : 0;
}
