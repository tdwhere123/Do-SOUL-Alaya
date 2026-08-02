import type { EvidenceEmbeddingCandidate } from
  "../../../embedding-recall/embedding-recall-service.js";
import {
  buildRecallCandidateDedupeKey,
  isWorkspaceMemoryCandidate
} from "../recall-service-helpers.js";
import type { CoarseRecallCandidate } from "../recall-service-types.js";
import type { RecallEvidenceSemanticDocument } from
  "../../supplements/evidence/evidence-contexts.js";

export function buildEvidenceSemanticCandidates(params: Readonly<{
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly evidenceDocumentsByMemoryId: Readonly<
    Record<string, readonly Readonly<RecallEvidenceSemanticDocument>[]>
  >;
}>): readonly Readonly<EvidenceEmbeddingCandidate>[] {
  return Object.freeze(params.candidates.flatMap((candidate) => {
    if (candidate.objectKind === "evidence_capsule") {
      return [directEvidenceCandidate(candidate)];
    }
    if (!isWorkspaceMemoryCandidate(candidate)) return [];
    const documents = params.evidenceDocumentsByMemoryId[candidate.entry.object_id] ?? [];
    return documents.map((document) => linkedEvidenceCandidate(candidate, document));
  }));
}

function directEvidenceCandidate(
  candidate: Readonly<CoarseRecallCandidate>
): Readonly<EvidenceEmbeddingCandidate> {
  return Object.freeze({
    candidateKey: buildRecallCandidateDedupeKey(candidate),
    evidenceObjectId: candidate.entry.object_id,
    documentIdentity: candidate.evidenceDocumentIdentity ?? "owner",
    content: candidate.entry.content
  });
}

function linkedEvidenceCandidate(
  candidate: Readonly<CoarseRecallCandidate>,
  document: Readonly<RecallEvidenceSemanticDocument>
): Readonly<EvidenceEmbeddingCandidate> {
  return Object.freeze({
    candidateKey: buildRecallCandidateDedupeKey(candidate),
    evidenceObjectId: document.evidenceRef,
    documentIdentity: document.documentIdentity,
    content: document.content
  });
}
