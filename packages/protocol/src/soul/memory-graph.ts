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
// (consumed by recall scoring as `graphSupportFactor`). Adding a new edge_type
// requires either listing it here or accepting that it contributes 0.
//
// Known limitations (documented for v0.3.3; tracked for v0.4):
//   * Floor-at-zero: the weighted SUM is clamped to [0, 3] by
//     `normalizeGraphSupport`, so a single SUPERSEDES (-0.5) reads as
//     "no edges" not "below baseline". The SUPERSEDES weight is staged
//     here so the wiring is ready when normalization changes.
//   * RECALLS saturation: with weight +0.3 and the clamp at 3, ~10
//     inbound RECALLS edges saturate `graphSupportFactor` to 1.0. A
//     high-traffic agent that reports the same memory used repeatedly
//     can pin its preferred memories to max graph_support. The hard
//     fix (per-run / per-window decay) is a recall-scoring redesign.
//   * Audit-drift: `GraphExploreService.addEdge` appends
//     `SOUL_GRAPH_EDGE_CREATED` before the row insert and outside any
//     transaction. Concurrent fan-out from `report_context_usage` can
//     leave audit rows for edges the SQL constraint then rejects. The
//     structural fix (append+insert in one transaction via
//     `appendManyWithMutation`) is pre-existing scope.
export const MEMORY_GRAPH_EDGE_RECALL_WEIGHTS: Readonly<Record<typeof memoryGraphEdgeTypeValues[number], number>> = Object.freeze({
  supports: 1.0,
  derives_from: 0.5,
  recalls: 0.3,
  supersedes: -0.5,
  contradicts: 0,
  exception_to: 0,
  incompatible_with: 0
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
