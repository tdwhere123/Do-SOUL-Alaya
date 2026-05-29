import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema } from "../schema-primitives.js";

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

// Single source of truth for how each edge_type participates in recall.
// Two orthogonal recall concepts share one per-edge_type row so they can
// never silently diverge again:
//
//   contribution_weight — the static per-edge contribution. Consumed in
//     two places that legitimately reuse the same value: the inbound
//     weighted-aggregate (`RecallServiceGraphSupportPort.countInboundEdgesWeighted`,
//     read by recall scoring as `graphSupportFactor`) and the single-edge
//     admission score in two-hop graph expansion (`scoreGraphExpansionEdge`,
//     which floors negatives at 0 for traversal while the aggregate keeps
//     the sign).
//   hop_decay — the per-hop multiplicative decay applied only at hop >= 2
//     in graph expansion. `null` for non-transitive types, which never
//     propagate past one hop.
//   transitive — whether the type propagates in multi-hop expansion. The
//     graph-expansion tracked-edge-type set is exactly the transitive rows.
//
// invariant: the weighted sum of `contribution_weight` over inbound edges
// is floor-clamped to [0, 3] by `normalizeGraphSupport`. Inbound
// negative-signal edges (supersedes / contradicts / incompatible_with)
// therefore *suppress* graph_support they otherwise would have accumulated
// from positive edges on the same memory, but cannot drop graph_support
// below the zero baseline. Lifting the floor to allow negative-only
// memories to read below baseline is a recall-weight rebalance that needs
// a co-evaluated bench sweep; the current clamp matches the rest of the
// score range.
//
// invariant: RECALLS edge accumulation can saturate graph_support once
// inbound RECALLS count × weight crosses the upper clamp. A high-traffic
// agent that repeatedly reports the same memory used will pin its
// preferred memories to max graph_support; per-run / per-window decay
// would be the principled fix.
//
// invariant: `EdgeProposalService.acceptProposal` wraps the
// `SOUL_GRAPH_EDGE_CREATED` audit row and the `memory_graph_edges` row
// insert in a single SQLite transaction via
// `EventPublisher.appendManyWithMutation`. A row insert failure rolls back
// the audit row in the same tx; concurrent writers serialize on the
// SQLite write lock so no orphan audit can leak. Durable edge writes flow
// only through proposal accept; no other code path may create a
// `memory_graph_edges` row.
export interface EdgeTypeRecallModelEntry {
  // Static per-edge contribution; negative for suppressing edge types.
  readonly contribution_weight: number;
  // Per-hop multiplicative decay at hop >= 2; null when not transitive.
  readonly hop_decay: number | null;
  // Whether the type propagates in multi-hop graph expansion.
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

export type MemoryGraphEdgeTypeValue = z.infer<typeof MemoryGraphEdgeTypeSchema>;
export type GraphExploreDir = z.infer<typeof GraphExploreDirSchema>;
export type GraphNeighborDir = z.infer<typeof GraphNeighborDirSchema>;
export type MemoryGraphEdge = z.infer<typeof MemoryGraphEdgeSchema>;
export type GraphNeighbor = z.infer<typeof GraphNeighborSchema>;
