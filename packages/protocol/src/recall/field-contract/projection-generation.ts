import { z } from "zod";
import {
  BoundedIdSchema,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema
} from "../../shared/schema-primitives.js";
import {
  FIELD_CONTRACT_SCHEMA_VERSION,
  FieldContractDigestSchema,
  FieldReceiptContractFieldsSchema,
  assertFieldIdentity,
  hashGenerationId,
  type FieldContractSha256,
  type FieldOperatorVersionEntry
} from "./canonical-identity.js";
import { assertCanonicalFieldOperatorManifest } from "./operator-manifest.js";

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
  generation_id: FieldContractDigestSchema,
  operator_manifest_digest: FieldContractDigestSchema,
  operator_versions: z.array(z.tuple([
    NonEmptyStringSchema.max(128),
    NonEmptyStringSchema.max(32)
  ])).readonly(),
  field_schema_version: z.literal(FIELD_CONTRACT_SCHEMA_VERSION),
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
  reader_id: BoundedIdSchema,
  pinned_at: IsoDatetimeStringSchema,
  expires_at: IsoDatetimeStringSchema,
  released_at: IsoDatetimeStringSchema.nullable()
}).strict().readonly();

export const ProjectionPinReleaseSchema = z.object({
  workspace_id: BoundedIdSchema,
  generation_id: FieldContractDigestSchema,
  reader_id: BoundedIdSchema,
  released_at: IsoDatetimeStringSchema
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
export type ProjectionPinRelease = z.infer<typeof ProjectionPinReleaseSchema>;
export type ProjectionEraseBarrier = z.infer<typeof ProjectionEraseBarrierSchema>;

export function sameEraseBarrier(
  existing: Pick<ProjectionEraseBarrier, "generation_id" | "subject_kind" | "subject_id">,
  incoming: Pick<ProjectionEraseBarrier, "generation_id" | "subject_kind" | "subject_id">
): boolean {
  return existing.generation_id === incoming.generation_id &&
    existing.subject_kind === incoming.subject_kind &&
    existing.subject_id === incoming.subject_id;
}

export function verifyFieldProjectionGeneration(
  receipt: FieldProjectionGeneration,
  sha256: FieldContractSha256
): FieldProjectionGeneration {
  const operators = toOperatorEntries(receipt.operator_versions);
  assertCanonicalFieldOperatorManifest(
    operators,
    receipt.operator_manifest_digest,
    sha256
  );
  const generationId = hashGenerationId({
    operators,
    operator_manifest_digest: receipt.operator_manifest_digest,
    field_schema_version: receipt.field_schema_version,
    input_event_frontier: receipt.input_event_frontier,
    governance_frontier: receipt.governance_frontier
  }, sha256);
  assertFieldIdentity(receipt.identity, generationId, "projection generation");
  assertFieldIdentity(receipt.generation_id, generationId, "projection generation");
  return receipt;
}

function toOperatorEntries(
  versions: FieldProjectionGeneration["operator_versions"]
): readonly FieldOperatorVersionEntry[] {
  return versions.map(([id, version]) => ({ id, version }));
}
