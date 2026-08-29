import type { SupportDraft } from "./draft.js";
import { addEdge, addGap, addNode, addOutcome } from "./draft.js";
import { verifySupportRelationalReceiptV1 } from "./relational-authority.js";
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
  const sourceOwner = receipt?.source_owner ?? expectedSubject.kind;
  if (receipt === undefined) {
    addGap(draft, "authority_untrusted", owner, "relational receipt authority is absent");
    addOutcome(draft, {
      status: "not_observed",
      owner,
      source_owner: sourceOwner,
      reason: "receipt_absent"
    });
    return false;
  }
  const verification = verifySupportRelationalReceiptV1(receipt, input, expectedSubject);
  if (verification.status === "producer_unavailable") {
    addGap(draft, "authority_untrusted", owner, verification.reason);
    addOutcome(draft, {
      status: "producer_unavailable",
      owner,
      source_owner: sourceOwner,
      reason: verification.reason
    });
    return false;
  }
  if (verification.status === "malformed") {
    addGap(draft, "relational_identity_mismatch", owner, verification.contract_code);
    addOutcome(draft, {
      status: "malformed",
      owner,
      source_owner: sourceOwner,
      contract_code: verification.contract_code
    });
    return false;
  }
  return admitValidTime(draft, owner, receipt);
}

function admitValidTime(
  draft: SupportDraft,
  owner: string,
  receipt: SupportRelationalReceiptV1
): boolean {
  const asOf = Date.parse(receipt.effective_as_of);
  const validity = receipt.valid_time_domain;
  if (!Number.isFinite(asOf)) {
    addGap(draft, "time_unknown", owner, "relational valid time is absent or invalid");
    return false;
  }
  if (validity.kind === "timeless") {
    addObservedOutcome(draft, owner, receipt);
    return true;
  }
  const from = Date.parse(validity.from);
  const to = validity.kind === "bounded" ? Date.parse(validity.to) : Number.POSITIVE_INFINITY;
  if (!Number.isFinite(from) || (validity.kind === "bounded" && !Number.isFinite(to))) {
    addGap(draft, "time_unknown", owner, "relational valid time is absent or invalid");
    return false;
  }
  if (from > asOf || asOf >= to || from >= to) {
    addGap(draft, "time_not_active", owner, "relational receipt is inactive at effective_as_of");
    addOutcome(draft, {
      status: "not_observed",
      owner,
      source_owner: receipt.source_owner,
      reason: "inactive_at_effective_as_of"
    });
    return false;
  }
  addObservedOutcome(draft, owner, receipt);
  return true;
}

function addObservedOutcome(
  draft: SupportDraft,
  owner: string,
  receipt: SupportRelationalReceiptV1
): void {
  addOutcome(draft, {
    status: "observed",
    owner,
    source_owner: receipt.source_owner,
    receipt_digest: receipt.receipt_digest
  });
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
