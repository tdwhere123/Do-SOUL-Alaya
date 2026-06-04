export interface GraphNodeShape {
  readonly id: string;
  readonly kind: string;
  readonly degree?: number;
  readonly influence_count?: number;
}

export const NODE_COLOR: Record<string, string> = {
  signal: "#96AD90",
  memory: "#92A8B3",
  scope: "#C9ADA7",
  projection: "#D4AF37"
};

export const ORIGIN_KIND_COLOR: Record<string, string> = {
  user_memory: "#4A90A4", // calm teal — explicitly created or curated by the user
  engineering_chunk: "#8E9396", // muted slate — auto-imported from .codex / engineering source
  reviewed_engineering_chunk: "#9C6FAB", // soft violet — engineering origin AFTER reviewer accept
  proposal_pending: "#D4AF37", // amber — awaiting governance review
  system: "#6F4E5B" // wine — bootstrap / install / runtime-derived
};

// Edge palette keyed by path-plane relation_kind (link.kind on the path plane
// is the raw PathRelation.constitution.relation_kind, a free string). Hues are
// grouped by semantic family so the topology reads at a glance:
//   - positive structural (supports / derives_from): warm green + orange
//   - positive associative (recalls + its auto-build siblings co_recalled /
//     shares_entity / signal_graph_ref / co_usage): cool blue family
//   - negative (contradicts / supersedes / incompatible_with): wine / red
//   - neutral topology marker (exception_to): muted amber
// The legacy SoulGraph edge kinds are kept so a mixed payload still colours.
// Unknown free-string kinds fall back to the neutral grey in computeLinkColor.
// see also: packages/protocol/src/soul/memory-graph.ts RELATION_KIND_TO_GRAPH_EDGE_TYPE
//           apps/inspector/web/src/pages/Graph.tsx EdgeRelationLegend
export const EDGE_TYPE_BASE_COLOR: Record<string, [number, number, number]> = {
  // positive structural
  supports: [126, 168, 132], // sage green — strongest positive contribution
  derives_from: [192, 128, 64], // soft orange — derivation lineage
  // positive associative family (recalls + auto-build siblings)
  recalls: [125, 159, 187], // light blue
  co_recalled: [125, 159, 187],
  shares_entity: [125, 159, 187],
  signal_graph_ref: [125, 159, 187],
  co_usage: [125, 159, 187],
  // negative family (suppression / conflict)
  contradicts: [180, 90, 95], // muted red
  supersedes: [150, 78, 110], // wine
  incompatible_with: [196, 110, 120], // soft rose
  // neutral topology marker
  exception_to: [196, 160, 96], // muted amber
  // legacy SoulGraph edge kinds (kept for mixed payloads)
  references: [125, 159, 187], // light blue
  belongs_to: [126, 168, 132], // sage green
  derived_from: [192, 128, 64] // soft orange
};

// Node hue basis on the path plane. The path plane carries no origin_kind, so
// nodes are coloured by their anchor-derived node.kind (memory vs scope) rather
// than the retired origin classification. Keyed by GraphNode.kind.
// see also: apps/inspector/web/src/pages/Graph.tsx anchorKindToNodeKind / NodeKindLegend
export const NODE_KIND_BASE_COLOR: Record<string, string> = {
  memory: "#92A8B3", // calm blue-grey — object / object_facet anchors
  scope: "#C9ADA7" // warm clay — obligation / risk_concern / time_concern anchors
};

// see also: packages/protocol/src/soul/path-relation.ts:StabilityClassSchema
export const STABILITY_DASH: Record<
  "stable" | "normal" | "pinned" | "volatile",
  [number, number] | null
> = {
  stable: null,
  pinned: null,
  normal: null,
  volatile: [4, 3]
};

// Caps degree-driven size variance so a 30-degree hub does not balloon to 70px.
export function nodeRadius(d: GraphNodeShape): number {
  return 8 + Math.min(6, Math.log2((d.degree ?? 0) + 1) * 2);
}

export function nodeInfluenceSize(d: GraphNodeShape): number {
  const influence = Math.max(0, d.influence_count ?? 0);
  return Math.log2(influence + 2) * 4;
}

// Recency alpha for nodes — entries used recently are crisp, stale entries
// fade to ~30% alpha. Returns a value in [0.3, 1.0].
export function recencyAlpha(lastUsedAt: string | null | undefined, now: number = Date.now()): number {
  if (!lastUsedAt) return 0.6;
  const t = Date.parse(lastUsedAt);
  if (Number.isNaN(t)) return 0.6;
  const ageDays = Math.max(0, (now - t) / (1000 * 60 * 60 * 24));
  // Sigmoid-like fade across ~30 days: alpha ≈ 1 at 0 days, ≈ 0.3 at 60 days.
  const sigmoid = 1 / (1 + Math.exp((ageDays - 30) / 12));
  return 0.3 + 0.7 * sigmoid;
}

export function rgba(rgb: readonly [number, number, number], alpha: number): string {
  return `rgba(${rgb[0]}, ${rgb[1]}, ${rgb[2]}, ${alpha.toFixed(3)})`;
}

export function linkStrength(
  strengthNormalized: number | undefined | null,
  weight: number | undefined | null = undefined
): number {
  const raw =
    typeof strengthNormalized === "number"
      ? strengthNormalized
      : typeof weight === "number"
        ? weight
        : 0.3;
  return Math.max(0, Math.min(1, raw));
}

// Alpha for the link itself based on strength_normalized. Maps [0,1] →
// [0.25, 0.95] so even very weak ties remain visible enough to hint at
// the underlying topology.
export function linkAlpha(
  strengthNormalized: number | undefined | null,
  weight: number | undefined | null = undefined
): number {
  const s = linkStrength(strengthNormalized, weight);
  return 0.25 + 0.7 * s;
}

// Width for the link based on strength_normalized — strong paths read as
// thick beams, weak paths as fine threads.
export function linkWidth(
  strengthNormalized: number | undefined | null,
  weight: number | undefined | null = undefined
): number {
  const s = linkStrength(strengthNormalized, weight);
  return 0.5 + 3 * s;
}

export function linkDistance(
  strengthNormalized: number | undefined | null,
  weight: number | undefined | null = undefined
): number {
  const s = linkStrength(strengthNormalized, weight);
  return 60 + 200 * (1 - s);
}

// Reinforcement glow: the most useful signal for "what just changed in this
// graph" — paths reinforced in the last 24h should pop visually.
export function isRecentlyReinforced(
  lastReinforcedAt: string | null | undefined,
  now: number = Date.now()
): boolean {
  if (!lastReinforcedAt) return false;
  const t = Date.parse(lastReinforcedAt);
  if (Number.isNaN(t)) return false;
  const ageMs = now - t;
  return ageMs >= 0 && ageMs < 24 * 60 * 60 * 1000;
}

export function formatRelativeTime(iso: string): string {
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

export function extractId(endpoint: string | number | GraphNodeShape): string {
  if (typeof endpoint === "string") return endpoint;
  if (typeof endpoint === "number") return String(endpoint);
  return endpoint.id;
}
