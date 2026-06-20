import { useCallback, useEffect, useState } from "react";
import type { GraphLink, GraphNode, SpotlightState } from "../../types/graph";
import {
  EDGE_TYPE_BASE_COLOR,
  NODE_KIND_BASE_COLOR,
  STABILITY_DASH,
  extractId,
  isRecentlyReinforced,
  linkAlpha,
  linkWidth,
  nodeInfluenceSize,
  recencyAlpha,
  rgba
} from "../../utils/graph";
import { drawNodeShape } from "./support";

const DEFAULT_NODE_FALLBACK_COLOR = "#586E75";
const SPOTLIGHT_BG_ALPHA = 0.12;
const SPOTLIGHT_ADJ_ALPHA = 0.55;
const REINFORCED_GLOW_ALPHA = 0.95;

export function useGraphRendererStyles(props: {
  readonly matchIds: ReadonlySet<string>;
  readonly nodeSpotlightState: (id: string) => SpotlightState;
  readonly selectedNode: GraphNode | null;
  readonly spotlightActive: boolean;
}) {
  const { matchIds, nodeSpotlightState, selectedNode, spotlightActive } = props;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timerId = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(timerId);
  }, []);

  const computeNodeColor = useCallback(
    (node: GraphNode): string => {
      const rgb = hexToRgb(NODE_KIND_BASE_COLOR[node.kind] ?? DEFAULT_NODE_FALLBACK_COLOR);
      const recency = recencyAlpha(node.last_used_at, now);
      const state = nodeSpotlightState(node.id);
      if (state === "background") return rgba(rgb, SPOTLIGHT_BG_ALPHA);
      if (state === "adjacent") return rgba(rgb, Math.min(recency, SPOTLIGHT_ADJ_ALPHA));
      return rgba(rgb, recency);
    },
    [nodeSpotlightState, now]
  );
  const computeLinkColor = useCallback(
    (link: GraphLink): string => linkColor(link, now, matchIds, spotlightActive),
    [matchIds, now, spotlightActive]
  );
  const nodeCanvasObject = useCallback(
    (node: GraphNode, ctx: CanvasRenderingContext2D, globalScale: number) =>
      drawGraphNode(node, ctx, globalScale, {
        computeNodeColor,
        matchIds,
        nodeSpotlightState,
        selectedNode
      }),
    [computeNodeColor, matchIds, nodeSpotlightState, selectedNode]
  );
  const linkCanvasObject = useCallback(
    (link: GraphLink, ctx: CanvasRenderingContext2D) => drawGraphLink(link, ctx, computeLinkColor, now),
    [computeLinkColor, now]
  );
  return { computeLinkColor, computeNodeColor, linkCanvasObject, nodeCanvasObject, now };
}

function drawGraphNode(
  node: GraphNode,
  ctx: CanvasRenderingContext2D,
  globalScale: number,
  style: {
    readonly computeNodeColor: (node: GraphNode) => string;
    readonly matchIds: ReadonlySet<string>;
    readonly nodeSpotlightState: (id: string) => SpotlightState;
    readonly selectedNode: GraphNode | null;
  }
) {
  const x = node.x ?? 0;
  const y = node.y ?? 0;
  const radius = nodeInfluenceSize(node);
  ctx.save();
  drawNodeShape(ctx, node.kind, x, y, radius, style.computeNodeColor(node));
  drawSelectedNodeRing(ctx, node, radius, style.selectedNode);
  drawNodeLabel(ctx, node, radius, globalScale, style.nodeSpotlightState, style.matchIds);
  ctx.restore();
}

function drawSelectedNodeRing(
  ctx: CanvasRenderingContext2D,
  node: GraphNode,
  radius: number,
  selectedNode: GraphNode | null
) {
  if (selectedNode?.id !== node.id) return;
  ctx.strokeStyle = "#586E75";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(node.x ?? 0, node.y ?? 0, radius + 3, 0, 2 * Math.PI);
  ctx.stroke();
}

