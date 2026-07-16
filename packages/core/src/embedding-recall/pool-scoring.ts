import {
  clamp01,
  cosineSimilarity,
  isFiniteNonzeroVector,
  isProviderMatchedEmbedding,
  isUsableEmbeddingRecordVector,
  toErrorMessage
} from "./helpers.js";
import type { QueryEmbeddingEngine } from "./query-embedding-engine.js";
import type {
  EmbeddingRecallServiceDependencies,
  EmbeddingVectorRecord,
  PreparedEmbeddingQuerySnapshot
} from "./types.js";

interface PoolScoringParams {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryText: string;
  readonly objectIds: readonly string[];
  readonly embeddingRepo: EmbeddingRecallServiceDependencies["embeddingRepo"];
  readonly provider: EmbeddingRecallServiceDependencies["provider"];
  readonly queryEngine: Pick<QueryEmbeddingEngine, "prepareQueryEmbedding">;
  readonly queryTimeoutMs: number;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}

export async function scoreEmbeddingPoolCandidates(
  params: PoolScoringParams
): Promise<ReadonlyMap<string, number>> {
  const empty: ReadonlyMap<string, number> = new Map<string, number>();
  if (params.objectIds.length === 0 || !params.provider.isAvailable) {
    return empty;
  }
  const storedVectors = await loadPoolVectors(params);
  if (storedVectors === null || storedVectors.length === 0) {
    return empty;
  }
  const queryEmbedding = await resolvePoolQueryEmbeddingSafely(params);
  if (queryEmbedding === null) {
    return empty;
  }
  return scoreMatchedVectors(
    queryEmbedding,
    storedVectors,
    params.provider,
    new Set(params.objectIds)
  );
}

async function loadPoolVectors(
  params: PoolScoringParams
): Promise<readonly Readonly<EmbeddingVectorRecord>[] | null> {
  try {
    return await params.embeddingRepo.listByObjectIds(params.workspaceId, params.objectIds);
  } catch (error) {
    params.warn("pool embedding rescoring degraded", {
      workspace_id: params.workspaceId,
      run_id: params.runId,
      reason: "local_vector_lookup_failed",
      error: toErrorMessage(error)
    });
    return null;
  }
}

async function resolvePoolQueryEmbeddingSafely(
  params: PoolScoringParams
): Promise<Float32Array | null> {
  try {
    return await resolvePoolQueryEmbedding(params);
  } catch (error) {
    params.warn("pool embedding rescoring degraded", {
      workspace_id: params.workspaceId,
      run_id: params.runId,
      reason: "query_embedding_failed",
      error: toErrorMessage(error)
    });
    return null;
  }
}

async function resolvePoolQueryEmbedding(params: {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryText: string;
  readonly queryEngine: Pick<QueryEmbeddingEngine, "prepareQueryEmbedding">;
  readonly queryTimeoutMs: number;
}): Promise<Float32Array> {
  const preparedQuery = params.queryEngine.prepareQueryEmbedding({
    workspaceId: params.workspaceId,
    runId: params.runId,
    queryText: params.queryText
  });
  const initialSnapshot = preparedQuery.getSnapshot();
  const snapshot =
    initialSnapshot.status === "pending" && typeof preparedQuery.waitForSnapshot === "function"
      ? await preparedQuery.waitForSnapshot(params.queryTimeoutMs)
      : initialSnapshot;
  return embeddingFromSnapshot(snapshot);
}

function embeddingFromSnapshot(snapshot: PreparedEmbeddingQuerySnapshot): Float32Array {
  if (snapshot.status === "ready") {
    return snapshot.embedding;
  }
  if (snapshot.status === "failed") {
    throw new Error(snapshot.error_message ?? snapshot.reason);
  }
  throw new Error("query_embedding_pending");
}

function scoreMatchedVectors(
  queryEmbedding: Float32Array,
  storedVectors: readonly Readonly<EmbeddingVectorRecord>[],
  provider: EmbeddingRecallServiceDependencies["provider"],
  requestedObjectIds: ReadonlySet<string>
): ReadonlyMap<string, number> {
  const scores = new Map<string, number>();
  if (!isFiniteNonzeroVector(queryEmbedding)) {
    return scores;
  }
  for (const record of storedVectors) {
    if (
      !requestedObjectIds.has(record.object_id) ||
      !isProviderMatchedEmbedding(record, provider) ||
      !isUsableEmbeddingRecordVector(record, queryEmbedding.length)
    ) {
      continue;
    }
    const sim = cosineSimilarity(queryEmbedding, record.embedding);
    scores.set(record.object_id, clamp01(sim));
  }
  return scores;
}

// invariant: pairwise cosine consumes the same valid vector domain as query
// scoring and only compares vectors from one embedding space.
export function computeCoherentPairKeys(
  storedVectors: readonly Readonly<EmbeddingVectorRecord>[],
  objectIds: readonly string[],
  floor: number,
  provider: EmbeddingRecallServiceDependencies["provider"]
): ReadonlySet<string> {
  const vectorsByObjectId = new Map<string, Float32Array>();
  for (const record of storedVectors) {
    if (
      isProviderMatchedEmbedding(record, provider) &&
      isUsableEmbeddingRecordVector(record, record.dimensions)
    ) {
      vectorsByObjectId.set(record.object_id, record.embedding);
    }
  }

  const coherent = new Set<string>();
  for (let i = 0; i < objectIds.length; i += 1) {
    const vecA = vectorsByObjectId.get(objectIds[i]!);
    if (vecA === undefined) {
      continue;
    }
    collectCoherentPairsForVector(coherent, vectorsByObjectId, objectIds, i, vecA, floor);
  }
  return coherent;
}

function collectCoherentPairsForVector(
  coherent: Set<string>,
  vectorsByObjectId: ReadonlyMap<string, Float32Array>,
  objectIds: readonly string[],
  index: number,
  vecA: Float32Array,
  floor: number
): void {
  for (let j = index + 1; j < objectIds.length; j += 1) {
    const vecB = vectorsByObjectId.get(objectIds[j]!);
    if (vecB === undefined || vecA.length !== vecB.length) {
      continue;
    }
    if (cosineSimilarity(vecA, vecB) >= floor) {
      const [low, high] =
        objectIds[index]! < objectIds[j]! ? [objectIds[index]!, objectIds[j]!] : [objectIds[j]!, objectIds[index]!];
      coherent.add(`${low}|${high}`);
    }
  }
}
