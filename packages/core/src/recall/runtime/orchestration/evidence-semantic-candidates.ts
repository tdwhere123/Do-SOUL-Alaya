import { OWNER_GIST_SEMANTIC_DOCUMENT_IDENTITY } from "@do-soul/alaya-protocol";

export const OWNER_GIST_MEMORY_LIMIT = 16;
export const EVIDENCE_FULL_MEMORY_LIMIT = 32;
import type { EvidenceEmbeddingCandidate } from
  "../../../embedding-recall/embedding-recall-service.js";
import type { EvidenceCandidateScoringWinner } from
  "../../../embedding-recall/types.js";
import type { EvidenceCandidateScoringReceipt } from
  "../../../embedding-recall/types.js";
import {
  buildRecallCandidateDedupeKey,
  isWorkspaceMemoryCandidate
} from "../recall-service-helpers.js";
import type { CoarseRecallCandidate } from "../recall-service-types.js";
import type {
  RecallEvidenceSemanticDocument,
  RecallEvidenceSemanticActivationReceipt,
  RecallEvidenceSemanticWinnerReceipt
} from "../recall-service-types.js";

export function buildEvidenceSemanticCandidates(params: Readonly<{
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly evidenceDocumentsByMemoryId: Readonly<
    Record<string, readonly Readonly<RecallEvidenceSemanticDocument>[]>
  >;
  readonly includeOwnerGist?: boolean;
  readonly ownerGistMemoryIds?: ReadonlySet<string>;
  readonly fullEvidenceMemoryIds?: ReadonlySet<string>;
}>): readonly Readonly<EvidenceEmbeddingCandidate>[] {
  return Object.freeze(params.candidates.flatMap((candidate) => {
    if (candidate.objectKind === "evidence_capsule") {
      return [directEvidenceCandidate(candidate)];
    }
    if (!isWorkspaceMemoryCandidate(candidate)) return [];
    const memoryId = candidate.entry.object_id;
    const documents = params.evidenceDocumentsByMemoryId[memoryId] ?? [];
    const allowGist = params.includeOwnerGist !== false &&
      (params.ownerGistMemoryIds === undefined ||
        params.ownerGistMemoryIds.has(memoryId));
    const allowLeaveOneOut = params.fullEvidenceMemoryIds === undefined ||
      params.fullEvidenceMemoryIds.has(memoryId);
    return selectDistinctEvidenceDocuments(documents, allowGist, allowLeaveOneOut)
      .map((document) => linkedEvidenceCandidate(candidate, document));
  }));
}

export function selectOwnerGistMemoryIds(
  scoresByObjectId: Readonly<Record<string, number>> | undefined,
  limit = OWNER_GIST_MEMORY_LIMIT
): ReadonlySet<string> | undefined {
  return selectTopPoolMemoryIds(scoresByObjectId, limit);
}

export function selectTopPoolMemoryIds(
  scoresByObjectId: Readonly<Record<string, number>> | undefined,
  limit: number
): ReadonlySet<string> | undefined {
  if (scoresByObjectId === undefined) return undefined;
  const ranked = Object.entries(scoresByObjectId)
    .filter(([, score]) => Number.isFinite(score) && score > 0)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]));
  if (ranked.length === 0) return undefined;
  return new Set(ranked.slice(0, limit).map(([objectId]) => objectId));
}

function selectDistinctEvidenceDocuments(
  documents: readonly Readonly<RecallEvidenceSemanticDocument>[],
  allowGist: boolean,
  allowLeaveOneOut: boolean
): readonly Readonly<RecallEvidenceSemanticDocument>[] {
  const selected: RecallEvidenceSemanticDocument[] = [];
  const seenContent = new Set<string>();
  for (const document of documents) {
    if (
      document.documentIdentity === OWNER_GIST_SEMANTIC_DOCUMENT_IDENTITY &&
      !allowGist
    ) {
      continue;
    }
    if (!allowLeaveOneOut && isLeaveOneSlotOutDocument(document)) continue;
    if (seenContent.has(document.content)) continue;
    seenContent.add(document.content);
    selected.push(document);
  }
  return selected;
}

function isLeaveOneSlotOutDocument(
  document: Readonly<RecallEvidenceSemanticDocument>
): boolean {
  const forms = document.projection.matched_fact_key_forms;
  return forms.some((form) => form.kind === "leave_one_slot_out") &&
    !forms.some((form) => form.kind === "complete");
}

export function attributeEvidenceSemanticActivations(params: Readonly<{
  readonly activations: ReadonlyMap<
    string,
    Readonly<EvidenceCandidateScoringReceipt>
  >;
  readonly evidenceDocumentsByMemoryId: Readonly<
    Record<string, readonly Readonly<RecallEvidenceSemanticDocument>[]>
  >;
}>): ReadonlyMap<string, Readonly<RecallEvidenceSemanticActivationReceipt>> {
  const documents = new Map<string, Readonly<RecallEvidenceSemanticDocument>>();
  for (const entries of Object.values(params.evidenceDocumentsByMemoryId)) {
    for (const document of entries) {
      documents.set(documentLookupKey(document.evidenceRef, document.documentIdentity), document);
    }
  }
  return new Map([...params.activations].map(([candidateKey, activation]) => {
    const observations = Object.freeze(activation.observations.map((observation) =>
      attributeObservation(observation, documents)
    ));
    const winner = observations.find((observation) =>
      sameObservation(observation, activation.winner)
    )!;
    return [candidateKey, Object.freeze({
      ...activation,
      winner,
      observations
    })] as const;
  }));
}

function attributeObservation(
  observation: Readonly<EvidenceCandidateScoringWinner>,
  documents: ReadonlyMap<string, Readonly<RecallEvidenceSemanticDocument>>
): Readonly<RecallEvidenceSemanticWinnerReceipt> {
  const document = documents.get(documentLookupKey(
    observation.evidenceObjectId,
    observation.documentIdentity
  ));
  return Object.freeze({
    ...observation,
    projection: document?.projection ?? null
  });
}

function sameObservation(
  left: Readonly<RecallEvidenceSemanticWinnerReceipt>,
  right: Readonly<EvidenceCandidateScoringWinner>
): boolean {
  return left.score === right.score &&
    left.evidenceObjectId === right.evidenceObjectId &&
    left.documentIdentity === right.documentIdentity;
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
