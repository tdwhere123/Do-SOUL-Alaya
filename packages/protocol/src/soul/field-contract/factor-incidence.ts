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
  hashDerivationJobId,
  hashFactorId,
  hashIncidenceId,
  type FieldContractSha256
} from "./canonical-identity.js";
import { FACTOR_INCIDENCE_OPERATOR_ID } from "./operator-manifest.js";

export const FactorFamilySchema = z.enum(["f0", "f1", "f2", "f3"]);
export const DerivationJobStatusSchema = z.enum([
  "nominated",
  "running",
  "succeeded",
  "failed",
  "abandoned"
]);

export const FactorDescriptorSchema = FieldReceiptContractFieldsSchema.extend({
  schema_version: z.literal(1),
  workspace_id: BoundedIdSchema,
  family: FactorFamilySchema,
  canonical_payload: NonEmptyStringSchema.nullable(),
  operator_id: NonEmptyStringSchema.max(128),
  recorded_at: IsoDatetimeStringSchema
}).strict().readonly();

export const FactorIncidenceSchema = FieldReceiptContractFieldsSchema.extend({
  schema_version: z.literal(1),
  workspace_id: BoundedIdSchema,
  span_id: FieldContractDigestSchema,
  factor_id: FieldContractDigestSchema,
  scope: NonEmptyStringSchema.max(256),
  operator_id: NonEmptyStringSchema.max(128),
  recorded_at: IsoDatetimeStringSchema
}).strict().readonly();

export const DerivationJobReceiptSchema = FieldReceiptContractFieldsSchema.extend({
  schema_version: z.literal(1),
  workspace_id: BoundedIdSchema,
  purpose: NonEmptyStringSchema.max(128),
  operator_id: NonEmptyStringSchema.max(128),
  input_evidence_ids: z.array(BoundedIdSchema).readonly(),
  status: DerivationJobStatusSchema,
  disposition: NonEmptyStringSchema.max(128),
  recorded_at: IsoDatetimeStringSchema
}).strict().readonly();

export type FactorFamily = z.infer<typeof FactorFamilySchema>;
export type DerivationJobStatus = z.infer<typeof DerivationJobStatusSchema>;
export type FactorDescriptor = z.infer<typeof FactorDescriptorSchema>;
export type FactorIncidence = z.infer<typeof FactorIncidenceSchema>;
export type DerivationJobReceipt = z.infer<typeof DerivationJobReceiptSchema>;

export function verifyFactorDescriptor(
  receipt: FactorDescriptor,
  sha256: FieldContractSha256,
  expectedOperatorId: string = FACTOR_INCIDENCE_OPERATOR_ID
): FactorDescriptor {
  assertFieldOperatorId(receipt.operator_id, expectedOperatorId);
  if (receipt.canonical_payload === null) {
    return receipt;
  }
  assertFieldIdentity(receipt.identity, hashFactorId({
    family: receipt.family,
    canonical_payload: receipt.canonical_payload,
    operator_id: receipt.operator_id
  }, sha256), "factor");
  return receipt;
}

export function verifyFactorIncidence(
  receipt: FactorIncidence,
  sha256: FieldContractSha256,
  expectedOperatorId: string = FACTOR_INCIDENCE_OPERATOR_ID
): FactorIncidence {
  assertFieldOperatorId(receipt.operator_id, expectedOperatorId);
  assertFieldIdentity(receipt.identity, hashIncidenceId(receipt, sha256), "incidence");
  return receipt;
}

export function verifyDerivationJobReceipt(
  receipt: DerivationJobReceipt,
  sha256: FieldContractSha256
): DerivationJobReceipt {
  assertFieldIdentity(
    receipt.identity,
    hashDerivationJobId(receipt, sha256),
    "derivation job"
  );
  return receipt;
}
