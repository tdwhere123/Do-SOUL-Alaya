import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../schema-primitives.js";
import {
  DirectionBiasSchema,
  PathGovernanceClassSchema,
  StabilityClassSchema
} from "./path-relation.js";

export const ConsolidationCyclePlanSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    planned_at: IsoDatetimeStringSchema,
    promotions: z
      .array(
        z
          .object({
            path_id: NonEmptyStringSchema,
            from_stability: StabilityClassSchema,
            to_stability: StabilityClassSchema
          })
          .strict()
          .readonly()
      )
      .readonly(),
    retirements: z
      .array(
        z
          .object({
            path_id: NonEmptyStringSchema,
            reason: NonEmptyStringSchema
          })
          .strict()
          .readonly()
      )
      .readonly(),
    governance_changes: z
      .array(
        z
          .object({
            path_id: NonEmptyStringSchema,
            from_class: PathGovernanceClassSchema,
            to_class: PathGovernanceClassSchema
          })
          .strict()
          .readonly()
      )
      .readonly(),
    direction_changes: z
      .array(
        z
          .object({
            path_id: NonEmptyStringSchema,
            from_bias: DirectionBiasSchema,
            to_bias: DirectionBiasSchema
          })
          .strict()
          .readonly()
      )
      .readonly(),
    // invariant: a merge folds the evidence of merged_path_ids (the losers)
    // into survivor_path_id, then deletes the losers. The executor performs
    // the why_this_relation_exists concat (deduped + bounded) and the loser
    // deletion transactionally. merged_path_ids MUST exclude the survivor.
    // Optional (no default) so plans persisted or built before the merge
    // mutation existed still parse (backward compatibility); an absent field
    // means no merges.
    // see also: packages/core/src/consolidation-executor.ts prepareMerges.
    // see also: packages/core/src/consolidation-planner.ts (producer).
    merges: z
      .array(
        z
          .object({
            survivor_path_id: NonEmptyStringSchema,
            merged_path_ids: z.array(NonEmptyStringSchema).readonly()
          })
          .strict()
          .readonly()
      )
      .readonly()
      .optional(),
    fuse_state: z
      .object({
        blown: z.boolean(),
        reason: NonEmptyStringSchema.optional(),
        retry_count: NonNegativeIntSchema
      })
      .strict()
      .readonly()
  })
  .strict()
  .readonly();

export const ConsolidationCycleResultSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    committed_at: IsoDatetimeStringSchema,
    promotions_committed: NonNegativeIntSchema,
    retirements_committed: NonNegativeIntSchema,
    governance_changes_committed: NonNegativeIntSchema,
    direction_changes_committed: NonNegativeIntSchema,
    merges_committed: NonNegativeIntSchema,
    fuse_outcome: z.enum(["ok", "tripped", "cooldown_active"])
  })
  .strict()
  .readonly();

export type ConsolidationCyclePlan = z.infer<typeof ConsolidationCyclePlanSchema>;
export type ConsolidationCycleResult = z.infer<typeof ConsolidationCycleResultSchema>;
