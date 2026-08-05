import {
  assertValidEmbeddingBatch,
  clamp01,
  createCosineBatchScorer,
  toErrorMessage
} from "../helpers.js";
import { EVIDENCE_DOCUMENT_MAX_OPERATOR_ID } from "../constants.js";
import {
  EvidenceDocumentEmbeddingError,
  type EvidenceDocumentEmbeddingEngine
} from "./evidence-document-embedding-engine.js";
import type { QueryEmbeddingEngine } from "../query-embedding-engine.js";
import type {
  EmbeddingProviderPort,
  EvidenceCandidateScoringFailureClass,
  EvidenceCandidateScoringReceipt,
  EvidenceCandidateScoringResult,
  EvidenceCandidateScoringWinner,
  PreparedEmbeddingQueryHandle,
  ScoreEvidenceCandidatesParams
} from "../types.js";
import { buildEvidenceSemanticFieldCapture } from
  "../../recall/field/evidence-semantic-field-capture.js";

export interface EvidenceCandidateScoringDependencies {
  readonly provider: EmbeddingProviderPort;
  readonly documentEngine: EvidenceDocumentEmbeddingEngine;
  readonly queryEngine: Pick<QueryEmbeddingEngine, "prepareQueryEmbedding">;
  readonly queryTimeoutMs: number;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}

export async function scoreTransientEvidenceCandidates(
  params: ScoreEvidenceCandidatesParams,
  dependencies: EvidenceCandidateScoringDependencies
): Promise<EvidenceCandidateScoringResult> {
  const result = await scoreEvidenceCandidates(params, dependencies);
  return Object.freeze({
    ...result,
    fieldChannelCapture: buildEvidenceSemanticFieldCapture({
      request: params,
      provider: dependencies.provider,
      result
    })
  });
}

async function scoreEvidenceCandidates(
  params: ScoreEvidenceCandidatesParams,
  dependencies: EvidenceCandidateScoringDependencies
): Promise<EvidenceCandidateScoringResult> {
  const candidates = params.candidates;
  const startedAt = performance.now();
  if (candidates.length === 0) return scoringResult("not_applicable", 0, 0, 0, startedAt);
  if (!dependencies.provider.isAvailable) {
    return failedScoring(
      params, dependencies, candidates.length, 0, startedAt, "provider_unavailable"
    );
  }
  let inferenceCalls = 0;
  let failureClass: EvidenceCandidateScoringFailureClass = "query_embedding_failed";
  try {
    const prepared = params.preparedQuery ?? dependencies.queryEngine.prepareQueryEmbedding({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryText: params.queryText
    });
    if (params.preparedQuery === null && !prepared.cacheHit) inferenceCalls += 1;
    const queryEmbedding = await resolveQueryEmbedding(prepared, dependencies.queryTimeoutMs);
    failureClass = "candidate_embedding_failed";
    const documentBatch = await dependencies.documentEngine.embedDocuments({
      workspaceId: params.workspaceId,
      documents: candidates.map((candidate) => ({
        ownerObjectId: candidate.evidenceObjectId,
        documentIdentity: candidate.documentIdentity,
        content: candidate.content
      }))
    }, dependencies.queryTimeoutMs);
    inferenceCalls += documentBatch.inferenceCalls;
    const embeddings = documentBatch.embeddings;
    assertValidEmbeddingBatch(embeddings, candidates.length);
    const scoreCosine = createCosineBatchScorer(queryEmbedding);
    const activations = aggregateCandidateActivations(
      candidates,
      embeddings,
      scoreCosine
    );
    return scoringResult(
      "returned",
      candidates.length,
      candidates.length,
      inferenceCalls,
      startedAt,
      null,
      activations
    );
  } catch (error) {
    if (error instanceof EvidenceDocumentEmbeddingError) {
      inferenceCalls += error.inferenceCalls;
    }
    return failedScoring(
      params, dependencies, candidates.length, inferenceCalls, startedAt, failureClass, error
    );
  }
}