function drawNodeLabel(
  ctx: CanvasRenderingContext2D,
  node: GraphNode,
  radius: number,
  globalScale: number,
  nodeSpotlightState: (id: string) => SpotlightState,
  matchIds: ReadonlySet<string>
) {
  const state = nodeSpotlightState(node.id);
  const showLabel = state !== "background" && (globalScale > 1.2 || (node.degree ?? 0) >= 8 || matchIds.has(node.id));
  if (!showLabel || !node.label) return;
  ctx.font = `${Math.max(10, 11 / Math.max(0.5, globalScale))}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.lineWidth = 3;
  ctx.strokeStyle = "rgba(253, 246, 227, 0.95)";
  ctx.fillStyle = "#586E75";
  const textY = (node.y ?? 0) + radius + 6;
  ctx.strokeText(node.label, node.x ?? 0, textY);
  ctx.fillText(node.label, node.x ?? 0, textY);
}

function drawGraphLink(
  link: GraphLink,
  ctx: CanvasRenderingContext2D,
  computeLinkColor: (link: GraphLink) => string,
  now: number
) {
  const sourceNode = link.source as GraphNode;
  const targetNode = link.target as GraphNode;
  const width = linkWidth(link.strength_normalized, link.weight);
  ctx.save();
  drawReinforcedLinkGlow(ctx, link, sourceNode, targetNode, width, now);
  ctx.strokeStyle = computeLinkColor(link);
  ctx.lineWidth = width;
  ctx.setLineDash(STABILITY_DASH[link.stability_class ?? "stable"] as number[] | undefined ?? []);
  drawLine(ctx, sourceNode, targetNode);
  ctx.restore();
}

function drawReinforcedLinkGlow(
  ctx: CanvasRenderingContext2D,
  link: GraphLink,
  sourceNode: GraphNode,
  targetNode: GraphNode,
  width: number,
  now: number
) {
  if (!isRecentlyReinforced(link.last_reinforced_at, now)) return;
  ctx.strokeStyle = rgba(EDGE_TYPE_BASE_COLOR[link.kind] ?? [147, 161, 161], 0.35);
  ctx.lineWidth = width + 4;
  drawLine(ctx, sourceNode, targetNode);
}

function drawLine(ctx: CanvasRenderingContext2D, sourceNode: GraphNode, targetNode: GraphNode) {
  ctx.beginPath();
  ctx.moveTo(sourceNode.x ?? 0, sourceNode.y ?? 0);
  ctx.lineTo(targetNode.x ?? 0, targetNode.y ?? 0);
  ctx.stroke();
}

function linkColor(
  link: GraphLink,
  now: number,
  matchIds: ReadonlySet<string>,
  spotlightActive: boolean
): string {
  const rgb = EDGE_TYPE_BASE_COLOR[link.kind] ?? [147, 161, 161];
  const baseAlpha = linkAlpha(link.strength_normalized, link.weight);
  let alpha = spotlightAlpha(link, matchIds, spotlightActive, baseAlpha);
  if (isRecentlyReinforced(link.last_reinforced_at, now)) alpha = Math.max(alpha, REINFORCED_GLOW_ALPHA);
  return rgba(rgb, alpha);
}

function spotlightAlpha(
  link: GraphLink,
  matchIds: ReadonlySet<string>,
  spotlightActive: boolean,
  baseAlpha: number
): number {
  if (!spotlightActive) return baseAlpha;
  const sourceId = extractId(link.source);
  const targetId = extractId(link.target);
  const both = matchIds.has(sourceId) && matchIds.has(targetId);
  const either = matchIds.has(sourceId) || matchIds.has(targetId);
  if (!both && !either) return baseAlpha * 0.15;
  return both ? baseAlpha : Math.min(baseAlpha, 0.55);
}

function hexToRgb(hex: string): [number, number, number] {
  const cleaned = hex.replace(/^#/, "");
  const value = cleaned.length === 3 ? cleaned.split("").map((chunk) => chunk + chunk).join("") : cleaned;
  const parsed = Number.parseInt(value, 16);
  if (Number.isNaN(parsed)) return [88, 110, 117];
  return [(parsed >> 16) & 0xff, (parsed >> 8) & 0xff, parsed & 0xff];
}
