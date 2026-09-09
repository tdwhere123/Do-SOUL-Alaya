import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../shared/schema-primitives.js";

// invariant: `co_recalled` is intentionally EXCLUDED from this enum. It is a
// PathRelation relation_kind (the auto-build associative carrier) that projects
// to the display edge_type `recalls` via mapRelationKindToGraphEdgeType — it is
// NOT a graph edge_type itself. The exclusion is LOAD-BEARING for the recall
// earned-co_recalled fan-in reserve exemption: that exemption discriminates on
// relation_kind === "co_recalled", a value that no graph edge_type ever takes,
// so adding co_recalled here would let a generic graph edge masquerade as the
// earned fan-in carrier. A future edit that adds it trips the contract test.
// see also: packages/protocol/src/memory/memory-graph.ts:mapRelationKindToGraphEdgeType,
//   packages/core/src/recall/graph-expansion.ts:EARNED_CO_RECALLED_FANIN_RELATION_KIND,
//   packages/protocol/src/__tests__/memory/memory-graph-co-recalled-invariant.test.ts.
const memoryGraphEdgeTypeValues = [
  "supports",
  "derives_from",
  "contradicts",
  "supersedes",
  "recalls",
  "exception_to",
  "incompatible_with"
] as const;

const graphExploreDirValues = ["inbound", "outbound", "both"] as const;
const graphNeighborDirValues = ["inbound", "outbound"] as const;

export const MemoryGraphEdgeType = {
  SUPPORTS: "supports",
  DERIVES_FROM: "derives_from",
  CONTRADICTS: "contradicts",
  SUPERSEDES: "supersedes",
  RECALLS: "recalls",
  EXCEPTION_TO: "exception_to",
  INCOMPATIBLE_WITH: "incompatible_with"
} as const;

export const MemoryGraphEdgeTypeSchema = z.enum(memoryGraphEdgeTypeValues);

// Graph inspection retains static edge weights for positive inbound path
// aggregates. These are not conditional-field association or delivery scores.
// The historical hop-decay and transitivity fields remain part of this model;
// ordinary Recall does not run graph expansion from them.
// GraphExploreService filters ineligible paths before summing contributions,
// so a negative path does not cancel an independently positive contribution.
export interface EdgeTypeRecallModelEntry {
  // Static per-edge contribution; negative for suppressing edge types.
  readonly contribution_weight: number;
  // Historical per-hop decay; null when the retired expansion was non-transitive.
  readonly hop_decay: number | null;
  // Historical multi-hop expansion classification.
  readonly transitive: boolean;
}

export const EDGE_TYPE_RECALL_MODEL: Readonly<
  Record<typeof memoryGraphEdgeTypeValues[number], EdgeTypeRecallModelEntry>
> = Object.freeze({
  supports: Object.freeze({ contribution_weight: 1.0, hop_decay: 0.5, transitive: true }),
  derives_from: Object.freeze({ contribution_weight: 0.5, hop_decay: 0.6, transitive: true }),
  recalls: Object.freeze({ contribution_weight: 0.3, hop_decay: 0.3, transitive: true }),
  supersedes: Object.freeze({ contribution_weight: -0.5, hop_decay: null, transitive: false }),
  contradicts: Object.freeze({ contribution_weight: -0.4, hop_decay: null, transitive: false }),
  incompatible_with: Object.freeze({ contribution_weight: -0.3, hop_decay: null, transitive: false }),
  exception_to: Object.freeze({ contribution_weight: 0, hop_decay: null, transitive: false })
});

// Derived view: per-edge_type contribution weight. Kept under the original
// name so storage SQL derivation and pinned tests read it unchanged.
export const MEMORY_GRAPH_EDGE_RECALL_WEIGHTS: Readonly<
  Record<typeof memoryGraphEdgeTypeValues[number], number>
