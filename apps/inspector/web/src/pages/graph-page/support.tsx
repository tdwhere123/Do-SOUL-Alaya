import { Box, Square } from "lucide-react";
import type { SoulPathGraphContract } from "@do-soul/alaya-protocol";
import { useI18n } from "../../i18n/locale";
import type { DictKey } from "../../i18n/dict";
import type { GraphLink, GraphNode } from "../../types/graph";
import {
  EDGE_TYPE_BASE_COLOR,
  NODE_KIND_BASE_COLOR,
  formatRelativeTime,
  rgba
} from "../../utils/graph";

const DEFAULT_NODE_FALLBACK_COLOR = "#586E75";

const LEGEND_NODE_ITEMS: ReadonlyArray<{
  readonly kind: string;
  readonly labelKey: DictKey;
  readonly tipKey: DictKey;
  readonly glyph: string;
}> = [
  {
    kind: "memory",
    labelKey: "graph:legend.node.memory",
    tipKey: "graph:legend.node.memory.tip",
    glyph: "M"
  },
  {
    kind: "scope",
    labelKey: "graph:legend.node.scope",
    tipKey: "graph:legend.node.scope.tip",
    glyph: "S"
  }
];

const LEGEND_EDGE_ITEMS: ReadonlyArray<{
  readonly family: string;
  readonly representativeKind: string;
  readonly labelKey: DictKey;
  readonly tipKey: DictKey;
}> = [
  {
    family: "supports",
    representativeKind: "supports",
    labelKey: "graph:legend.edge.supports",
    tipKey: "graph:legend.edge.supports.tip"
  },
  {
    family: "derives_from",
    representativeKind: "derives_from",
    labelKey: "graph:legend.edge.derives_from",
    tipKey: "graph:legend.edge.derives_from.tip"
  },
  {
    family: "recalls",
    representativeKind: "recalls",
    labelKey: "graph:legend.edge.associative",
    tipKey: "graph:legend.edge.associative.tip"
  },
  {
    family: "contradicts",
    representativeKind: "contradicts",
    labelKey: "graph:legend.edge.negative",
    tipKey: "graph:legend.edge.negative.tip"
  },
  {
    family: "exception_to",
    representativeKind: "exception_to",
    labelKey: "graph:legend.edge.exception_to",
    tipKey: "graph:legend.edge.exception_to.tip"
  }
];

interface PathGraphEnvelopeLike {
  readonly success: boolean;
  readonly data: SoulPathGraphContract;
}

interface ViewModeToggleProps {
  readonly mode: "2d" | "3d";
  readonly webglSupported: boolean;
  readonly onChange: (next: "2d" | "3d") => void;
}

