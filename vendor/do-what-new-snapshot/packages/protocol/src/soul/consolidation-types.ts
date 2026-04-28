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
    fuse_outcome: z.enum(["ok", "tripped", "cooldown_active"])
  })
  .strict()
  .readonly();

export type ConsolidationCyclePlan = z.infer<typeof ConsolidationCyclePlanSchema>;
export type ConsolidationCycleResult = z.infer<typeof ConsolidationCycleResultSchema>;