function aggregateCandidateActivations(
  candidates: ScoreEvidenceCandidatesParams["candidates"],
  embeddings: readonly Float32Array[],
  scoreCosine: (embedding: Float32Array) => number
): ReadonlyMap<string, Readonly<EvidenceCandidateScoringReceipt>> {
  const observations = new Map<
    string,
    Map<string, Readonly<EvidenceCandidateScoringWinner>>
  >();
  candidates.forEach((candidate, index) => {
    const observation = Object.freeze({
      score: clamp01(scoreCosine(embeddings[index]!)),
      evidenceObjectId: candidate.evidenceObjectId,
      documentIdentity: candidate.documentIdentity
    });
    const byIdentity = observations.get(candidate.candidateKey) ?? new Map();
    const identity = observationIdentity(observation);
    const current = byIdentity.get(identity);
    if (current === undefined || observation.score > current.score) {
      byIdentity.set(identity, observation);
    }
    observations.set(candidate.candidateKey, byIdentity);
  });
  return new Map([...observations].map(([candidateKey, byIdentity]) => {
    const ranked = Object.freeze([...byIdentity.values()].sort(compareWinners));
    const winner = ranked[0]!;
    return [candidateKey, Object.freeze({
      schema_version: 1,
      operator_id: EVIDENCE_DOCUMENT_MAX_OPERATOR_ID,
      state: "observed",
      score: winner.score,
      winner,
      observations: ranked,
      observation_completeness: "complete",
      missing_channel_policy: "no_op"
    })] as const;
  }));
}

function observationIdentity(
  observation: Readonly<EvidenceCandidateScoringWinner>
): string {
  return `${observation.evidenceObjectId}\u0000${observation.documentIdentity}`;
}

function compareWinners(
  left: Readonly<EvidenceCandidateScoringWinner>,
  right: Readonly<EvidenceCandidateScoringWinner>
): number {
  if (left.score !== right.score) return right.score - left.score;
  const evidenceOrder = compareText(left.evidenceObjectId, right.evidenceObjectId);
  return evidenceOrder !== 0
    ? evidenceOrder
    : compareText(left.documentIdentity, right.documentIdentity);
}

function compareText(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}

async function resolveQueryEmbedding(
  prepared: PreparedEmbeddingQueryHandle,
  timeoutMs: number
): Promise<Float32Array> {
  const snapshot = await settlePreparedQuery(prepared, timeoutMs);
  if (snapshot.status === "ready") {
    return snapshot.embedding;
  }
  if (snapshot.status === "failed") {
    throw new Error(snapshot.error_message ?? snapshot.reason);
  }
  throw new Error("query_embedding_pending");
}

function failedScoring(
  params: ScoreEvidenceCandidatesParams,
  dependencies: EvidenceCandidateScoringDependencies,
  expectedCount: number,
  inferenceCalls: number,
  startedAt: number,
  failureClass: EvidenceCandidateScoringFailureClass,
  error: unknown = failureClass
): EvidenceCandidateScoringResult {
  dependencies.warn("transient evidence embedding degraded", {
    workspace_id: params.workspaceId,
    run_id: params.runId,
    reason: "evidence_candidate_embedding_failed",
    failure_class: failureClass,
    error: toErrorMessage(error)
  });
  return scoringResult(
    "failed", expectedCount, 0, inferenceCalls, startedAt, failureClass
  );
}

function scoringResult(
  status: EvidenceCandidateScoringResult["status"],
  expectedCount: number,
  scoredCount: number,
  inferenceCalls: number,
  startedAt: number,
  failureClass: EvidenceCandidateScoringFailureClass | null = null,
  activationsByCandidateKey: ReadonlyMap<
    string,
    Readonly<EvidenceCandidateScoringReceipt>
  > = new Map()
): EvidenceCandidateScoringResult {
  return Object.freeze({
    activationsByCandidateKey,
    status,
    expectedCount,
    scoredCount,
    inferenceCalls,
    latencyMs: Math.max(0, performance.now() - startedAt),
    failureClass
  });
}

async function settlePreparedQuery(
  prepared: PreparedEmbeddingQueryHandle,
  timeoutMs: number
) {
  const initial = prepared.getSnapshot();
  return initial.status === "pending" && prepared.waitForSnapshot !== undefined
    ? await prepared.waitForSnapshot(timeoutMs)
    : initial;
}
