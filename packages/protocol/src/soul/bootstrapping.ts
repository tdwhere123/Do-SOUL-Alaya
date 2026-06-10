import { z } from "zod";
import {
  IsoDatetimeStringSchema,
  NonEmptyStringSchema,
  NonNegativeIntSchema
} from "../shared/schema-primitives.js";
import {
  ManifestationPreference,
  PathGovernanceClass,
  StabilityClass
} from "./path-relation.js";

const bootstrappingAnchorTemplateKindValues = ["object", "object_facet"] as const;

export const BootstrappingAnchorTemplateKind = {
  OBJECT: "object",
  OBJECT_FACET: "object_facet"
} as const;

export const BootstrappingAnchorTemplateKindSchema = z.enum(
  bootstrappingAnchorTemplateKindValues
);

export const BootstrappingAnchorTemplateSchema = z
  .object({
    kind: BootstrappingAnchorTemplateKindSchema,
    description: NonEmptyStringSchema
  })
  .strict()
  .readonly();

export const BootstrappingPathTemplateSchema = z
  .object({
    template_id: NonEmptyStringSchema,
    relation_kind: NonEmptyStringSchema,
    why_this_relation_exists: z.array(NonEmptyStringSchema).readonly(),
    source_anchor_template: BootstrappingAnchorTemplateSchema,
    target_anchor_template: BootstrappingAnchorTemplateSchema,
    default_strength: z.number().default(0.1),
    default_stability_class: z.literal(StabilityClass.VOLATILE),
    default_governance_class: z.literal(PathGovernanceClass.HINT_ONLY),
    default_manifestation_preference: z.literal(ManifestationPreference.STANCE_BIAS)
  })
  .strict()
  .readonly();

export const BootstrappingRecordSchema = z
  .object({
    record_id: NonEmptyStringSchema,
    workspace_id: NonEmptyStringSchema,
    paths_planted: NonNegativeIntSchema,
    template_ids_used: z.array(NonEmptyStringSchema).readonly(),
    planted_at: IsoDatetimeStringSchema
  })
  .strict()
  .readonly();

export type BootstrappingAnchorTemplateKind = z.infer<
  typeof BootstrappingAnchorTemplateKindSchema
>;
export type BootstrappingAnchorTemplate = z.infer<
  typeof BootstrappingAnchorTemplateSchema
>;
export type BootstrappingPathTemplate = z.infer<
  typeof BootstrappingPathTemplateSchema
>;
export type BootstrappingRecord = z.infer<typeof BootstrappingRecordSchema>;
