import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "./schema-primitives.js";

export const WorkerTrustLevelSchema = z.enum(["high", "standard", "low", "untrusted"]);

export const TrustAssessmentFactorSchema = z.enum([
  "governance_lease_active",
  "hard_constraints_present",
  "tool_set_restricted",
  "budget_within_limits",
  "constitutional_assets_bound"
]);

export const WorkerTrustAssessmentSchema = z
  .object({
    assessment_id: NonEmptyStringSchema,
    worker_run_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    trust_level: WorkerTrustLevelSchema,
    factors: z.array(TrustAssessmentFactorSchema).readonly(),
    factor_details: z.record(z.string()).optional(),
    assessed_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const NarrativeBudgetConfigSchema = z
  .object({
    max_total_digest_bytes: NonNegativeIntSchema,
    max_digests_per_run: NonNegativeIntSchema,
    consolidation_threshold_pct: z.number().min(0).max(100)
  })
  .strict()
  .readonly();

export type WorkerTrustLevel = z.infer<typeof WorkerTrustLevelSchema>;
export type TrustAssessmentFactor = z.infer<typeof TrustAssessmentFactorSchema>;
export type WorkerTrustAssessment = z.infer<typeof WorkerTrustAssessmentSchema>;
export type NarrativeBudgetConfig = z.infer<typeof NarrativeBudgetConfigSchema>;
