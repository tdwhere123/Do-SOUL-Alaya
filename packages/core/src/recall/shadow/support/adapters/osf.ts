import type { SupportDraft } from "./draft.js";
import { addEdge, addGap, addNode } from "./draft.js";
import type {
  SupportCandidateReceiptV1,
  SupportOsfBindingV1,
  SupportOsfStatusV1
} from "./types.js";

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
  if (osf.composition_status !== "composed") {
    addOsfStatusGap(draft, candidate.candidate_key, osf.composition_status);
    return;
  }
  for (const binding of osf.bindings ?? []) {
    adaptOsfBinding(draft, candidate.candidate_key, binding);
  }
}

function addOsfStatusGap(
  draft: SupportDraft,
  owner: string,
  status: SupportOsfStatusV1
): void {
  if (status === "no_match") {
    addGap(draft, "osf_no_match", owner, "no_match is not known-zero");
    return;
  }
  if (status === "ineligible") {
    addGap(draft, "osf_ineligible", owner, "ineligible OSF is unknown, not empty");
    return;
  }
  if (status === "rejected") {
    addGap(draft, "osf_rejected", owner, "rejected OSF is unknown, not empty");
    return;
  }
  addGap(draft, "osf_unavailable", owner, "unavailable OSF is unknown, not empty");
}

function adaptOsfBinding(
  draft: SupportDraft,
  candidateKey: string,
  binding: SupportOsfBindingV1
): void {
  addNode(draft, "candidate_projection", candidateKey);
  addNode(draft, "evidence_unit", binding.evidence_id);
  recordOsfLineage(draft, binding);
  const bindingId = osfBindingId(binding);
  if (bindingId === undefined) {
    addGap(draft, "binding_absent", candidateKey, "OSF binding lacks semantic identity");
  } else {
    addNode(draft, "answer_binding", bindingId);
    addEdge(
      draft,
      "expresses",
      "candidate_projection",
      candidateKey,
      "answer_binding",
      bindingId
    );
  }
  const propositionId = binding.query_proposition_id;
  if (propositionId === undefined || propositionId.length === 0) {
    addGap(
      draft,
      "binding_absent",
      candidateKey,
      "query proposition pin is absent; binding lemma is not a proposition"
    );
    return;
  }
  addNode(draft, "proposition", propositionId);
  if (bindingId !== undefined) {
    addEdge(draft, "yields", "answer_binding", bindingId, "proposition", propositionId);
  }
  addEdge(draft, "grounds", "evidence_unit", binding.evidence_id, "proposition", propositionId);
}

function osfBindingId(binding: SupportOsfBindingV1): string | undefined {
  if (binding.semantic_identity.length > 0) return binding.semantic_identity;
  return undefined;
}

function recordOsfLineage(draft: SupportDraft, binding: SupportOsfBindingV1): void {
  if (binding.source_lineage_id === undefined) return;
  addNode(draft, "source_lineage", binding.source_lineage_id);
  addEdge(
    draft,
    "sourced_from",
    "evidence_unit",
    binding.evidence_id,
    "source_lineage",
    binding.source_lineage_id
  );
  draft.evidenceLineage.set(binding.evidence_id, binding.source_lineage_id);
}
