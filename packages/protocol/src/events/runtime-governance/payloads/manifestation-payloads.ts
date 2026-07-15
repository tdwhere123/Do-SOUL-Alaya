import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../../../shared/schema-primitives.js";
import { ManifestationLevelSchema } from "../../../soul/manifestation-budget.js";

export const ManifestationBudgetEvaluatedPayloadSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    total_candidates: NonNegativeIntSchema,
    stance_bias_assigned: NonNegativeIntSchema,
    dialogue_nudge_assigned: NonNegativeIntSchema,
    lens_entry_assigned: NonNegativeIntSchema,
    discarded: NonNegativeIntSchema,
    evaluated_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const ManifestationEscalationDecidedPayloadSchema = z
  .object({
    workspace_id: NonEmptyStringSchema,
    run_id: NonEmptyStringSchema,
    decisions: z
      .array(
        z
          .object({
            candidate_id: NonEmptyStringSchema,
            assigned_level: ManifestationLevelSchema.nullable(),
            reason: NonEmptyStringSchema
          })
          .strict()
          .readonly()
      )
      .readonly(),
    decided_at: IsoDatetimeStringSchema,
    // Consumers fold matching (run_id, decided_at) batches in batch_index order;
    // omitting both batch fields remains the single-batch compatibility form.
    batch_index: NonNegativeIntSchema.optional(),
    batch_count: NonNegativeIntSchema.optional()
  })
  .strict()
  .superRefine((payload, context) => {
    const hasIndex = payload.batch_index !== undefined;
    const hasCount = payload.batch_count !== undefined;
    if (hasIndex !== hasCount) {
      context.addIssue({
        code: "custom",
        message: "batch_index and batch_count must be provided together"
      });
      return;
    }
    const batchIndex = payload.batch_index;
    const batchCount = payload.batch_count;
    if (batchIndex === undefined || batchCount === undefined) return;
    if (batchCount === 0) {
      context.addIssue({
        code: "custom",
        path: ["batch_count"],
        message: "batch_count must be positive"
      });
    } else if (batchIndex >= batchCount) {
      context.addIssue({
        code: "custom",
        path: ["batch_index"],
        message: "batch_index must be less than batch_count"
      });
    }
  })
  .readonly();
