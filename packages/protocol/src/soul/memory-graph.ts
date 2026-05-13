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
// Floor-at-zero limitation (v0.3.3): the weighted SUM is clamped to [0, 3] by
// `normalizeGraphSupport`, so a single SUPERSEDES (-0.5) reads as "no edges"
// not "below baseline". Extending the recall scoring range to [-1, 1] is a
// v0.4 task; the SUPERSEDES weight is staged here so the wiring is ready
// when normalization changes.
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
