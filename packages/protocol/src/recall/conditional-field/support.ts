import { z } from "zod";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BoundedLabelSchema,
  NonNegativeIntSchema
} from "../../shared/schema-primitives.js";
import { ConditionalFieldIdSchema, SchemaVersionSchema } from "./common.js";

export const ClaimStateSchema = z.enum(["supported", "refuted", "conflict", "unknown"]);

export const WitnessSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    witness_id: ConditionalFieldIdSchema,
    premises: z.array(ConditionalFieldIdSchema).min(1).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    cost: NonNegativeIntSchema,
    complete: z.boolean()
  })
  .strict()
  .readonly();

export const SupportRecordSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    proposition_id: ConditionalFieldIdSchema,
    claim: ClaimStateSchema,
    witnesses: z.array(WitnessSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
  })
  .strict()
  .readonly();

export const PropositionSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    proposition_id: ConditionalFieldIdSchema,
    kind: BoundedLabelSchema,
    arguments: z.array(ConditionalFieldIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
  })
  .strict()
  .readonly();

export const DerivationKindSchema = z.enum(["serial", "and", "or", "leaf"]);

export const DerivationSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    derivation_id: ConditionalFieldIdSchema,
    kind: DerivationKindSchema,
    association_milligrades: z.number().int().min(0).max(1000).optional(),
    children: z.array(ConditionalFieldIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    observation_ids: z.array(ConditionalFieldIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    // Provenance is local to leaf nodes; follow children for transitive provenance.
    provenance_layout: z.literal("local_leaves.v1").optional(),
    leaf_ids: z.array(ConditionalFieldIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    witness_id: ConditionalFieldIdSchema.optional(),
    source_revisions: z.array(ConditionalFieldIdSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
  })
  .strict()
  .readonly();

export type ClaimState = z.infer<typeof ClaimStateSchema>;
export type Witness = z.infer<typeof WitnessSchema>;
export type SupportRecord = z.infer<typeof SupportRecordSchema>;
export type Proposition = z.infer<typeof PropositionSchema>;
export type DerivationKind = z.infer<typeof DerivationKindSchema>;
export type Derivation = z.infer<typeof DerivationSchema>;
