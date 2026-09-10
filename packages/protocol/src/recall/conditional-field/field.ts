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
import { FieldActivationSchema } from "./measurement.js";
import { ProductStateKeySchema } from "./product-identity.js";

export {
  CANONICAL_PRODUCT_IDENTITY_VERSION,
  MemoryEntryTargetSchema,
  ProductStateKeySchema,
  RecallTargetRefSchema,
  SourceDeliveredSpanSchema,
  SourceEvidenceRootKindSchema,
  SourceEvidenceTargetSchema,
  SourceRetainedExtentSchema,
  canonicalProductIdentity,
  memoryProductStateKey,
  memoryRecallTarget,
  productMemoryObjectId,
  productSubjectId,
  recallTargetWorkspaceId,
  retargetMemoryProduct,
  sameRecallTarget,
  sameSourceEvidenceRoot,
  sharedProductIdentity,
  sourceEvidenceRootKey,
  sourceEvidenceRootTarget,
  sourceProductStateKey,
  sourceRecallTarget,
  stableCanonicalStringify,
  type MemoryEntryTarget,
  type MemoryProductStateInput,
  type ProductStateKey,
  type RecallTargetRef,
  type SourceDeliveredSpan,
  type SourceEvidenceRootKind,
  type SourceEvidenceTarget,
  type SourceProductStateInput,
  type SourceRetainedExtent
} from "./product-identity.js";

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
    milligrades: MilligradeSchema.optional(),
    accepting: z.boolean(),
    low_milligrades: MilligradeSchema.optional(),
    high_milligrades: MilligradeSchema.optional(),
    activation: FieldActivationSchema.optional()
  })
  .strict()
  .superRefine((value, context) => {
    if (value.activation?.kind === "unreachable") {
      if (value.milligrades !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["milligrades"],
          message: "unreachable activation omits milligrades"
        });
      }
      return;
    }
    const milligrades = value.activation?.kind === "reachable"
      ? value.activation.milligrades
      : value.milligrades;
    if (milligrades === undefined) {
      context.addIssue({
        code: "custom",
        path: ["milligrades"],
        message: "reachable field value requires milligrades"
      });
    }
  })
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

export type Transition = z.infer<typeof TransitionSchema>;
export type SeedActivation = z.infer<typeof SeedActivationSchema>;
export type FieldValue = z.infer<typeof FieldValueSchema>;
export type FacetVector = z.infer<typeof FacetVectorSchema>;
export type FieldSnapshot = z.infer<typeof FieldSnapshotSchema>;
