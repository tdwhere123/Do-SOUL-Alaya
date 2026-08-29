import type { SupportDraft } from "./draft.js";
import { addEdge, addGap, addNode } from "./draft.js";
import type { SupportCandidateReceiptV1 } from "./types.js";

export function adaptFactFrames(
  draft: SupportDraft,
  candidate: SupportCandidateReceiptV1
): void {
  if (candidate.fact_frames === undefined) return;
  addNode(draft, "candidate_projection", candidate.candidate_key);
  for (const frame of candidate.fact_frames) {
    if (frame.semantic_identity.length === 0) {
      addGap(draft, "binding_absent", candidate.candidate_key, "fact frame lacks semantic identity");
      continue;
    }
    addNode(draft, "answer_binding", frame.semantic_identity);
    addEdge(
      draft,
      "expresses",
      "candidate_projection",
      candidate.candidate_key,
      "answer_binding",
      frame.semantic_identity
    );
    if (frame.evidence_id !== undefined) {
      addNode(draft, "evidence_unit", frame.evidence_id);
    }
  }
}
