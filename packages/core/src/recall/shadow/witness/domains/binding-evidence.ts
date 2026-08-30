import { digestRecallFieldIdentity, type RecallFieldDigest } from
  "../../../field/field-identity.js";

export const BINDING_RELATION_EVIDENCE_OPERATOR_ID =
  "binding_relation_evidence_v1" as const;

export type BindingConcreteRelation = "equal" | "distinct";

export type BindingSourceObservationReceiptV1 = Readonly<{
  readonly schema_version: 1;
  readonly source_owner: string;
  readonly source_observation_id: string;
  readonly source_id: string;
  readonly producer_operator_id: string;
  readonly producer_operator_version: string;
  readonly observation_digest: RecallFieldDigest;
}>;

export type BindingRelationEvidenceReceiptV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof BINDING_RELATION_EVIDENCE_OPERATOR_ID;
  readonly relation: BindingConcreteRelation;
  readonly query_id: string;
  readonly snapshot_digest: string;
  readonly left_id: string;
  readonly right_id: string;
  readonly source_observation: BindingSourceObservationReceiptV1;
  readonly receipt_digest: RecallFieldDigest;
}>;

export type BindingRelationEvidenceVerifierV1 = Readonly<{
  readonly source_owner: string;
  readonly producer_operator_id: string;
  readonly producer_operator_version: string;
  verifySourceObservation(receipt: BindingSourceObservationReceiptV1): boolean;
}>;

export function verifyBindingRelationEvidenceReceiptV1(
  receipt: BindingRelationEvidenceReceiptV1,
  verifier: BindingRelationEvidenceVerifierV1
): boolean {
  if (receipt.schema_version !== 1
      || receipt.operator_id !== BINDING_RELATION_EVIDENCE_OPERATOR_ID
      || receipt.source_observation.source_owner !== verifier.source_owner
      || receipt.source_observation.producer_operator_id !== verifier.producer_operator_id
      || receipt.source_observation.producer_operator_version
        !== verifier.producer_operator_version
      || !verifier.verifySourceObservation(receipt.source_observation)) return false;
  const { receipt_digest, ...body } = receipt;
  return digestRecallFieldIdentity(body) === receipt_digest;
}
