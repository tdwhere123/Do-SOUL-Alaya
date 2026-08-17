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
  hashEffectGovernanceFrontier,
  hashEffectRequestDigest,
  type FieldContractSha256
} from "./canonical-identity.js";

export const EffectDecisionSchema = z.enum([
  "allow",
  "deny",
  "defer",
  "require_confirmation"
]);

export const ProofEffectWitnessSchema = z.object({
  receipt_id: NonEmptyStringSchema.max(256),
  kind: NonEmptyStringSchema.max(128),
  authority_event_id: NonEmptyStringSchema.max(256).nullable(),
  source_record_id: NonEmptyStringSchema.max(256).nullable(),
  source_content_digest: NonEmptyStringSchema.max(256).nullable()
}).strict().readonly();

export const EffectRequestSchema = z.object({
  schema_version: z.literal(2),
  workspace_id: BoundedIdSchema,
  actor_id: BoundedIdSchema,
  run_id: BoundedIdSchema,
  delivery_id: BoundedIdSchema,
  action: NonEmptyStringSchema.max(128),
  target: NonEmptyStringSchema.max(256),
  scope: NonEmptyStringSchema.max(256),
  effective_as_of: IsoDatetimeStringSchema,
  supporting_receipt_ids: z.array(NonEmptyStringSchema.max(256)).readonly(),
  supporting_proof_witnesses: z.array(ProofEffectWitnessSchema).readonly(),
  governance_frontier: FieldContractDigestSchema,
  policy_operator_id: NonEmptyStringSchema.max(128),
  policy_operator_version: NonEmptyStringSchema.max(64)
}).strict().readonly();

export const EffectDecisionReceiptSchema = FieldReceiptContractFieldsSchema.extend({
  schema_version: z.literal(2),
  workspace_id: BoundedIdSchema,
  actor_id: BoundedIdSchema,
  run_id: BoundedIdSchema,
  delivery_id: BoundedIdSchema,
  request_digest: FieldContractDigestSchema,
  action: NonEmptyStringSchema.max(128),
  target: NonEmptyStringSchema.max(256),
  scope: NonEmptyStringSchema.max(256),
  effective_as_of: IsoDatetimeStringSchema,
  decision: EffectDecisionSchema,
  supporting_receipt_ids: z.array(NonEmptyStringSchema.max(256)).readonly(),
  supporting_proof_witnesses: z.array(ProofEffectWitnessSchema).readonly(),
  governance_frontier: FieldContractDigestSchema,
  policy_operator_id: NonEmptyStringSchema.max(128),
  policy_operator_version: NonEmptyStringSchema.max(64),
  recorded_at: IsoDatetimeStringSchema
}).strict().readonly();

export type EffectDecision = z.infer<typeof EffectDecisionSchema>;
export type EffectRequest = z.infer<typeof EffectRequestSchema>;
export type EffectDecisionReceipt = z.infer<typeof EffectDecisionReceiptSchema>;
export type ProofEffectWitness = z.infer<typeof ProofEffectWitnessSchema>;

export function verifyEffectDecisionReceipt(
  receipt: EffectDecisionReceipt,
  sha256: FieldContractSha256
): EffectDecisionReceipt {
  assertFieldIdentity(
    receipt.governance_frontier,
    hashEffectGovernanceFrontier(receipt.supporting_proof_witnesses, sha256),
    "effect governance frontier"
  );
  assertFieldIdentity(receipt.identity, hashEffectRequestDigest(receipt, sha256), "effect request");
  assertFieldIdentity(
    receipt.request_digest,
    hashEffectRequestDigest(receipt, sha256),
    "effect request"
  );
  return receipt;
}
