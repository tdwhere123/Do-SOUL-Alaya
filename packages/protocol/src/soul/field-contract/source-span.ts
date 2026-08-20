import { z } from "zod";
import {
  BoundedIdSchema,
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

export const AddressableSourceSpanPurposeSchema = z.enum([
  "native_structure",
  "sentence",
  "line",
  "proposed_subspan",
  "claim_citation"
]);

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
  operator_id: NonEmptyStringSchema.max(128)
}).strict().superRefine((record, context) => {
  if (record.valid_from === null && record.valid_to !== null) {
    context.addIssue({ code: "custom", message: "valid_to requires valid_from" });
  }
  if (record.valid_from !== null && record.valid_to !== null &&
      record.valid_to <= record.valid_from) {
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
export type SourceRecordIdentity = z.infer<typeof SourceRecordIdentitySchema>;
export type AddressableSourceSpan = z.infer<typeof AddressableSourceSpanSchema>;

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
