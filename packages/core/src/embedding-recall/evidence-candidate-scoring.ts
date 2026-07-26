import {
  assertValidEmbeddingBatch,
  clamp01,
  createCosineBatchScorer,
  toErrorMessage
} from "./helpers.js";
import type { QueryEmbeddingEngine } from "./query-embedding-engine.js";
import type {
  EmbeddingProviderPort,
  PreparedEmbeddingQueryHandle,
  ScoreEvidenceCandidatesParams
} from "./types.js";

const MAX_TRANSIENT_EVIDENCE_CANDIDATES = 25;

export interface EvidenceCandidateScoringDependencies {
  readonly provider: EmbeddingProviderPort;
  readonly queryEngine: Pick<QueryEmbeddingEngine, "prepareQueryEmbedding">;
  readonly queryTimeoutMs: number;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}

export async function scoreTransientEvidenceCandidates(
  params: ScoreEvidenceCandidatesParams,
  dependencies: EvidenceCandidateScoringDependencies
): Promise<ReadonlyMap<string, number>> {
  const candidates = params.candidates.slice(0, MAX_TRANSIENT_EVIDENCE_CANDIDATES);
  if (candidates.length === 0 || !dependencies.provider.isAvailable) {
    return new Map();
  }
  try {
    const queryEmbedding = await resolveQueryEmbedding(params, dependencies);
    const embeddings = await dependencies.provider.embedTexts(
      candidates.map((candidate) => candidate.content),
      { timeoutMs: dependencies.queryTimeoutMs }
    );
    assertValidEmbeddingBatch(embeddings, candidates.length);
    const scoreCosine = createCosineBatchScorer(queryEmbedding);
    return new Map(candidates.map((candidate, index) => [
      candidate.candidateKey,
      clamp01(scoreCosine(embeddings[index]!))
    ]));
  } catch (error) {
    dependencies.warn("transient evidence embedding degraded", {
      workspace_id: params.workspaceId,
      run_id: params.runId,
      reason: "evidence_candidate_embedding_failed",
      error: toErrorMessage(error)
    });
    return new Map();
  }
}

async function resolveQueryEmbedding(
  params: ScoreEvidenceCandidatesParams,
  dependencies: EvidenceCandidateScoringDependencies
): Promise<Float32Array> {
  const prepared = params.preparedQuery ?? dependencies.queryEngine.prepareQueryEmbedding({
    workspaceId: params.workspaceId,
    runId: params.runId,
    queryText: params.queryText
  });
  const snapshot = await settlePreparedQuery(prepared, dependencies.queryTimeoutMs);
  if (snapshot.status === "ready") {
    return snapshot.embedding;
  }
  if (snapshot.status === "failed") {
    throw new Error(snapshot.error_message ?? snapshot.reason);
  }
  throw new Error("query_embedding_pending");
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
