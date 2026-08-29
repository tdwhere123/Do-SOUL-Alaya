import {
  verifySnapshotCoherenceReceiptV1,
  type SnapshotCoherenceReceiptV1,
  type SnapshotVectorV1
} from "../../../runtime/snapshot-coherence/index.js";
import type { SupportDraft } from "./draft.js";
import { addEdge, addGap, addNode } from "./draft.js";
import type {
  SupportCandidateReceiptV1,
  SupportMaterializationInputV1,
  SupportRelationalReceiptV1,
  SupportRelationalSubjectV1
} from "./types.js";

export function adaptPathProjection(
  draft: SupportDraft,
  candidate: SupportCandidateReceiptV1,
  input: SupportMaterializationInputV1
): void {
  const path = candidate.path;
  if (path === undefined) return;
  for (const evidenceId of path.evidence_basis) {
    addNode(draft, "evidence_unit", evidenceId);
  }
  if (path.proposition_id === undefined) {
    addGap(
      draft,
      "path_projection_not_proposition",
      candidate.candidate_key,
      "PathRelation is a projection; relation_kind/energy/hop are not proposition truth"
    );
    return;
  }
  if (!admitRelationalReceipt(draft, candidate.candidate_key, path.receipt, input, {
    kind: "path_projection",
    proposition_id: path.proposition_id,
    relation_kind: path.relation_kind
  })) {
    return;
  }
  addNode(draft, "proposition", path.proposition_id);
  for (const evidenceId of path.evidence_basis) {
    addEdge(draft, "grounds", "evidence_unit", evidenceId, "proposition", path.proposition_id);
  }
}

export function admitRelationalReceipt(
  draft: SupportDraft,
  owner: string,
  receipt: SupportRelationalReceiptV1 | undefined,
  input: SupportMaterializationInputV1,
  expectedSubject: SupportRelationalSubjectV1
): boolean {
  const context = input.authority_context;
  if (receipt === undefined || context === undefined) {
    addGap(draft, "authority_untrusted", owner, "relational receipt authority is absent");
    return false;
  }
  const snapshot = context.snapshot_receipt;
  if (!hasBoundIdentity(receipt, input, snapshot, context.snapshot_vector)) {
    addGap(draft, "relational_identity_mismatch", owner, "relational receipt is not bound to this query snapshot");
    return false;
  }
  if (!hasExpectedSubject(receipt.subject, expectedSubject)) {
    addGap(draft, "relational_identity_mismatch", owner, "relational receipt subject identity does not match");
    return false;
  }
  if (receipt.transaction_frontier !== context.snapshot_vector.transaction_frontier
      || receipt.transaction_frontier.trim().length === 0) {
    addGap(draft, "transaction_unfrozen", owner, "relational receipt transaction frontier is not frozen");
    return false;
  }
  if (!hasAuthority(receipt, snapshot)) {
    addGap(draft, "authority_untrusted", owner, "relational receipt authority is not admitted by the snapshot");
    return false;
  }
  return admitValidTime(draft, owner, receipt);
}

function hasExpectedSubject(
  actual: SupportRelationalSubjectV1,
  expected: SupportRelationalSubjectV1
): boolean {
  if (actual.kind !== expected.kind
      || actual.proposition_id !== expected.proposition_id) return false;
  if (actual.kind === "path_projection" && expected.kind === "path_projection") {
    return actual.relation_kind === expected.relation_kind;
  }
  if (actual.kind === "supersession" && expected.kind === "supersession") {
    return actual.lineage_id === expected.lineage_id
      && actual.counterpart_proposition_id === expected.counterpart_proposition_id;
  }
  return actual.kind !== "path_projection" && expected.kind !== "path_projection"
    && actual.lineage_id === expected.lineage_id;
}

function hasBoundIdentity(
  receipt: SupportRelationalReceiptV1,
  input: SupportMaterializationInputV1,
  snapshot: SnapshotCoherenceReceiptV1,
  vector: SnapshotVectorV1
): boolean {
  try {
    verifySnapshotCoherenceReceiptV1(snapshot, vector);
  } catch {
    return false;
  }
  return receipt.schema_version === 1
    && snapshot.schema_version === 1
    && snapshot.operator_id === "recall_snapshot_coherence_v1"
    && receipt.query_id === input.query_id
    && receipt.snapshot_digest === input.snapshot_digest
    && receipt.snapshot_digest === vector.vector_digest
    && receipt.snapshot_receipt_digest === snapshot.receipt_digest
    && receipt.effective_as_of === snapshot.effective_as_of;
}

function hasAuthority(
  receipt: SupportRelationalReceiptV1,
  snapshot: SnapshotCoherenceReceiptV1
): boolean {
  return snapshot.coherence_state === "coherent_exact"
    && snapshot.authorized_scopes.includes(receipt.authorized_scope)
    && receipt.authorized_scope.trim().length > 0
    && receipt.producer_operator_id.trim().length > 0;
}

function admitValidTime(
  draft: SupportDraft,
  owner: string,
  receipt: SupportRelationalReceiptV1
): boolean {
  const asOf = Date.parse(receipt.effective_as_of);
  const validity = receipt.valid_time;
  if (!Number.isFinite(asOf) || validity.kind === "unknown") {
    addGap(draft, "time_unknown", owner, "relational valid time is absent or invalid");
    return false;
  }
  if (validity.kind === "timeless") return true;
  const from = Date.parse(validity.from);
  const to = validity.kind === "bounded" ? Date.parse(validity.to) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(from) || (validity.kind === "bounded" && !Number.isFinite(to))) {
    addGap(draft, "time_unknown", owner, "relational valid time is absent or invalid");
    return false;
  }
  if (from > asOf || asOf >= to || from >= to) {
    addGap(draft, "time_not_active", owner, "relational receipt is inactive at effective_as_of");
    return false;
  }
  return true;
}

export function adaptTemporal(
  draft: SupportDraft,
  candidate: SupportCandidateReceiptV1
): void {
  const temporal = candidate.temporal;
  if (temporal === undefined) return;
  if (temporal.time_status === "unknown" || temporal.event_time === null) {
    addGap(draft, "time_unknown", candidate.candidate_key, "unknown time cannot be an extremum or active relation");
    return;
  }
  const validity = candidate.validity;
  if (validity?.status === "available" && validity.value.validity !== "active") {
    addGap(draft, "time_not_active", candidate.candidate_key, `validity ${validity.value.validity} is not active`);
  }
}

export function adaptEvidenceAndF3(
  draft: SupportDraft,
  candidate: SupportCandidateReceiptV1
): void {
  for (const evidenceId of candidate.evidence_ids ?? []) {
    addNode(draft, "evidence_unit", evidenceId);
  }
  if (candidate.f3_present === false) {
    addGap(draft, "f3_absent", candidate.candidate_key, "F3 absence does not drop F0-F2 evidence");
  }
  const support = candidate.answer_support;
  if (support === undefined) return;
  addNode(draft, "candidate_projection", candidate.candidate_key);
  if (support.eligible && support.evidence_ref === null) {
    addGap(draft, "binding_absent", candidate.candidate_key, "answer support is not semantic binding identity");
  }
  if (support.evidence_ref !== null) {
    addNode(draft, "evidence_unit", support.evidence_ref);
  }
}
