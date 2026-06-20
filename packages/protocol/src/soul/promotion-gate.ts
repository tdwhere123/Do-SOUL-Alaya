import { z } from "zod";
import { BoundedLabelSchema } from "../shared/schema-primitives.js";
import { ControlPlaneEnvelopeSchema } from "./envelope.js";
import { ControlPlaneObjectKind } from "./object-kind.js";

const promotionConditionKindValues = [
  "min_evidence_count",
  "min_stability_duration",
  "no_active_contradictions",
  "scope_determined",
  "governance_subject_compilable"
] as const;

export const PromotionConditionKind = {
  MIN_EVIDENCE_COUNT: "min_evidence_count",
  MIN_STABILITY_DURATION: "min_stability_duration",
  NO_ACTIVE_CONTRADICTIONS: "no_active_contradictions",
  SCOPE_DETERMINED: "scope_determined",
  GOVERNANCE_SUBJECT_COMPILABLE: "governance_subject_compilable"
} as const;

export const PromotionConditionKindSchema = z.enum(promotionConditionKindValues);

export const PromotionConditionSchema = z
  .object({
    condition_kind: PromotionConditionKindSchema,
    threshold: z.number().min(0).nullable(),
    required: z.boolean()
  })
  .strict()
  .readonly();

export const PromotionGateSchema = ControlPlaneEnvelopeSchema.unwrap()
  .extend({
    object_kind: z.literal(ControlPlaneObjectKind.PROMOTION_GATE),
    conditions: z.array(PromotionConditionSchema).readonly(),
    per_dimension_defaults: z.record(BoundedLabelSchema, z.array(PromotionConditionSchema).readonly()).readonly().nullable()
  })
  .strict()
  .readonly();

export type PromotionConditionKind = z.infer<typeof PromotionConditionKindSchema>;
export type PromotionCondition = z.infer<typeof PromotionConditionSchema>;
export type PromotionGate = z.infer<typeof PromotionGateSchema>;
