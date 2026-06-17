import { Suspense, lazy, useCallback, useEffect, useState } from "react";
import ForceGraph2D from "react-force-graph-2d";
import type { ForceGraphMethods as ForceGraphMethods2D } from "react-force-graph-2d";
import type ForceGraph3DType from "react-force-graph-3d";
import type { ForceGraphMethods as ForceGraphMethods3D } from "react-force-graph-3d";
import { useI18n } from "../../i18n/Locale";
import type { GraphLink, GraphNode, SpotlightState } from "../../types/graph";
import {
  EDGE_TYPE_BASE_COLOR,
  NODE_KIND_BASE_COLOR,
  STABILITY_DASH,
  extractId,
  isRecentlyReinforced,
  linkAlpha,
  linkStrength,
  linkWidth,
  nodeInfluenceSize,
  recencyAlpha,
  rgba
} from "../../utils/graph";
import {
  drawNodeShape,
  formatGraphNodeTooltip
} from "./support";
import type { GraphData, ViewMode } from "./types";

const ForceGraph3D = lazy(() => import("react-force-graph-3d")) as unknown as typeof ForceGraph3DType;

const DEFAULT_NODE_FALLBACK_COLOR = "#586E75";
const SPOTLIGHT_BG_ALPHA = 0.12;
const SPOTLIGHT_ADJ_ALPHA = 0.55;
const REINFORCED_GLOW_ALPHA = 0.95;

