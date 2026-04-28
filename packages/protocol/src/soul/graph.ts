import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../schema-primitives.js";

const soulGraphNodeKindValues = ["signal", "memory", "scope", "projection"] as const;
const soulGraphEdgeKindValues = ["references", "belongs_to", "derived_from"] as const;
const soulGraphOriginPlaneValues = ["project", "global"] as const;

export const MIN_SOUL_GRAPH_DEPTH = 1;
export const DEFAULT_SOUL_GRAPH_DEPTH = 2;
export const MAX_SOUL_GRAPH_DEPTH = 3;
export const DEFAULT_SOUL_GRAPH_LIMIT = 500;
export const MAX_SOUL_GRAPH_LIMIT = 2000;

export const SoulGraphNodeKindSchema = z.enum(soulGraphNodeKindValues);
export const SoulGraphEdgeKindSchema = z.enum(soulGraphEdgeKindValues);
export const SoulGraphOriginPlaneSchema = z.enum(soulGraphOriginPlaneValues);

export const SoulGraphNodeSchema = z
  .object({
    id: NonEmptyStringSchema,
    kind: SoulGraphNodeKindSchema,
    label: NonEmptyStringSchema,
    summary: NonEmptyStringSchema.optional(),
    scope_id: NonEmptyStringSchema.optional(),
    workspace_id: NonEmptyStringSchema.optional(),
    created_at: IsoDatetimeStringSchema.optional(),
    origin_plane: SoulGraphOriginPlaneSchema.optional()
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
export type SoulGraphNode = z.infer<typeof SoulGraphNodeSchema>;
export type SoulGraphEdge = z.infer<typeof SoulGraphEdgeSchema>;
export type SoulGraph = z.infer<typeof SoulGraphSchema>;
