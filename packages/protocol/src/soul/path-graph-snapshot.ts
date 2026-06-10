import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../shared/schema-primitives.js";

export const PathStrengthDistributionSchema = z
  .object({
    very_weak: NonNegativeIntSchema,
    weak: NonNegativeIntSchema,
    moderate: NonNegativeIntSchema,
    strong: NonNegativeIntSchema,
    very_strong: NonNegativeIntSchema
  })
  .strict()
  .readonly();

export const PathStabilityDistributionSchema = z
  .object({
    volatile: NonNegativeIntSchema,
    normal: NonNegativeIntSchema,
    stable: NonNegativeIntSchema,
    pinned: NonNegativeIntSchema
  })
  .strict()
  .readonly();

export const PathGovernanceDistributionSchema = z
  .object({
    hint_only: NonNegativeIntSchema,
    attention_only: NonNegativeIntSchema,
    recall_allowed: NonNegativeIntSchema,
    strictly_governed: NonNegativeIntSchema
  })
  .strict()
  .readonly();

export const PathConnectivityMetricsSchema = z
  .object({
    unique_source_anchors: NonNegativeIntSchema,
    unique_target_anchors: NonNegativeIntSchema,
    max_out_degree: NonNegativeIntSchema,
    max_in_degree: NonNegativeIntSchema,
    isolated_anchors: NonNegativeIntSchema
  })
  .strict()
  .readonly();

// invariant: every metric field on PathGraphSnapshot must have a named
// downstream consumer. Inspector trend rendering reads strength /
// stability / governance distributions plus the connectivity + activity
// counters through SoulPathGraphSnapshotTrend.latest_snapshot.
// total_retired_paths and paths_retired_since_last were reserved
// placeholders without a producer or a reader; they were dropped to
// keep the schema honest. See also: graph-contract-service trend logic.
export const PathGraphSnapshotSchema = z
  .object({
    snapshot_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    total_active_paths: NonNegativeIntSchema,
    strength_distribution: PathStrengthDistributionSchema,
    stability_distribution: PathStabilityDistributionSchema,
    governance_distribution: PathGovernanceDistributionSchema,
    connectivity: PathConnectivityMetricsSchema,
    paths_reinforced_since_last: NonNegativeIntSchema,
    paths_weakened_since_last: NonNegativeIntSchema,
    paths_created_since_last: NonNegativeIntSchema,
    snapshot_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type PathGraphSnapshot = z.infer<typeof PathGraphSnapshotSchema>;