> = Object.freeze(
  Object.fromEntries(
    memoryGraphEdgeTypeValues.map((edgeType) => [
      edgeType,
      EDGE_TYPE_RECALL_MODEL[edgeType].contribution_weight
    ])
  ) as Record<typeof memoryGraphEdgeTypeValues[number], number>
);

// Derived view: the edge_type values that propagate in multi-hop graph
// expansion (the transitive rows of EDGE_TYPE_RECALL_MODEL). Order matches
// the declaration order of EDGE_TYPE_RECALL_MODEL.
export const GRAPH_EXPANSION_TRANSITIVE_EDGE_TYPES: readonly (typeof memoryGraphEdgeTypeValues[number])[] =
  Object.freeze(
    memoryGraphEdgeTypeValues.filter((edgeType) => EDGE_TYPE_RECALL_MODEL[edgeType].transitive)
  );
export const GraphExploreDirSchema = z.enum(graphExploreDirValues);
export const GraphNeighborDirSchema = z.enum(graphNeighborDirValues);

export const MemoryGraphEdgeSchema = z
  .object({
    edge_id: NonEmptyStringSchema,
    source_memory_id: NonEmptyStringSchema,
    target_memory_id: NonEmptyStringSchema,
    edge_type: MemoryGraphEdgeTypeSchema,
    workspace_id: NonEmptyStringSchema,
    created_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const GraphNeighborSchema = z
  .object({
    memory_id: NonEmptyStringSchema,
    edge_type: MemoryGraphEdgeTypeSchema,
    direction: GraphNeighborDirSchema,
    edge_id: NonEmptyStringSchema
  })
  .strict()
  .readonly();

// invariant: the single relation_kind -> MemoryGraphEdgeType projection.
// soul.explore_graph reads PathRelation (relation_kind is a free string)
// but its GraphNeighbor response field `edge_type` is a strict enum kept
// stable for existing consumers (HTTP graph-neighbors route + MCP). Path
// relation_kinds that equal an edge_type enum member (supports / derives_from
// / recalls / supersedes / contradicts / incompatible_with / exception_to,
// minted by edge-proposal accept and conflict detection) project to
// themselves; auto-build associative kinds (co_recalled / shares_entity /
// signal_graph_ref / coheres_with) project to `recalls`, the associative
// default. This is a display projection only — it never feeds recall scoring.
// see also: path-relation-proposal-service.ts seed-profile catalog.
const RELATION_KIND_TO_GRAPH_EDGE_TYPE: Readonly<Record<string, MemoryGraphEdgeTypeValue>> = Object.freeze({
  supports: "supports",
  derives_from: "derives_from",
  recalls: "recalls",
  supersedes: "supersedes",
  contradicts: "contradicts",
  incompatible_with: "incompatible_with",
  exception_to: "exception_to",
  co_recalled: "recalls",
  shares_entity: "recalls",
  signal_graph_ref: "recalls",
  coheres_with: "recalls"
});

// Open vocabulary: relation_kind is a free-form label and producers mint kinds
// outside the projection (e.g. co_usage, time_concern), so this stays total —
// unknown kinds fold to the associative `recalls` tier rather than throwing on
// arbitrary stored data. Display projection only; never feeds recall scoring.
const ASSOCIATIVE_DEFAULT_EDGE_TYPE: MemoryGraphEdgeTypeValue = "recalls";

export function mapRelationKindToGraphEdgeType(relationKind: string): MemoryGraphEdgeTypeValue {
  return RELATION_KIND_TO_GRAPH_EDGE_TYPE[relationKind] ?? ASSOCIATIVE_DEFAULT_EDGE_TYPE;
}

export type MemoryGraphEdgeTypeValue = z.infer<typeof MemoryGraphEdgeTypeSchema>;
export type GraphExploreDir = z.infer<typeof GraphExploreDirSchema>;
export type GraphNeighborDir = z.infer<typeof GraphNeighborDirSchema>;
export type MemoryGraphEdge = z.infer<typeof MemoryGraphEdgeSchema>;
export type GraphNeighbor = z.infer<typeof GraphNeighborSchema>;
