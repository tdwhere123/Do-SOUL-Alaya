import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../schema-primitives.js";
import { PathGraphSnapshotSchema } from "./path-graph-snapshot.js";
import {
  DirectionBiasSchema,
  PathAnchorRefSchema,
  PathEffectVectorSchema,
  PathGovernanceClassSchema,
  PathRelationSchema,
  StabilityClassSchema
} from "./path-relation.js";

const soulGraphNodeKindValues = ["signal", "memory", "scope", "projection"] as const;
const soulGraphEdgeKindValues = ["references", "belongs_to", "derived_from"] as const;
const soulGraphOriginPlaneValues = ["project", "global"] as const;
const soulGraphOriginKindValues = [
  "user_memory",
  "engineering_chunk",
  "reviewed_engineering_chunk",
  "proposal_pending",
  "system"
] as const;

export const MIN_SOUL_GRAPH_DEPTH = 1;
export const DEFAULT_SOUL_GRAPH_DEPTH = 2;
export const MAX_SOUL_GRAPH_DEPTH = 3;
export const DEFAULT_SOUL_GRAPH_LIMIT = 500;
export const MAX_SOUL_GRAPH_LIMIT = 2000;

export const SoulGraphNodeKindSchema = z.enum(soulGraphNodeKindValues);
export const SoulGraphEdgeKindSchema = z.enum(soulGraphEdgeKindValues);
export const SoulGraphOriginPlaneSchema = z.enum(soulGraphOriginPlaneValues);
export const SoulGraphOriginKindSchema = z.enum(soulGraphOriginKindValues);

export const SoulGraphNodeSchema = z
  .object({
    id: NonEmptyStringSchema,
    kind: SoulGraphNodeKindSchema,
    label: NonEmptyStringSchema,
    summary: NonEmptyStringSchema.optional(),
    scope_id: NonEmptyStringSchema.optional(),
    workspace_id: NonEmptyStringSchema.optional(),
    created_at: IsoDatetimeStringSchema.optional(),
    origin_plane: SoulGraphOriginPlaneSchema.optional(),
    origin_kind: SoulGraphOriginKindSchema.optional(),
    evidence_refs: z.array(NonEmptyStringSchema).optional(),
    rationale: NonEmptyStringSchema.optional(),
    confidence: z.number().min(0).max(1).optional(),
    last_used_at: IsoDatetimeStringSchema.optional(),
    last_hit_at: IsoDatetimeStringSchema.optional(),
    influence_count: NonNegativeIntSchema.optional()
  })
  .strict()
  .readonly();

export const SoulGraphEdgeSchema = z
  .object({
    id: NonEmptyStringSchema,
    kind: SoulGraphEdgeKindSchema,
    source_id: NonEmptyStringSchema,
    target_id: NonEmptyStringSchema,
    weight: z.number().finite().nonnegative().optional(),
    strength_normalized: z.number().min(0).max(1).optional(),
    stability_class: StabilityClassSchema.optional(),
    last_reinforced_at: IsoDatetimeStringSchema.optional(),
    created_at: IsoDatetimeStringSchema.optional()
  })
  .strict()
  .readonly();

export const SoulGraphSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    nodes: z.array(SoulGraphNodeSchema).readonly(),
    edges: z.array(SoulGraphEdgeSchema).readonly(),
    truncated: z.boolean(),
    node_total: NonNegativeIntSchema,
    edge_total: NonNegativeIntSchema
  })
  .strict()
  .readonly();

const soulPathGraphTrendDirectionValues = ["growing", "shrinking", "stable"] as const;
const soulPathGraphStrengthTrendDirectionValues = ["increasing", "decreasing", "stable"] as const;

export const SoulPathGraphTrendDirectionSchema = z.enum(soulPathGraphTrendDirectionValues);
export const SoulPathGraphStrengthTrendDirectionSchema = z.enum(
  soulPathGraphStrengthTrendDirectionValues
);

export const SoulPathGraphNodeSchema = z
  .object({
    id: NonEmptyStringSchema,
    anchor: PathAnchorRefSchema,
    label: NonEmptyStringSchema,
    out_degree: NonNegativeIntSchema,
    in_degree: NonNegativeIntSchema
  })
  .strict()
  .readonly();

