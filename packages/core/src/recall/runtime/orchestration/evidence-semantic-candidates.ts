import { OWNER_GIST_SEMANTIC_DOCUMENT_IDENTITY } from "@do-soul/alaya-protocol";
import type { EvidenceEmbeddingCandidate } from
  "../../../embedding-recall/embedding-recall-service.js";
import type { EvidenceCandidateScoringWinner } from
  "../../../embedding-recall/types.js";
import type {
  EvidenceCandidateScoringReceipt,
  EvidenceCandidateScoringSelectionReceipt
} from
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

const OWNER_GIST_MEMORY_LIMIT = 16;
const EVIDENCE_FULL_MEMORY_LIMIT = 32;

export function buildEvidenceSemanticCandidateSelection(params: Readonly<{
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly evidenceDocumentsByMemoryId: Readonly<
    Record<string, readonly Readonly<RecallEvidenceSemanticDocument>[]>
  >;
  readonly includeOwnerGist?: boolean;
}>): Readonly<{
  readonly candidates: readonly Readonly<EvidenceEmbeddingCandidate>[];
  readonly receipt: Readonly<EvidenceCandidateScoringSelectionReceipt>;
}> {
  const inputCandidateKeys = orderedMemoryCandidateKeys(params.candidates);
  const ownerGistCandidateKeys = params.includeOwnerGist === false
    ? []
    : inputCandidateKeys.slice(0, OWNER_GIST_MEMORY_LIMIT);
  const fullEvidenceCandidateKeys = inputCandidateKeys.slice(0, EVIDENCE_FULL_MEMORY_LIMIT);
  return Object.freeze({
    candidates: projectEvidenceSemanticCandidates({
      ...params,
      ownerGistCandidateKeys: new Set(ownerGistCandidateKeys),
      fullEvidenceCandidateKeys: new Set(fullEvidenceCandidateKeys)
    }),
    receipt: Object.freeze({
      schema_version: 1,
      operator_id: "ordered_candidate_prefix_v1",
      input_candidate_keys: Object.freeze(inputCandidateKeys),
      owner_gist_enabled: params.includeOwnerGist !== false,
      owner_gist_candidate_keys: Object.freeze(ownerGistCandidateKeys),
      full_evidence_candidate_keys: Object.freeze(fullEvidenceCandidateKeys),
      owner_gist_limit: OWNER_GIST_MEMORY_LIMIT,
      full_evidence_limit: EVIDENCE_FULL_MEMORY_LIMIT,
      input_memory_count: inputCandidateKeys.length,
      owner_gist_selected_count: ownerGistCandidateKeys.length,
      full_evidence_selected_count: fullEvidenceCandidateKeys.length,
      owner_gist_excluded_count: params.includeOwnerGist === false
        ? 0
        : Math.max(0, inputCandidateKeys.length - OWNER_GIST_MEMORY_LIMIT),
      full_evidence_excluded_count:
        Math.max(0, inputCandidateKeys.length - EVIDENCE_FULL_MEMORY_LIMIT)
    })
  });
}

function projectEvidenceSemanticCandidates(params: Readonly<{
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly evidenceDocumentsByMemoryId: Readonly<
    Record<string, readonly Readonly<RecallEvidenceSemanticDocument>[]>
  >;
  readonly includeOwnerGist?: boolean;
  readonly ownerGistCandidateKeys?: ReadonlySet<string>;
  readonly fullEvidenceCandidateKeys?: ReadonlySet<string>;
}>): readonly Readonly<EvidenceEmbeddingCandidate>[] {
  return Object.freeze(params.candidates.flatMap((candidate) => {
    if (candidate.objectKind === "evidence_capsule") {
      return [directEvidenceCandidate(candidate)];
    }
    if (!isWorkspaceMemoryCandidate(candidate)) return [];
    const memoryId = candidate.entry.object_id;
    const candidateKey = buildRecallCandidateDedupeKey(candidate);
    const documents = params.evidenceDocumentsByMemoryId[memoryId] ?? [];
    const allowGist = params.includeOwnerGist !== false &&
      (params.ownerGistCandidateKeys === undefined ||
        params.ownerGistCandidateKeys.has(candidateKey));
    const allowLeaveOneOut = params.fullEvidenceCandidateKeys === undefined ||
      params.fullEvidenceCandidateKeys.has(candidateKey);
    return selectEvidenceDocuments(documents, allowGist, allowLeaveOneOut)
      .map((document) => linkedEvidenceCandidate(candidate, document));
  }));
}

function orderedMemoryCandidateKeys(
  candidates: readonly Readonly<CoarseRecallCandidate>[]
): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    if (!isWorkspaceMemoryCandidate(candidate)) continue;
    const key = buildRecallCandidateDedupeKey(candidate);
    if (seen.has(key)) continue;
    seen.add(key);
    keys.push(key);
  }
  return keys;
}

function selectEvidenceDocuments(
  documents: readonly Readonly<RecallEvidenceSemanticDocument>[],
  allowGist: boolean,
  allowLeaveOneOut: boolean
): readonly Readonly<RecallEvidenceSemanticDocument>[] {
  const selected: RecallEvidenceSemanticDocument[] = [];
  for (const document of documents) {
    if (
      document.documentIdentity === OWNER_GIST_SEMANTIC_DOCUMENT_IDENTITY &&
      !allowGist
    ) {
      continue;
    }
    if (!allowLeaveOneOut && isLeaveOneSlotOutDocument(document)) continue;
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