export function ViewModeToggle({ mode, webglSupported, onChange }: ViewModeToggleProps) {
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
          mode === "2d" ? "bg-ink-600 text-beige-50" : "text-ink-700/60 hover:text-ink-700"
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
          mode === "3d" ? "bg-ink-600 text-beige-50" : "text-ink-700/60 hover:text-ink-700"
        } ${webglSupported ? "" : "cursor-not-allowed opacity-40"}`}
        aria-pressed={mode === "3d"}
        title={webglSupported ? undefined : t("graph:viewMode.unavailable")}
      >
        <Box className="w-3 h-3" /> {t("graph:viewMode.3d")}
      </button>
    </div>
  );
}

// On the path plane the legend decodes the colours actually rendered:
//   - node hue = anchor-derived node.kind (NODE_KIND_BASE_COLOR)
//   - edge hue = relation_kind family (EDGE_TYPE_BASE_COLOR), collapsed to the
//     representative kind of each family so the legend stays compact.
// No entry decodes a colour that no node/edge uses.
// see also: ../utils/graph.ts NODE_KIND_BASE_COLOR / EDGE_TYPE_BASE_COLOR.
export function GraphLegend() {
  const { t } = useI18n();
  return (
    <div className="absolute bottom-4 right-4 z-20 flex flex-col gap-2 rounded-md border border-beige-200 bg-beige-50/95 px-3 py-2 text-[10px] font-mono uppercase text-ink-700/65 shadow-sm">
      <NodeLegendGroup t={t} />
      <EdgeLegendGroup t={t} />
    </div>
  );
}

function NodeLegendGroup({ t }: { readonly t: (key: DictKey) => string }) {
  return (
    <div className="flex flex-col gap-1" data-testid="graph-legend-nodes">
      <span className="text-ink-700/40">{t("graph:legend.nodes.heading")}</span>
      {LEGEND_NODE_ITEMS.map((item) => <NodeLegendItem key={item.kind} item={item} t={t} />)}
    </div>
  );
}

function NodeLegendItem(props: {
  readonly item: (typeof LEGEND_NODE_ITEMS)[number];
  readonly t: (key: DictKey) => string;
}) {
  const label = props.t(props.item.labelKey);
  return (
    <div className="flex items-center gap-2" title={props.t(props.item.tipKey)}>
      <span className="inline-flex h-4 w-4 items-center justify-center rounded-full text-[8px] font-bold text-beige-50" style={{ backgroundColor: nodeLegendColor(props.item.kind) }} aria-label={`${label} (${props.item.glyph})`}>
        {props.item.glyph}
      </span>
      <span>{label}</span>
    </div>
  );
}

function EdgeLegendGroup({ t }: { readonly t: (key: DictKey) => string }) {
  return (
    <div className="flex flex-col gap-1" data-testid="graph-legend-edges">
      <span className="text-ink-700/40">{t("graph:legend.edges.heading")}</span>
      {LEGEND_EDGE_ITEMS.map((item) => <EdgeLegendItem key={item.family} item={item} t={t} />)}
    </div>
  );
}

function EdgeLegendItem(props: {
  readonly item: (typeof LEGEND_EDGE_ITEMS)[number];
  readonly t: (key: DictKey) => string;
}) {
  const label = props.t(props.item.labelKey);
  return (
    <div className="flex items-center gap-2" title={props.t(props.item.tipKey)}>
      <span className="inline-block h-1 w-4 rounded-full" style={{ backgroundColor: edgeLegendColor(props.item.representativeKind) }} aria-label={label} />
      <span>{label}</span>
    </div>
  );
}

function nodeLegendColor(kind: string): string {
  return NODE_KIND_BASE_COLOR[kind] ?? DEFAULT_NODE_FALLBACK_COLOR;
}

function edgeLegendColor(representativeKind: string): string {
  return rgba(EDGE_TYPE_BASE_COLOR[representativeKind] ?? [147, 161, 161], 0.95);
}

export function formatGraphNodeTooltip(node: GraphNode): string {
  const lines = [node.label];
  if (node.summary) lines.push(node.summary);
  if (typeof node.influence_count === "number") lines.push(`influence: ${node.influence_count}`);
  if (node.last_used_at) lines.push(`last used: ${formatRelativeTime(node.last_used_at)}`);
  return lines.join("\n");
}

export function drawNodeShape(
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

export function probeWebgl(): boolean {
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

export function unwrapPathGraph(
  value: SoulPathGraphContract | PathGraphEnvelopeLike
): SoulPathGraphContract {
  if (isPathGraphEnvelope(value)) {
    return value.data;
  }
  return value;
}

function isPathGraphEnvelope(
  value: SoulPathGraphContract | PathGraphEnvelopeLike
): value is PathGraphEnvelopeLike {
  return (
    typeof value === "object" &&
    value !== null &&
    "data" in value &&
    typeof value.data === "object" &&
    value.data !== null
  );
}

// Path-graph anchors are typed by their PathAnchorRef.kind. The renderer's
// node-shape switch only knows scope/signal/projection/memory, so anchors map
// onto that closed glyph set: object/object_facet -> memory (the dominant
// memory anchor), and the concern/obligation anchors -> scope (a distinct
// non-circular glyph). origin_kind is left undefined - the path plane does not
// carry the legacy SoulGraph origin classification; computeNodeColor keys the
// node hue off this anchor-derived node.kind via NODE_KIND_BASE_COLOR instead.
export function mapPathGraphNode(node: SoulPathGraphContract["nodes"][number]): GraphNode {
  const anchor = node.anchor;
  const objectId =
    anchor.kind === "object" || anchor.kind === "object_facet" ? anchor.object_id : undefined;
  return {
    id: node.id,
    kind: anchorKindToNodeKind(anchor.kind),
    label: node.label,
    ...(objectId === undefined ? {} : { object_id: objectId }),
    influence_count: node.out_degree + node.in_degree
  };
}

function anchorKindToNodeKind(
  anchorKind: SoulPathGraphContract["nodes"][number]["anchor"]["kind"]
): string {
  switch (anchorKind) {
    case "object":
    case "object_facet":
      return "memory";
    case "obligation":
    case "risk_concern":
    case "time_concern":
      return "scope";
    default:
      return "memory";
  }
}

export function mapPathGraphEdge(edge: SoulPathGraphContract["edges"][number]): GraphLink {
  return {
    id: edge.id,
    kind: edge.relation_kind,
    source: edge.source_id,
    target: edge.target_id,
    strength_normalized: clampStrength(edge.strength),
    stability_class: edge.stability_class,
    last_reinforced_at: edge.relation.plasticity_state.last_reinforced_at
  };
}

function clampStrength(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}
