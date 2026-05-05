import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../schema-primitives.js";

const stabilityClassValues = ["volatile", "normal", "stable", "pinned"] as const;
const directionBiasValues = [
  "source_to_target",
  "target_to_source",
  "bidirectional_asymmetric"
] as const;
const pathGovernanceClassValues = [
  "hint_only",
  "attention_only",
  "recall_allowed",
  "strictly_governed"
] as const;
const pathLifecycleStatusValues = ["active", "retired"] as const;
const manifestationPreferenceValues = ["stance_bias", "dialogue_nudge", "lens_entry"] as const;

export const StabilityClass = {
  VOLATILE: "volatile",
  NORMAL: "normal",
  STABLE: "stable",
  PINNED: "pinned"
} as const;

export const DirectionBias = {
  SOURCE_TO_TARGET: "source_to_target",
  TARGET_TO_SOURCE: "target_to_source",
  BIDIRECTIONAL_ASYMMETRIC: "bidirectional_asymmetric"
} as const;

export const PathGovernanceClass = {
  HINT_ONLY: "hint_only",
  ATTENTION_ONLY: "attention_only",
  RECALL_ALLOWED: "recall_allowed",
  STRICTLY_GOVERNED: "strictly_governed"
} as const;

export const PathLifecycleStatus = {
  ACTIVE: "active",
  RETIRED: "retired"
} as const;

export const ManifestationPreference = {
  STANCE_BIAS: "stance_bias",
  DIALOGUE_NUDGE: "dialogue_nudge",
  LENS_ENTRY: "lens_entry"
} as const;

export const StabilityClassSchema = z.enum(stabilityClassValues);
export const DirectionBiasSchema = z.enum(directionBiasValues);
export const PathGovernanceClassSchema = z.enum(pathGovernanceClassValues);
export const PathLifecycleStatusSchema = z.enum(pathLifecycleStatusValues);
export const ManifestationPreferenceSchema = z.enum(manifestationPreferenceValues);

const ObjectPathAnchorRefSchema = z
  .object({
    kind: z.literal("object"),
    object_id: NonEmptyStringSchema
  })
  .strict();

const ObjectFacetPathAnchorRefSchema = z
  .object({
    kind: z.literal("object_facet"),
    object_id: NonEmptyStringSchema,
    facet_key: NonEmptyStringSchema
  })
  .strict();

const ObligationPathAnchorRefSchema = z
  .object({
    kind: z.literal("obligation"),
    source_object_id: NonEmptyStringSchema,
    obligation_digest: NonEmptyStringSchema
  })
  .strict();

const RiskConcernPathAnchorRefSchema = z
  .object({
    kind: z.literal("risk_concern"),
    source_object_id: NonEmptyStringSchema,
    concern_digest: NonEmptyStringSchema
  })
  .strict();

const TimeConcernPathAnchorRefSchema = z
  .object({
    kind: z.literal("time_concern"),
    source_object_id: NonEmptyStringSchema,
    window_digest: NonEmptyStringSchema
  })
  .strict();

export const PathAnchorRefSchema = z
  .discriminatedUnion("kind", [
    ObjectPathAnchorRefSchema,
    ObjectFacetPathAnchorRefSchema,
    ObligationPathAnchorRefSchema,
    RiskConcernPathAnchorRefSchema,
    TimeConcernPathAnchorRefSchema
  ])
  .readonly();

export const PathEffectVectorSchema = z
  .object({
    salience: z.number(),
    recall_bias: z.number(),
    verification_bias: z.number(),
    unfinishedness_bias: z.number(),
    default_manifestation_preference: ManifestationPreferenceSchema
  })
  .strict()
  .readonly();

export const PathPlasticityStateSchema = z
  .object({
    strength: z.number(),
    direction_bias: DirectionBiasSchema,
    stability_class: StabilityClassSchema,
    support_events_count: NonNegativeIntSchema,
    contradiction_events_count: NonNegativeIntSchema,
    last_reinforced_at: IsoDatetimeStringSchema.optional(),
    last_weakened_at: IsoDatetimeStringSchema.optional()
  })
  .strict()
  .readonly();

const PathLifecycleSchema = z
  .object({
    status: PathLifecycleStatusSchema.optional(),
    retirement_rule: NonEmptyStringSchema,
    cooldown_rule: NonEmptyStringSchema.optional(),
    override_rule: NonEmptyStringSchema.optional()
  })
  .strict()
  .readonly();

const PathLegitimacySchema = z
  .object({
    evidence_basis: z.array(NonEmptyStringSchema).readonly(),
    governance_class: PathGovernanceClassSchema
  })
  .strict()
  .readonly();

export const PathRelationSchema = z
  .object({
    path_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    anchors: z
      .object({
        source_anchor: PathAnchorRefSchema,
        target_anchor: PathAnchorRefSchema
      })
      .strict()
      .readonly(),
    constitution: z
      .object({
        relation_kind: NonEmptyStringSchema,
        why_this_relation_exists: z.array(NonEmptyStringSchema).readonly()
      })
      .strict()
      .readonly(),
    effect_vector: PathEffectVectorSchema,
    plasticity_state: PathPlasticityStateSchema,
    lifecycle: PathLifecycleSchema,
    legitimacy: PathLegitimacySchema,
    created_at: IsoDatetimeStringSchema,
    updated_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type StabilityClass = z.infer<typeof StabilityClassSchema>;
export type DirectionBias = z.infer<typeof DirectionBiasSchema>;
export type PathGovernanceClass = z.infer<typeof PathGovernanceClassSchema>;
export type PathLifecycleStatus = z.infer<typeof PathLifecycleStatusSchema>;
export type ManifestationPreference = z.infer<typeof ManifestationPreferenceSchema>;
export type PathAnchorRef = z.infer<typeof PathAnchorRefSchema>;
export type PathEffectVector = z.infer<typeof PathEffectVectorSchema>;
export type PathRelation = z.infer<typeof PathRelationSchema>;
export type PathPlasticityState = z.infer<typeof PathPlasticityStateSchema>;
