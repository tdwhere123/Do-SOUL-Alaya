import { z } from "zod";
import {
  BoundedIdSchema,
  compareUtcInstants,
  IsoDatetimeStringSchema,
  NonEmptyStringSchema
} from "../../shared/schema-primitives.js";
import {
  FieldContractDigestSchema,
  FieldReceiptContractFieldsSchema,
  assertFieldIdentity,
  assertFieldOperatorId,
  hashAddressableSourceSpanId,
  hashSourceRecordId,
  type FieldContractSha256
} from "./canonical-identity.js";
import { SOURCE_SPAN_IDENTITY_OPERATOR_ID } from "./operator-manifest.js";
import { HostStructureDescriptorSchema } from "../../conversation/host-occurrence.js";
import { UtteranceAttributionSchema } from "../../conversation/utterance-attribution.js";
import { canonicalJson } from "../selection/capture/canonical-json.js";

export const AddressableSourceSpanPurposeSchema = z.enum([
  "native_structure",
  "message",
  "sentence",
  "line",
  "proposed_subspan",
  "claim_citation"
]);

export const SourceSpeakerRoleSchema = z.enum(["user", "assistant", "system"]);
export const SourceScopeClassSchema = z.enum(["project", "global_domain", "global_core"]);

/** Missing historical metadata does not establish byte fidelity. Projection dependencies are ordered. */
export const SourceRepresentationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("original_body") }).strict(),
  z.object({ kind: z.literal("retained_excerpt") }).strict(),
  z.object({ kind: z.literal("canonical_projection"),
    source_record_ids: z.array(FieldContractDigestSchema).min(1).max(50).readonly()
  }).strict()
]).superRefine((value, context) => {
  if (value.kind === "canonical_projection" && new Set(value.source_record_ids).size !== value.source_record_ids.length) {
    context.addIssue({ code: "custom", message: "projection source records must be distinct" });
  }
}).readonly();

export const SourceRecordIdentitySchema = FieldReceiptContractFieldsSchema.extend({
  schema_version: z.literal(1),
  workspace_id: BoundedIdSchema,
  source_id: NonEmptyStringSchema.max(256),
  source_version: NonEmptyStringSchema.max(128),
  content_digest: FieldContractDigestSchema,
  evidence_object_id: BoundedIdSchema.nullable(),
  recorded_at: IsoDatetimeStringSchema,
  event_time: IsoDatetimeStringSchema.nullable(),
  valid_from: IsoDatetimeStringSchema.nullable(),
  valid_to: IsoDatetimeStringSchema.nullable(),
  operator_id: NonEmptyStringSchema.max(128),
  speaker: SourceSpeakerRoleSchema.nullable().optional(),
  scope_class: SourceScopeClassSchema.nullable().optional(),
  attribution_context: UtteranceAttributionSchema.nullable().optional(),
  source_representation: SourceRepresentationSchema.optional(),
  host_structure: HostStructureDescriptorSchema.optional()
}).strict().superRefine((record, context) => {
  if (record.valid_from === null && record.valid_to !== null) {
    context.addIssue({ code: "custom", message: "valid_to requires valid_from" });
  }
  if (record.valid_from !== null && record.valid_to !== null &&
      compareUtcInstants(record.valid_to, record.valid_from) !== 1) {
    context.addIssue({ code: "custom", message: "valid interval must be half-open" });
  }
}).readonly();

export const AddressableSourceSpanSchema = FieldReceiptContractFieldsSchema.extend({
  schema_version: z.literal(1),
  workspace_id: BoundedIdSchema,
  record_id: FieldContractDigestSchema,
  start_offset: z.number().int().nonnegative(),
  end_offset: z.number().int().nonnegative(),
  purpose: AddressableSourceSpanPurposeSchema,
  producer_version: NonEmptyStringSchema.max(128),
  recorded_at: IsoDatetimeStringSchema
}).strict().superRefine((span, context) => {
  if (span.end_offset <= span.start_offset) {
    context.addIssue({
      code: "custom",
      message: "addressable source span must be half-open and non-empty"
    });
  }
}).readonly();

