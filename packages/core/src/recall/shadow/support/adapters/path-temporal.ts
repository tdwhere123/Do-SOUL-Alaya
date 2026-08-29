import type { SupportDraft } from "./draft.js";
import { addEdge, addGap, addNode } from "./draft.js";
import type { SupportCandidateReceiptV1 } from "./types.js";

export function adaptPathProjection(
  draft: SupportDraft,
  candidate: SupportCandidateReceiptV1
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
  addNode(draft, "proposition", path.proposition_id);
  for (const evidenceId of path.evidence_basis) {
    addEdge(draft, "grounds", "evidence_unit", evidenceId, "proposition", path.proposition_id);
  }
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
