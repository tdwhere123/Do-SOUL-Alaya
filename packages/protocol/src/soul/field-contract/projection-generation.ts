import { z } from "zod";
import {
  BoundedIdSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema
} from "../../shared/schema-primitives.js";
import {
  FieldContractDigestSchema,
  FieldReceiptContractFieldsSchema
} from "./canonical-identity.js";

export const ProjectionGenerationStatusSchema = z.enum([
  "shadow",
  "verified",
  "active",
  "retired"
]);
export const ProjectionEraseSubjectKindSchema = z.enum([
  "source_record",
  "source_span",
  "factor",
  "incidence",
  "generation"
]);

export const FieldProjectionGenerationSchema = FieldReceiptContractFieldsSchema.extend({
  schema_version: z.literal(1),
  workspace_id: BoundedIdSchema,
  operator_manifest_digest: FieldContractDigestSchema,
  operator_versions: z.array(z.tuple([
    NonEmptyStringSchema.max(128),
    NonEmptyStringSchema.max(32)
  ])).readonly(),
  field_schema_version: NonEmptyStringSchema.max(32),
  input_event_frontier: NonEmptyStringSchema.max(256),
  governance_frontier: NonEmptyStringSchema.max(256),
  status: ProjectionGenerationStatusSchema,
  recorded_at: IsoDatetimeStringSchema
}).strict().readonly();

export const ProjectionGenerationPointerSchema = z.object({
  workspace_id: BoundedIdSchema,
  active_generation_id: FieldContractDigestSchema,
  activated_at: IsoDatetimeStringSchema
}).strict().readonly();

export const ProjectionPinSchema = z.object({
  workspace_id: BoundedIdSchema,
  generation_id: FieldContractDigestSchema,
  pinned_at: IsoDatetimeStringSchema
}).strict().readonly();

export const ProjectionEraseBarrierSchema = FieldReceiptContractFieldsSchema.extend({
  schema_version: z.literal(1),
  workspace_id: BoundedIdSchema,
  barrier_id: BoundedIdSchema,
  generation_id: FieldContractDigestSchema.nullable(),
  subject_kind: ProjectionEraseSubjectKindSchema,
  subject_id: NonEmptyStringSchema.max(256),
  erased_at: IsoDatetimeStringSchema
}).strict().readonly();

export type ProjectionGenerationStatus = z.infer<typeof ProjectionGenerationStatusSchema>;
export type ProjectionEraseSubjectKind = z.infer<typeof ProjectionEraseSubjectKindSchema>;
export type FieldProjectionGeneration = z.infer<typeof FieldProjectionGenerationSchema>;
export type ProjectionGenerationPointer = z.infer<typeof ProjectionGenerationPointerSchema>;
export type ProjectionPin = z.infer<typeof ProjectionPinSchema>;
export type ProjectionEraseBarrier = z.infer<typeof ProjectionEraseBarrierSchema>;