export type AddressableSourceSpanPurpose = z.infer<typeof AddressableSourceSpanPurposeSchema>;
export type SourceSpeakerRole = z.infer<typeof SourceSpeakerRoleSchema>;
export type SourceScopeClass = z.infer<typeof SourceScopeClassSchema>;
export type SourceRepresentation = z.infer<typeof SourceRepresentationSchema>;
export type SourceProjectionDependencyState = Readonly<{
  identity: string;
  workspace_id: string;
  scope_class?: SourceScopeClass | null;
  current_identity: string | null;
  body_available: boolean;
  source_representation?: Pick<SourceRepresentation, "kind">;
}> | null;

/** Adapters collect bounded metadata; this owner decides whether derived bytes remain readable. */
export function sourceProjectionDependenciesAvailable(source: Pick<SourceRecordIdentity,
  "workspace_id" | "scope_class" | "source_representation">,
  dependencies: readonly SourceProjectionDependencyState[]): boolean {
  const representation = source.source_representation;
  if (representation?.kind !== "canonical_projection") return true;
  return dependencies.length === representation.source_record_ids.length && dependencies.every((state, index) =>
    state !== null && state.identity === representation.source_record_ids[index] &&
    state.workspace_id === source.workspace_id && (state.scope_class ?? null) === (source.scope_class ?? null) &&
    state.current_identity === state.identity && state.body_available &&
    (state.source_representation?.kind === "retained_excerpt" || state.source_representation?.kind === "original_body"));
}
export type SourceRecordIdentity = z.infer<typeof SourceRecordIdentitySchema>;
export type AddressableSourceSpan = z.infer<typeof AddressableSourceSpanSchema>;

type ImmutableSourceFields = Pick<SourceRecordIdentity, "source_id" | "source_version" | "content_digest" |
  "operator_id" | "event_time" | "valid_from" | "valid_to" | "speaker" | "scope_class" |
  "attribution_context" | "source_representation" | "host_structure">;

/** Evidence bindings may accumulate; a replay cannot requalify the retained source. */
export function sameSourceRecordFields(existing: ImmutableSourceFields, incoming: ImmutableSourceFields): boolean {
  return existing.source_id === incoming.source_id && existing.source_version === incoming.source_version &&
    existing.content_digest === incoming.content_digest && existing.operator_id === incoming.operator_id &&
    existing.event_time === incoming.event_time && existing.valid_from === incoming.valid_from && existing.valid_to === incoming.valid_to &&
    (existing.speaker ?? null) === (incoming.speaker ?? null) && (existing.scope_class ?? null) === (incoming.scope_class ?? null) &&
    canonicalJson(existing.host_structure ?? null) === canonicalJson(incoming.host_structure ?? null) &&
    canonicalJson(existing.source_representation ?? null) === canonicalJson(incoming.source_representation ?? null) &&
    canonicalJson(existing.attribution_context ?? null) === canonicalJson(incoming.attribution_context ?? null);
}

export function verifySourceRecordIdentity(
  receipt: SourceRecordIdentity,
  sha256: FieldContractSha256,
  expectedOperatorId: string = SOURCE_SPAN_IDENTITY_OPERATOR_ID
): SourceRecordIdentity {
  assertFieldOperatorId(receipt.operator_id, expectedOperatorId);
  assertFieldIdentity(
    receipt.identity,
    hashSourceRecordId(receipt, sha256),
    "source record"
  );
  return receipt;
}

export function verifyAddressableSourceSpan(
  receipt: AddressableSourceSpan,
  sha256: FieldContractSha256
): AddressableSourceSpan {
  assertFieldIdentity(
    receipt.identity,
    hashAddressableSourceSpanId(receipt, sha256),
    "source span"
  );
  return receipt;
}
