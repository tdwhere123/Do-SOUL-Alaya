import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonNegativeIntSchema
} from "../shared/schema-primitives.js";

export const GardenBacklogQueueDepthByTierSchema = z
  .object({
    tier_0: NonNegativeIntSchema,
    tier_1: NonNegativeIntSchema,
    tier_2: NonNegativeIntSchema
  })
  .strict()
  .readonly();

export const GardenBacklogSnapshotSchema = z
  .object({
    workspace_id: z.null(),
    observed_at: IsoDatetimeStringSchema,
    queue_depth_total: NonNegativeIntSchema,
    queue_depth_by_tier: GardenBacklogQueueDepthByTierSchema,
    in_flight_total: NonNegativeIntSchema,
    warning_active: z.boolean()
  })
  .strict()
  .readonly();

export const GardenBacklogThresholdsSchema = z
  .object({
    warning_queue_depth: NonNegativeIntSchema,
    warning_rearm_depth: NonNegativeIntSchema,
    snapshot_interval_ms: NonNegativeIntSchema
  })
  .strict()
  .readonly();

export type GardenBacklogQueueDepthByTier = z.infer<
  typeof GardenBacklogQueueDepthByTierSchema
>;
export type GardenBacklogSnapshot = z.infer<typeof GardenBacklogSnapshotSchema>;
export type GardenBacklogThresholds = z.infer<typeof GardenBacklogThresholdsSchema>;
