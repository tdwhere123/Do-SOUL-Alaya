import { Suspense, lazy } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { ForceGraphMethods as ForceGraphMethods2D } from "react-force-graph-2d";
import type ForceGraph3DType from "react-force-graph-3d";
import type { ForceGraphMethods as ForceGraphMethods3D } from "react-force-graph-3d";
import { useI18n } from "../../i18n/Locale";
import type { GraphLink, GraphNode, SpotlightState } from "../../types/graph";
import { isRecentlyReinforced, linkStrength, linkWidth, nodeInfluenceSize } from "../../utils/graph";
import { formatGraphNodeTooltip } from "./support";
import type { GraphData, ViewMode } from "./types";
import { useGraphRendererStyles } from "./useGraphRendererStyles";

const ForceGraph3D = lazy(() => import("react-force-graph-3d")) as unknown as typeof ForceGraph3DType;

interface GraphRendererProps {
  readonly data: GraphData;
  readonly effectiveMode: ViewMode;
  readonly fg2dRef: React.MutableRefObject<ForceGraphMethods2D<GraphNode, GraphLink> | undefined>;
  readonly fg3dRef: React.MutableRefObject<ForceGraphMethods3D<GraphNode, GraphLink> | undefined>;
  readonly largeGraphMode: boolean;
  readonly matchIds: ReadonlySet<string>;
  readonly nodeSpotlightState: (id: string) => SpotlightState;
  readonly onBackgroundClick: () => void;
  readonly onEngineTick: (mode: ViewMode) => void;
  readonly onNodeClick: (node: GraphNode, event?: MouseEvent) => void;
  readonly selectedNode: GraphNode | null;
  readonly spotlightActive: boolean;
  readonly viewport: { readonly width: number; readonly height: number };
}

export default function GraphRenderer(props: GraphRendererProps) {
  const styles = useGraphRendererStyles({
    matchIds: props.matchIds,
    nodeSpotlightState: props.nodeSpotlightState,
    selectedNode: props.selectedNode,
    spotlightActive: props.spotlightActive
  });
  return (
    <div className="absolute inset-0" data-spotlight-active={props.spotlightActive ? "true" : "false"}>
      {props.effectiveMode === "2d" ? <GraphRenderer2D {...props} styles={styles} /> : null}
      {props.effectiveMode === "3d" ? <GraphRenderer3D {...props} styles={styles} /> : null}
    </div>
  );
}

function GraphRenderer2D(props: GraphRendererProps & { readonly styles: ReturnType<typeof useGraphRendererStyles> }) {
  return (
    <ForceGraph2D
      ref={props.fg2dRef}
      graphData={props.data}
      width={props.viewport.width}
      height={props.viewport.height}
      backgroundColor="#FDF6E3"
      nodeId="id"
      nodeRelSize={1}
      nodeVal={(node) => nodeInfluenceSize(node) * nodeInfluenceSize(node)}
      nodeColor={props.styles.computeNodeColor}
      nodeLabel={formatGraphNodeTooltip}
      nodeCanvasObject={props.styles.nodeCanvasObject}
      nodeCanvasObjectMode={() => "replace"}
      linkSource="source"
      linkTarget="target"
      linkColor={props.styles.computeLinkColor}
      linkWidth={(link) => linkWidth(link.strength_normalized, link.weight)}
      linkCanvasObjectMode={() => "replace"}
      linkCanvasObject={props.styles.linkCanvasObject}
      cooldownTicks={120}
      d3VelocityDecay={0.4}
      onEngineTick={() => props.onEngineTick("2d")}
      onNodeClick={props.onNodeClick}
      onBackgroundClick={props.onBackgroundClick}
    />
  );
}

function GraphRenderer3D(props: GraphRendererProps & { readonly styles: ReturnType<typeof useGraphRendererStyles> }) {
  const { t } = useI18n();
  return (
    <Suspense fallback={<Graph3DFallback label={t("graph:viewMode.3d")} />}>
      <ForceGraph3D
        ref={props.fg3dRef}
        graphData={props.data}
        width={props.viewport.width}
        height={props.viewport.height}
        backgroundColor="#FDF6E3"
        controlType="orbit"
        nodeId="id"
        nodeRelSize={4}
        nodeVal={(node) => nodeInfluenceSize(node)}
        nodeColor={props.styles.computeNodeColor}
        nodeLabel={formatGraphNodeTooltip}
        nodeOpacity={0.92}
        linkSource="source"
        linkTarget="target"
        linkColor={props.styles.computeLinkColor}
        linkWidth={(link) => linkWidth(link.strength_normalized, link.weight)}
        linkOpacity={0.85}
        linkDirectionalParticles={(link) => linkDirectionalParticles(link, props.largeGraphMode, props.styles.now)}
        linkDirectionalParticleSpeed={(link) => 0.005 + 0.012 * linkStrength(link.strength_normalized, link.weight)}
        linkDirectionalParticleWidth={2}
        cooldownTicks={props.largeGraphMode ? 60 : 120}
        d3VelocityDecay={props.largeGraphMode ? 0.55 : 0.4}
        onEngineTick={() => props.onEngineTick("3d")}
        onEngineStop={() => props.onEngineTick("3d")}
        onNodeClick={props.onNodeClick}
        onBackgroundClick={props.onBackgroundClick}
      />
    </Suspense>
  );
}

function Graph3DFallback({ label }: { readonly label: string }) {
  return (
    <div className="absolute inset-0 flex items-center justify-center">
      <p className="font-mono text-xs uppercase tracking-wider text-ink-700/40">
        {label} loading…
      </p>
    </div>
  );
}

function linkDirectionalParticles(link: GraphLink, largeGraphMode: boolean, now: number): number {
  if (largeGraphMode) return 0;
  return isRecentlyReinforced(link.last_reinforced_at, now) ? 2 : 0;
}
