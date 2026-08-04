import {
  assertValidEmbeddingBatch,
  clamp01,
  createCosineBatchScorer,
  toErrorMessage
} from "../helpers.js";
import {
  EvidenceDocumentEmbeddingError,
  type EvidenceDocumentEmbeddingEngine
} from "./evidence-document-embedding-engine.js";
import type { QueryEmbeddingEngine } from "../query-embedding-engine.js";
import type {
  EmbeddingProviderPort,
  EvidenceCandidateScoringFailureClass,
  EvidenceCandidateScoringResult,
  EvidenceCandidateScoringWinner,
  PreparedEmbeddingQueryHandle,
  ScoreEvidenceCandidatesParams
} from "../types.js";

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
    const winners = aggregateCandidateScores(candidates, embeddings, scoreCosine);
    const scores = new Map(
      [...winners].map(([candidateKey, winner]) => [candidateKey, winner.score])
    );
    return scoringResult(
      "returned",
      candidates.length,
      candidates.length,
      inferenceCalls,
      startedAt,
      null,
      scores,
      winners
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

function aggregateCandidateScores(
  candidates: ScoreEvidenceCandidatesParams["candidates"],
  embeddings: readonly Float32Array[],
  scoreCosine: (embedding: Float32Array) => number
): ReadonlyMap<string, Readonly<EvidenceCandidateScoringWinner>> {
  const winners = new Map<string, Readonly<EvidenceCandidateScoringWinner>>();
  candidates.forEach((candidate, index) => {
    const score = clamp01(scoreCosine(embeddings[index]!));
    const winner = Object.freeze({
      score,
      evidenceObjectId: candidate.evidenceObjectId,
      documentIdentity: candidate.documentIdentity
    });
    const current = winners.get(candidate.candidateKey);
    if (current === undefined || compareWinners(winner, current) < 0) {
      winners.set(candidate.candidateKey, winner);
    }
  });
  return winners;
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
  scores: ReadonlyMap<string, number> = new Map(),
  winnersByCandidateKey: ReadonlyMap<
    string,
    Readonly<EvidenceCandidateScoringWinner>
  > = new Map()
): EvidenceCandidateScoringResult {
  return Object.freeze({
    scores,
    winnersByCandidateKey,
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
