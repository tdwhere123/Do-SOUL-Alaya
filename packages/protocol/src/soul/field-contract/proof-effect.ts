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
  hashEffectRequestDigest,
  type FieldContractSha256
} from "./canonical-identity.js";

export const EffectDecisionSchema = z.enum([
  "allow",
  "deny",
  "defer",
  "require_confirmation"
]);

export const EffectRequestSchema = z.object({
  workspace_id: BoundedIdSchema,
  action: NonEmptyStringSchema.max(128),
  target: NonEmptyStringSchema.max(256),
  scope: NonEmptyStringSchema.max(256),
  effective_as_of: IsoDatetimeStringSchema,
  supporting_receipt_ids: z.array(NonEmptyStringSchema.max(256)).readonly()
}).strict().readonly();

export const EffectDecisionReceiptSchema = FieldReceiptContractFieldsSchema.extend({
  schema_version: z.literal(1),
  workspace_id: BoundedIdSchema,
  request_digest: FieldContractDigestSchema,
  action: NonEmptyStringSchema.max(128),
  target: NonEmptyStringSchema.max(256),
  scope: NonEmptyStringSchema.max(256),
  effective_as_of: IsoDatetimeStringSchema,
  decision: EffectDecisionSchema,
  supporting_receipt_ids: z.array(NonEmptyStringSchema.max(256)).readonly(),
  recorded_at: IsoDatetimeStringSchema
}).strict().readonly();

export type EffectDecision = z.infer<typeof EffectDecisionSchema>;
export type EffectRequest = z.infer<typeof EffectRequestSchema>;
export type EffectDecisionReceipt = z.infer<typeof EffectDecisionReceiptSchema>;

export function verifyEffectDecisionReceipt(
  receipt: EffectDecisionReceipt,
  sha256: FieldContractSha256
): EffectDecisionReceipt {
  assertFieldIdentity(receipt.identity, hashEffectRequestDigest(receipt, sha256), "effect request");
  assertFieldIdentity(
    receipt.request_digest,
    hashEffectRequestDigest(receipt, sha256),
    "effect request"
  );
  return receipt;
}
