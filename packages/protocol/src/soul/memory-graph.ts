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

// Per-edge_type contribution to `RecallServiceGraphSupportPort.countInboundEdgesWeighted`
// (consumed by recall scoring as `graphSupportFactor`). Adding a new
// edge_type requires either listing it here or accepting that it
// contributes 0.
//
// invariant: the weighted sum is floor-clamped to [0, 3] by
// `normalizeGraphSupport`. Inbound negative-signal edges (supersedes /
// contradicts / incompatible_with) therefore *suppress* graph_support
// they otherwise would have accumulated from positive edges on the
// same memory, but cannot drop graph_support below the zero baseline.
// Lifting the floor to allow negative-only memories to read below
// baseline is a recall-weight rebalance that needs a co-evaluated
// bench sweep; the current clamp matches the rest of the score range.
//
// invariant: RECALLS edge accumulation can saturate graph_support
// once inbound RECALLS count × weight crosses the upper clamp. A
// high-traffic agent that repeatedly reports the same memory used
// will pin its preferred memories to max graph_support; per-run /
// per-window decay would be the principled fix.
//
// invariant: `EdgeProposalService.acceptProposal` wraps the
// `SOUL_GRAPH_EDGE_CREATED` audit row and the `memory_graph_edges`
// row insert in a single SQLite transaction via
// `EventPublisher.appendManyWithMutation`. A row insert failure rolls
// back the audit row in the same tx; concurrent writers serialize on
// the SQLite write lock so no orphan audit can leak. Durable edge
// writes flow only through proposal accept; no other code path may
// create a `memory_graph_edges` row.
export const MEMORY_GRAPH_EDGE_RECALL_WEIGHTS: Readonly<Record<typeof memoryGraphEdgeTypeValues[number], number>> = Object.freeze({
  supports: 1.0,
  derives_from: 0.5,
  recalls: 0.3,
  supersedes: -0.5,
  contradicts: -0.4,
  incompatible_with: -0.3,
  exception_to: 0
});
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
