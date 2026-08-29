import { digestRecallFieldIdentity } from "../../../field/field-identity.js";
import {
  readSnapshotLeaseCapability,
  verifySnapshotCoherenceReceiptV1
} from "../../../runtime/snapshot-coherence/index.js";
import type {
  SupportMaterializationInputV1,
  SupportMaterializationOutcomeV1,
  SupportRelationalReceiptV1,
  SupportRelationalSourceVerifierV1,
  SupportRelationalSubjectV1
} from "./types.js";

export const SUPPORT_RELATIONAL_RECEIPT_OPERATOR_ID =
  "support_relational_receipt_v1" as const;

type AuthorityContext = NonNullable<SupportMaterializationInputV1["authority_context"]>;
type MalformedCode = Extract<SupportMaterializationOutcomeV1, {
  readonly status: "malformed";
}>["contract_code"];

export type RelationalAuthorityVerificationV1 =
  | Readonly<{ readonly status: "admitted" }>
  | Readonly<{
      readonly status: "producer_unavailable";
      readonly reason:
        | "authority_context_absent"
        | "source_view_unavailable"
        | "source_verifier_unavailable";
    }>
  | Readonly<{ readonly status: "malformed"; readonly contract_code: MalformedCode }>;

export function verifySupportRelationalReceiptV1(
  receipt: SupportRelationalReceiptV1,
  input: SupportMaterializationInputV1,
  expectedSubject: SupportRelationalSubjectV1
): RelationalAuthorityVerificationV1 {
  const context = input.authority_context;
  if (context === undefined) {
    return unavailable("authority_context_absent");
  }
  if (!hasValidReceiptDigest(receipt)) return malformed("receipt_digest_mismatch");
  try {
    verifySnapshotCoherenceReceiptV1(context.snapshot_receipt, context.snapshot_vector);
  } catch {
    return malformed("snapshot_authority_mismatch");
  }
  if (!matchesSnapshotAuthority(receipt, input, context)) {
    return malformed("snapshot_authority_mismatch");
  }
  if (!sameSubject(receipt.subject, expectedSubject)) {
    return malformed("subject_identity_mismatch");
  }
  let capability;
  try {
    capability = readSnapshotLeaseCapability(context.read_lease, receipt.source_owner);
  } catch {
    return malformed("source_capability_mismatch");
  }
  if (capability.view_kind === "unavailable"
      || capability.declaration.lag_bound.kind === "unavailable") {
    return unavailable("source_view_unavailable");
  }
  const verifier = context.relational_source_verifiers?.find(
    (candidate) => candidate.source_owner === receipt.source_owner
  );
  if (verifier === undefined) return unavailable("source_verifier_unavailable");
  if (!matchesSourceObservation(receipt, verifier, expectedSubject)) {
    return malformed("source_observation_mismatch");
  }
  if (context.snapshot_receipt.coherence_state !== "coherent_exact") {
    return malformed("snapshot_authority_mismatch");
  }
  if (!matchesCapability(receipt, capability, context)) {
    return malformed("source_capability_mismatch");
  }
  if (digestRecallFieldIdentity(receipt.valid_time_domain)
      !== digestRecallFieldIdentity(capability.declaration.valid_time_domain)) {
    return malformed("valid_time_domain_mismatch");
  }
  return Object.freeze({ status: "admitted" });
}

function matchesSourceObservation(
  receipt: SupportRelationalReceiptV1,
  verifier: SupportRelationalSourceVerifierV1,
  expectedSubject: SupportRelationalSubjectV1
): boolean {
  const observation = receipt.source_observation;
  return verifier.allowed_subject_kinds.includes(expectedSubject.kind)
    && observation.source_owner === verifier.source_owner
    && sameSubject(observation.subject, expectedSubject)
    && observation.source_frontier === receipt.source_frontier
    && observation.generation === receipt.generation
    && observation.producer_operator_id === receipt.producer_operator_id
    && observation.producer_operator_version === receipt.producer_operator_version
    && verifier.verifySourceObservation(observation);
}

function hasValidReceiptDigest(receipt: SupportRelationalReceiptV1): boolean {
  if (receipt.schema_version !== 1 || receipt.operator_id !== SUPPORT_RELATIONAL_RECEIPT_OPERATOR_ID) {
    return false;
  }
  const { receipt_digest, ...body } = receipt;
  return digestRecallFieldIdentity(body) === receipt_digest;
}

function matchesSnapshotAuthority(
  receipt: SupportRelationalReceiptV1,
  input: SupportMaterializationInputV1,
  context: AuthorityContext
): boolean {
  const vector = context.snapshot_vector;
  const lease = context.read_lease;
  return lease.state === "finalized"
    && lease.vector_digest === vector.vector_digest
    && receipt.query_id === input.query_id
    && receipt.snapshot_digest === input.snapshot_digest
    && receipt.snapshot_digest === vector.vector_digest
    && receipt.snapshot_receipt_digest === context.snapshot_receipt.receipt_digest
    && receipt.snapshot_lease_id === lease.lease_id
    && receipt.effective_as_of === vector.effective_as_of
    && receipt.transaction_frontier === vector.transaction_frontier
    && receipt.principal === lease.principal
    && lease.authorized_scopes.includes(receipt.authorized_scope);
}

function matchesCapability(
  receipt: SupportRelationalReceiptV1,
  capability: ReturnType<typeof readSnapshotLeaseCapability>,
  context: AuthorityContext
): boolean {
  const declaration = capability.declaration;
  const producerVersion = context.snapshot_vector.formation_operator_versions
    .find(([operator]) => operator === receipt.producer_operator_id)?.[1];
  return receipt.source_owner === capability.source_owner
    && receipt.principal === declaration.principal
    && receipt.authorized_scope === declaration.authorized_scope
    && receipt.source_frontier === declaration.source_frontier
    && receipt.generation === declaration.generation
    && receipt.operator_or_model_version === declaration.operator_or_model_version
    && receipt.producer_operator_version === producerVersion
    && receipt.view_kind === capability.view_kind
    && digestRecallFieldIdentity(receipt.lag_bound) === digestRecallFieldIdentity(declaration.lag_bound)
    && receipt.source_receipt_digest === digestRecallFieldIdentity(receipt.source_observation);
}

function sameSubject(
  actual: SupportRelationalSubjectV1,
  expected: SupportRelationalSubjectV1
): boolean {
  return digestRecallFieldIdentity(actual) === digestRecallFieldIdentity(expected);
}

function unavailable(
  reason: Extract<RelationalAuthorityVerificationV1, {
    readonly status: "producer_unavailable";
  }>["reason"]
): RelationalAuthorityVerificationV1 {
  return Object.freeze({ status: "producer_unavailable" as const, reason });
}

function malformed(contract_code: MalformedCode): RelationalAuthorityVerificationV1 {
  return Object.freeze({ status: "malformed" as const, contract_code });
}
