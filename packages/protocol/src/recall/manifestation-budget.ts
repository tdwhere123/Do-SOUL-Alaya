import { z } from "zod";
import {
  BoundedJsonObjectSchema,
  BoundedIdSchema,
  BoundedReasonSchema,
  IsoDatetimeStringSchema,
  NonNegativeIntSchema,
  RatioSchema
} from "../shared/schema-primitives.js";

const manifestationLevelValues = ["stance_bias", "dialogue_nudge", "lens_entry"] as const;

export const ManifestationLevel = {
  STANCE_BIAS: "stance_bias",
  DIALOGUE_NUDGE: "dialogue_nudge",
  LENS_ENTRY: "lens_entry"
} as const;

export const ManifestationLevelSchema = z.enum(manifestationLevelValues);

export const ManifestationEscalationPolicySchema = z
  .object({
    nudge_min_pressure: RatioSchema,
    nudge_min_confidence: RatioSchema,
    lens_min_pressure: RatioSchema,
    lens_min_confidence: RatioSchema,
    lens_requires_task_coupling: z.boolean(),
    lens_requires_governance_ceiling: z.boolean()
  })
  .strict()
  .readonly();

export const ManifestationBudgetRemainingSchema = z
  .object({
    stance_bias: NonNegativeIntSchema,
    dialogue_nudge: NonNegativeIntSchema,
    lens_entry: NonNegativeIntSchema
  })
  .strict()
  .readonly();

export const ManifestationBudgetConfigSchema = z
  .object({
    workspace_id: BoundedIdSchema,
    stance_bias_cap: NonNegativeIntSchema,
    dialogue_nudge_cap: NonNegativeIntSchema,
    lens_entry_cap: NonNegativeIntSchema,
    escalation_policy: ManifestationEscalationPolicySchema,
    updated_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export const ManifestationBudgetConfigRouteDataSchema = BoundedJsonObjectSchema.superRefine(
  (value, context) => {
    const { source, ...config } = value;
    if (source !== undefined && source !== "default" && source !== "stored") {
      context.addIssue({ code: "custom", message: "Invalid config payload" });
      return;
    }
    if (!ManifestationBudgetConfigSchema.safeParse(config).success) {
      context.addIssue({ code: "custom", message: "Invalid config payload" });
    }
  }
);

export const ManifestationDecisionSchema = z
  .object({
    candidate_id: BoundedIdSchema,
    source_path_id: BoundedIdSchema,
    assigned_level: ManifestationLevelSchema.nullable(),
    reason: BoundedReasonSchema,
    budget_remaining: ManifestationBudgetRemainingSchema
  })
  .strict()
  .readonly();

export type ManifestationLevel = z.infer<typeof ManifestationLevelSchema>;
export type ManifestationEscalationPolicy = z.infer<typeof ManifestationEscalationPolicySchema>;
export type ManifestationBudgetRemaining = z.infer<typeof ManifestationBudgetRemainingSchema>;
export type ManifestationBudgetConfig = z.infer<typeof ManifestationBudgetConfigSchema>;
export type ManifestationDecision = z.infer<typeof ManifestationDecisionSchema>;
