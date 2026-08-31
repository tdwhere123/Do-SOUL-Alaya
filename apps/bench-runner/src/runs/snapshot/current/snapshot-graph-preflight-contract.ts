import { z } from "zod";

export const SNAPSHOT_GRAPH_REJECTION_REASONS = [
  "invalid_json",
  "invalid_shape",
  "other_relation_kind",
  "inactive",
  "non_positive",
  "wrong_governance",
  "missing_endpoint",
  "unsupported_direction"
] as const;

export type SnapshotGraphRejectionReason =
  typeof SNAPSHOT_GRAPH_REJECTION_REASONS[number];

export const SnapshotGraphPreflightSchema = z
  .object({
    eligibilityBasis: z.literal("formation_recall_allowed"),
    totalCount: z.number().int().nonnegative(),
    eligibleCount: z.number().int().nonnegative(),
    eligibleWorkspaceCount: z.number().int().nonnegative(),
    eligibleWorkspaceIds: z.array(z.string().min(1)).readonly(),
    relationKindCounts: z.record(
      z.string().min(1),
      z.number().int().nonnegative()
    ).readonly(),
    lifecycleStatusCounts: z.record(
      z.string().min(1),
      z.number().int().nonnegative()
    ).readonly(),
    rejectedByReason: z.object({
      invalid_json: z.number().int().nonnegative(),
      invalid_shape: z.number().int().nonnegative(),
      other_relation_kind: z.number().int().nonnegative(),
      inactive: z.number().int().nonnegative(),
      non_positive: z.number().int().nonnegative(),
      wrong_governance: z.number().int().nonnegative(),
      missing_endpoint: z.number().int().nonnegative(),
      unsupported_direction: z.number().int().nonnegative()
    }).strict().readonly()
  })
  .strict()
  .readonly();

export type SnapshotGraphPreflight =
  z.infer<typeof SnapshotGraphPreflightSchema>;
