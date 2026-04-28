import { z } from "zod";
import { IsoDatetimeStringSchema, NonEmptyStringSchema, NonNegativeIntSchema } from "../schema-primitives.js";

const topologyTrendDirectionValues = ["growing", "stable", "shrinking"] as const;
const topologyStrengthTrendDirectionValues = ["increasing", "stable", "decreasing"] as const;

export const TopologyTrendDirectionSchema = z.enum(topologyTrendDirectionValues);
export const TopologyStrengthTrendDirectionSchema = z.enum(topologyStrengthTrendDirectionValues);

export const TopologyTrendSchema = z
  .object({
    snapshot_count: NonNegativeIntSchema,
    edge_count_trend: TopologyTrendDirectionSchema,
    avg_strength_trend: TopologyStrengthTrendDirectionSchema
  })
  .strict()
  .readonly();

export const TopologyExplorationResultSchema = z
  .object({
    exploration_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    total_nodes: NonNegativeIntSchema,
    total_edges: NonNegativeIntSchema,
    max_out_degree: NonNegativeIntSchema,
    max_in_degree: NonNegativeIntSchema,
    avg_degree: z.number(),
    strongly_connected_components: NonNegativeIntSchema,
    trend: TopologyTrendSchema.optional(),
    explored_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type TopologyTrendDirection = z.infer<typeof TopologyTrendDirectionSchema>;
export type TopologyStrengthTrendDirection = z.infer<typeof TopologyStrengthTrendDirectionSchema>;
export type TopologyTrend = z.infer<typeof TopologyTrendSchema>;
export type TopologyExplorationResult = z.infer<typeof TopologyExplorationResultSchema>;
