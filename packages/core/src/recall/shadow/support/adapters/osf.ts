import type { SupportDraft } from "./draft.js";
import { addEdge, addGap, addNode, vote } from "./draft.js";
import type { SupportCandidateReceiptV1, SupportOsfBindingV1 } from "./types.js";

export function adaptOsfCandidate(
  draft: SupportDraft,
  candidate: SupportCandidateReceiptV1
): void {
  const osf = candidate.osf;
  if (osf === undefined) {
    addGap(draft, "write_side_formation_absent", candidate.candidate_key, "osf receipt absent");
    return;
  }
  if (osf.truncated) {
    addGap(draft, "osf_truncated", candidate.candidate_key, "truncated OSF is unknown, not empty");
    return;
  }
  if (osf.composition_status === "unavailable" || osf.composition_status === "absent") {
    addGap(draft, "osf_unavailable", candidate.candidate_key, "unavailable OSF is unknown, not empty");
    return;
  }
  if (osf.composition_status !== "composed") {
    if (osf.composition_status === "no_match") {
      addGap(draft, "osf_no_match", candidate.candidate_key, "no_match is not known-zero");
    }
    return;
  }
  for (const binding of osf.bindings ?? []) {
    adaptOsfBinding(draft, candidate.candidate_key, binding);
  }
}

function adaptOsfBinding(
  draft: SupportDraft,
  candidateKey: string,
  binding: SupportOsfBindingV1
): void {
  const propositionId = binding.query_proposition_id ?? binding.semantic_identity;
  addNode(draft, "candidate_projection", candidateKey);
  addNode(draft, "answer_binding", binding.semantic_identity);
  addNode(draft, "proposition", propositionId);
  addNode(draft, "evidence_unit", binding.evidence_id);
  addEdge(draft, "expresses", "candidate_projection", candidateKey, "answer_binding", binding.semantic_identity);
  addEdge(draft, "yields", "answer_binding", binding.semantic_identity, "proposition", propositionId);
  addEdge(draft, "grounds", "evidence_unit", binding.evidence_id, "proposition", propositionId);
  addEdge(draft, "supports", "evidence_unit", binding.evidence_id, "proposition", propositionId);
  vote(draft, propositionId, binding.source_lineage_id ?? binding.evidence_id, "support");
  if (binding.source_lineage_id !== undefined) {
    addNode(draft, "source_lineage", binding.source_lineage_id);
    addEdge(draft, "sourced_from", "evidence_unit", binding.evidence_id, "source_lineage", binding.source_lineage_id);
    draft.evidenceLineage.set(binding.evidence_id, binding.source_lineage_id);
  }
}