export const SoulPathGraphEdgeSchema = z
  .object({
    id: NonEmptyStringSchema,
    source_id: NonEmptyStringSchema,
    target_id: NonEmptyStringSchema,
    source_anchor: PathAnchorRefSchema,
    target_anchor: PathAnchorRefSchema,
    relation_kind: NonEmptyStringSchema,
    strength: z.number().finite(),
    direction_bias: DirectionBiasSchema,
    stability_class: StabilityClassSchema,
    governance_class: PathGovernanceClassSchema,
    effect_vector: PathEffectVectorSchema,
    relation: PathRelationSchema,
    created_at: IsoDatetimeStringSchema,
    updated_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const SoulPathGraphTopologySchema = z
  .object({
    total_nodes: NonNegativeIntSchema,
    total_edges: NonNegativeIntSchema,
    max_out_degree: NonNegativeIntSchema,
    max_in_degree: NonNegativeIntSchema,
    avg_degree: z.number().finite().nonnegative(),
    strongly_connected_components: NonNegativeIntSchema
  })
  .strict()
  .readonly();

export const SoulPathGraphSnapshotTrendSchema = z
  .object({
    snapshot_count: NonNegativeIntSchema,
    latest_snapshot_id: NonEmptyStringSchema,
    baseline_snapshot_id: NonEmptyStringSchema,
    latest_snapshot_at: IsoDatetimeStringSchema,
    baseline_snapshot_at: IsoDatetimeStringSchema,
    edge_count_trend: SoulPathGraphTrendDirectionSchema,
    avg_strength_trend: SoulPathGraphStrengthTrendDirectionSchema,
    latest_snapshot: PathGraphSnapshotSchema
  })
  .strict()
  .readonly();

export const SoulPathGraphContractSchema = z
  .object({
    contract_version: z.literal(1),
    workspace_id: NonEmptyStringSchema,
    generated_at: IsoDatetimeStringSchema,
    nodes: z.array(SoulPathGraphNodeSchema).readonly(),
    edges: z.array(SoulPathGraphEdgeSchema).readonly(),
    topology: SoulPathGraphTopologySchema,
    snapshot_trend: SoulPathGraphSnapshotTrendSchema.optional()
  })
  .strict()
  .readonly();

export function parseSoulGraphDepth(value: number | string | undefined): number {
  return parseSoulGraphBoundedInt(
    value,
    "depth",
    DEFAULT_SOUL_GRAPH_DEPTH,
    MIN_SOUL_GRAPH_DEPTH,
    MAX_SOUL_GRAPH_DEPTH
  );
}

export function parseSoulGraphLimit(value: number | string | undefined): number {
  return parseSoulGraphBoundedInt(
    value,
    "limit",
    DEFAULT_SOUL_GRAPH_LIMIT,
    1,
    MAX_SOUL_GRAPH_LIMIT
  );
}

function parseSoulGraphBoundedInt(
  value: number | string | undefined,
  label: "depth" | "limit",
  defaultValue: number,
  min: number,
  max: number
): number {
  if (value === undefined) {
    return defaultValue;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!/^\d+$/.test(trimmed)) {
      throw new RangeError(`${label} must be an integer between ${min} and ${max}`);
    }

    value = Number(trimmed);
  }

  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${label} must be an integer between ${min} and ${max}`);
  }

  return value;
}

export type SoulGraphNodeKind = z.infer<typeof SoulGraphNodeKindSchema>;
export type SoulGraphEdgeKind = z.infer<typeof SoulGraphEdgeKindSchema>;
export type SoulGraphOriginPlane = z.infer<typeof SoulGraphOriginPlaneSchema>;
export type SoulGraphOriginKind = z.infer<typeof SoulGraphOriginKindSchema>;
export type SoulGraphNode = z.infer<typeof SoulGraphNodeSchema>;
export type SoulGraphEdge = z.infer<typeof SoulGraphEdgeSchema>;
export type SoulGraph = z.infer<typeof SoulGraphSchema>;
export type SoulPathGraphTrendDirection = z.infer<typeof SoulPathGraphTrendDirectionSchema>;
export type SoulPathGraphStrengthTrendDirection = z.infer<
  typeof SoulPathGraphStrengthTrendDirectionSchema
>;
export type SoulPathGraphNode = z.infer<typeof SoulPathGraphNodeSchema>;
export type SoulPathGraphEdge = z.infer<typeof SoulPathGraphEdgeSchema>;
export type SoulPathGraphTopology = z.infer<typeof SoulPathGraphTopologySchema>;
export type SoulPathGraphSnapshotTrend = z.infer<typeof SoulPathGraphSnapshotTrendSchema>;
export type SoulPathGraphContract = z.infer<typeof SoulPathGraphContractSchema>;
