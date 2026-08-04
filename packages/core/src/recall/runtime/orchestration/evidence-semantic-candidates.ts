import type { EvidenceEmbeddingCandidate } from
  "../../../embedding-recall/embedding-recall-service.js";
import type { EvidenceCandidateScoringWinner } from
  "../../../embedding-recall/types.js";
import {
  buildRecallCandidateDedupeKey,
  isWorkspaceMemoryCandidate
} from "../recall-service-helpers.js";
import type { CoarseRecallCandidate } from "../recall-service-types.js";
import type {
  RecallEvidenceSemanticDocument,
  RecallEvidenceSemanticWinnerReceipt
} from "../recall-service-types.js";

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

export function attributeEvidenceSemanticWinners(params: Readonly<{
  readonly winners: ReadonlyMap<string, Readonly<EvidenceCandidateScoringWinner>>;
  readonly evidenceDocumentsByMemoryId: Readonly<
    Record<string, readonly Readonly<RecallEvidenceSemanticDocument>[]>
  >;
}>): ReadonlyMap<string, Readonly<RecallEvidenceSemanticWinnerReceipt>> {
  const documents = new Map<string, Readonly<RecallEvidenceSemanticDocument>>();
  for (const entries of Object.values(params.evidenceDocumentsByMemoryId)) {
    for (const document of entries) {
      documents.set(documentLookupKey(document.evidenceRef, document.documentIdentity), document);
    }
  }
  return new Map([...params.winners].flatMap(([candidateKey, winner]) => {
    const projection = resolveWinnerProjection(winner, documents);
    return [[candidateKey, Object.freeze({
      ...winner,
      projection
    })] as const];
  }));
}

function resolveWinnerProjection(
  winner: Readonly<EvidenceCandidateScoringWinner>,
  documents: ReadonlyMap<string, Readonly<RecallEvidenceSemanticDocument>>
) {
  const document = documents.get(documentLookupKey(
    winner.evidenceObjectId,
    winner.documentIdentity
  ));
  return document?.projection ?? null;
}

function documentLookupKey(evidenceRef: string, documentIdentity: string): string {
  return `${evidenceRef}\u0000${documentIdentity}`;
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
