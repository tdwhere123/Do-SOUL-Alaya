import { z } from "zod";
import {
  BOUNDED_DEFAULT_ARRAY_MAX,
  BoundedLabelSchema,
  IsoDatetimeStringSchema,
  NonNegativeIntSchema
} from "../../shared/schema-primitives.js";
import {
  ConditionalFieldIdSchema,
  MilligradeSchema,
  SchemaVersionSchema,
  Sha256DigestSchema
} from "./common.js";
import { GuardSchema } from "./query.js";

// One workspace cursor plus the canonical temporal state and selected generation.
export const SNAPSHOT_PIN_NATIVE_WORK = 3;

export const ObserverStatusSchema = z.enum([
  "exhausted",
  "open",
  "unavailable",
  "interrupted",
  "invalidated",
  "not_applicable",
  "cancelled",
  "unknown"
]);

export const ObserverOutcomeSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    status: ObserverStatusSchema
  })
  .strict()
  .readonly();

export const ObserverCursorSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    cursor_id: ConditionalFieldIdSchema,
    snapshot_id: Sha256DigestSchema,
    query_id: ConditionalFieldIdSchema,
    region_id: ConditionalFieldIdSchema,
    position: ConditionalFieldIdSchema.nullable(),
    // Progress commits only after identities are observed; retry resumes here.
    committed_through: ConditionalFieldIdSchema.nullable()
  })
  .strict()
  .readonly();

export const SnapshotReadLeaseSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    lease_id: ConditionalFieldIdSchema,
    snapshot_id: Sha256DigestSchema,
    query_id: ConditionalFieldIdSchema,
    status: z.enum(["active", "expired", "invalidated"])
  })
  .strict()
  .readonly();

export const CoverageRegionKindSchema = z.enum(["seed", "adjacency", "guard", "binding"]);

export const CoverageRegionSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    region_id: ConditionalFieldIdSchema,
    kind: CoverageRegionKindSchema,
    status: ObserverStatusSchema,
    conservative_bound_milligrades: MilligradeSchema.optional(),
    low_milligrades: MilligradeSchema.optional(),
    high_milligrades: MilligradeSchema.optional()
  })
  .strict()
  .readonly();

export const ObserverActionSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    action: z.enum(["seed", "adjacency", "relation", "measurement"]),
    region_id: ConditionalFieldIdSchema,
    work_limit: NonNegativeIntSchema
  })
  .strict()
  .readonly();

export const TypedObservationSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    observation_id: ConditionalFieldIdSchema,
    object_id: ConditionalFieldIdSchema,
    source_revision: ConditionalFieldIdSchema,
    workspace_id: ConditionalFieldIdSchema.optional(),
    applicability: GuardSchema,
    association_milligrades: MilligradeSchema.optional(),
    low_milligrades: MilligradeSchema.optional(),
    high_milligrades: MilligradeSchema.optional(),
    relation_kind: BoundedLabelSchema.optional(),
    measurement_id: ConditionalFieldIdSchema.optional(),
    model_id: ConditionalFieldIdSchema.optional(),
    binding_context: ConditionalFieldIdSchema.optional(),
    observed_at: IsoDatetimeStringSchema.optional()
  })
  .strict()
  .readonly();

export const ObserverPageSchema = z
  .object({
    schema_version: SchemaVersionSchema,
    query_id: ConditionalFieldIdSchema,
    snapshot_id: Sha256DigestSchema,
    cursor: ObserverCursorSchema,
    observations: z.array(TypedObservationSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly(),
    outcome: ObserverOutcomeSchema,
    open_regions: z.array(CoverageRegionSchema).max(BOUNDED_DEFAULT_ARRAY_MAX).readonly()
  })
  .strict()
  .readonly();

export type ObserverStatus = z.infer<typeof ObserverStatusSchema>;
export type ObserverOutcome = z.infer<typeof ObserverOutcomeSchema>;
export type ObserverCursor = z.infer<typeof ObserverCursorSchema>;
export type SnapshotReadLease = z.infer<typeof SnapshotReadLeaseSchema>;
export type CoverageRegionKind = z.infer<typeof CoverageRegionKindSchema>;
export type CoverageRegion = z.infer<typeof CoverageRegionSchema>;
export type ObserverAction = z.infer<typeof ObserverActionSchema>;
export type TypedObservation = z.infer<typeof TypedObservationSchema>;
export type ObserverPage = z.infer<typeof ObserverPageSchema>;