interface GraphRendererProps {
  readonly data: GraphData;
  readonly effectiveMode: ViewMode;
  readonly fg2dRef: React.MutableRefObject<
    ForceGraphMethods2D<GraphNode, GraphLink> | undefined
  >;
  readonly fg3dRef: React.MutableRefObject<
    ForceGraphMethods3D<GraphNode, GraphLink> | undefined
  >;
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

export default function GraphRenderer({
  data,
  effectiveMode,
  fg2dRef,
  fg3dRef,
  largeGraphMode,
  matchIds,
  nodeSpotlightState,
  onBackgroundClick,
  onEngineTick,
  onNodeClick,
  selectedNode,
  spotlightActive,
  viewport
}: GraphRendererProps) {
  const { t } = useI18n();
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    const timerId = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timerId);
  }, []);

  const computeNodeColor = useCallback(
    (node: GraphNode): string => {
      const baseHex = NODE_KIND_BASE_COLOR[node.kind] ?? DEFAULT_NODE_FALLBACK_COLOR;
      const rgb = hexToRgb(baseHex);
      const recency = recencyAlpha(node.last_used_at, now);
      const state = nodeSpotlightState(node.id);
      let alpha = recency;
      if (state === "background") alpha = SPOTLIGHT_BG_ALPHA;
      else if (state === "adjacent") alpha = Math.min(recency, SPOTLIGHT_ADJ_ALPHA);
      return rgba(rgb, alpha);
    },
    [nodeSpotlightState, now]
  );

  const computeLinkColor = useCallback(
    (link: GraphLink): string => {
      const rgb = EDGE_TYPE_BASE_COLOR[link.kind] ?? [147, 161, 161];
      const baseAlpha = linkAlpha(link.strength_normalized, link.weight);
      const reinforced = isRecentlyReinforced(link.last_reinforced_at, now);
      const sourceId = extractId(link.source);
      const targetId = extractId(link.target);
      let alpha = baseAlpha;
      if (spotlightActive) {
        const both = matchIds.has(sourceId) && matchIds.has(targetId);
        const either = matchIds.has(sourceId) || matchIds.has(targetId);
        if (!both && !either) alpha = baseAlpha * 0.15;
        else if (!both) alpha = Math.min(baseAlpha, 0.55);
      }
      if (reinforced) alpha = Math.max(alpha, REINFORCED_GLOW_ALPHA);
      return rgba(rgb, alpha);
    },
    [matchIds, now, spotlightActive]
  );

  const nodeCanvasObject = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) => {
      const x = node.x ?? 0;
      const y = node.y ?? 0;
      const radius = nodeInfluenceSize(node);
      ctx.save();
      drawNodeShape(ctx, node.kind, x, y, radius, computeNodeColor(node));

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
        const textY = y + radius + 6;
        ctx.strokeText(node.label, x, textY);
        ctx.fillText(node.label, x, textY);
      }
      ctx.restore();
    },
    [computeNodeColor, matchIds, nodeSpotlightState, selectedNode]
  );

  const linkCanvasObject = useCallback(
    (link: GraphLink, ctx: CanvasRenderingContext2D) => {
      const sourceNode = link.source as GraphNode;
      const targetNode = link.target as GraphNode;
      const x1 = sourceNode.x ?? 0;
      const y1 = sourceNode.y ?? 0;
      const x2 = targetNode.x ?? 0;
      const y2 = targetNode.y ?? 0;
      const width = linkWidth(link.strength_normalized, link.weight);
      const dash = STABILITY_DASH[link.stability_class ?? "stable"] as number[] | undefined;
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
      ctx.strokeStyle = computeLinkColor(link);
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
    <div className="absolute inset-0" data-spotlight-active={spotlightActive ? "true" : "false"}>
      {effectiveMode === "2d" ? (
        <ForceGraph2D
          ref={fg2dRef}
          graphData={data}
          width={viewport.width}
          height={viewport.height}
          backgroundColor="#FDF6E3"
          nodeId="id"
          nodeRelSize={1}
          nodeVal={(node) => nodeInfluenceSize(node) * nodeInfluenceSize(node)}
          nodeColor={computeNodeColor}
          nodeLabel={formatGraphNodeTooltip}
          nodeCanvasObject={nodeCanvasObject}
          nodeCanvasObjectMode={() => "replace"}
          linkSource="source"
          linkTarget="target"
          linkColor={computeLinkColor}
          linkWidth={(link) => linkWidth(link.strength_normalized, link.weight)}
          linkCanvasObjectMode={() => "replace"}
          linkCanvasObject={linkCanvasObject}
          cooldownTicks={120}
          d3VelocityDecay={0.4}
          onEngineTick={() => onEngineTick("2d")}
          onNodeClick={onNodeClick}
          onBackgroundClick={onBackgroundClick}
        />
      ) : null}

      {effectiveMode === "3d" ? (
        <Suspense
          fallback={
            <div className="absolute inset-0 flex items-center justify-center">
              <p className="font-mono text-xs uppercase tracking-wider text-ink-700/40">
                {t("graph:viewMode.3d")} loading…
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
            nodeVal={(node) => nodeInfluenceSize(node)}
            nodeColor={computeNodeColor}
            nodeLabel={formatGraphNodeTooltip}
            nodeOpacity={0.92}
            linkSource="source"
            linkTarget="target"
            linkColor={computeLinkColor}
            linkWidth={(link) => linkWidth(link.strength_normalized, link.weight)}
            linkOpacity={0.85}
            linkDirectionalParticles={(link) =>
              largeGraphMode ? 0 : isRecentlyReinforced(link.last_reinforced_at, now) ? 2 : 0
            }
            linkDirectionalParticleSpeed={(link) =>
              0.005 + 0.012 * linkStrength(link.strength_normalized, link.weight)
            }
            linkDirectionalParticleWidth={2}
            cooldownTicks={largeGraphMode ? 60 : 120}
            d3VelocityDecay={largeGraphMode ? 0.55 : 0.4}
            onEngineTick={() => onEngineTick("3d")}
            onEngineStop={() => onEngineTick("3d")}
            onNodeClick={onNodeClick}
            onBackgroundClick={onBackgroundClick}
          />
        </Suspense>
      ) : null}
    </div>
  );
}

function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace(/^#/, "");
  const value = cleaned.length === 3 ? cleaned.split("").map((chunk) => chunk + chunk).join("") : cleaned;
  const parsed = Number.parseInt(value, 16);
  if (Number.isNaN(parsed)) return [88, 110, 117];
  return [(parsed >> 16) & 0xff, (parsed >> 8) & 0xff, parsed & 0xff];
}
