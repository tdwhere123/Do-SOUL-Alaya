import { z } from "zod";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BoundedLabelSchema
} from "../../shared/schema-primitives.js";
import { RelationValiditySchema } from "../../relations/relation-assertion.js";
import {
  ConditionalFieldIdSchema,
  MilligradeSchema,
  SchemaVersionSchema,
  Sha256DigestSchema
} from "./common.js";

export const ProductStateKeySchema = z
  .object({
    schema_version: SchemaVersionSchema,
    object_id: ConditionalFieldIdSchema,
    program_state: ConditionalFieldIdSchema,
    hypothesis_id: ConditionalFieldIdSchema,
    binding_context: ConditionalFieldIdSchema,
    time_state: ConditionalFieldIdSchema
  })
  .strict()
  .readonly();

export const TransitionSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    from: ProductStateKeySchema,
    to: ProductStateKeySchema,
    relation_kind: BoundedLabelSchema,
    strength_milligrades: MilligradeSchema,
    validity: RelationValiditySchema,
    applicable: z.boolean()
  })
  .strict()
  .readonly();

export const SeedActivationSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    state: ProductStateKeySchema,
    milligrades: MilligradeSchema
  })
  .strict()
  .readonly();

export const FieldValueSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    state: ProductStateKeySchema,
    milligrades: MilligradeSchema,
    accepting: z.boolean()
  })
  .strict()
  .readonly();

export const FacetVectorSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    path_id: ConditionalFieldIdSchema,
    coordinates: z.array(MilligradeSchema).min(1).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
  })
  .strict()
  .readonly();

export const FieldSnapshotSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    snapshot_id: Sha256DigestSchema,
    query_id: ConditionalFieldIdSchema,
    seeds: z.array(SeedActivationSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    values: z.array(FieldValueSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    retained_transitions: z.array(TransitionSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    facets: z.array(FacetVectorSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
  })
  .strict()
  .readonly();

export type ProductStateKey = z.infer<typeof ProductStateKeySchema>;
export type Transition = z.infer<typeof TransitionSchema>;
export type SeedActivation = z.infer<typeof SeedActivationSchema>;
export type FieldValue = z.infer<typeof FieldValueSchema>;
export type FacetVector = z.infer<typeof FacetVectorSchema>;
export type FieldSnapshot = z.infer<typeof FieldSnapshotSchema>;
