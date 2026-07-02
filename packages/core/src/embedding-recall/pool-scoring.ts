import {
  cosineSimilarity,
  isProviderMatchedEmbedding,
  toErrorMessage
} from "./helpers.js";
import type { QueryEmbeddingEngine } from "./query-embedding-engine.js";
import type {
  EmbeddingRecallServiceDependencies,
  EmbeddingVectorRecord
} from "./types.js";

export async function scoreEmbeddingPoolCandidates(params: {
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryText: string;
  readonly objectIds: readonly string[];
  readonly embeddingRepo: EmbeddingRecallServiceDependencies["embeddingRepo"];
  readonly provider: EmbeddingRecallServiceDependencies["provider"];
  readonly queryEngine: Pick<QueryEmbeddingEngine, "resolveQueryEmbeddingNow">;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}): Promise<ReadonlyMap<string, number>> {
  const empty: ReadonlyMap<string, number> = new Map<string, number>();
  if (params.objectIds.length === 0 || !params.provider.isAvailable) {
    return empty;
  }
  let storedVectors: readonly Readonly<EmbeddingVectorRecord>[];
  try {
    storedVectors = await params.embeddingRepo.listByObjectIds(params.workspaceId, params.objectIds);
  } catch (error) {
    params.warn("pool embedding rescoring degraded", {
      workspace_id: params.workspaceId,
      run_id: params.runId,
      reason: "local_vector_lookup_failed",
      error: toErrorMessage(error)
    });
    return empty;
  }
  if (storedVectors.length === 0) {
    return empty;
  }
  let queryEmbedding: Float32Array | null;
  try {
    queryEmbedding = await params.queryEngine.resolveQueryEmbeddingNow(params.queryText);
  } catch {
    return empty;
  }
  if (queryEmbedding === null) {
    return empty;
  }
  return scoreMatchedVectors(queryEmbedding, storedVectors, params.provider);
}

function scoreMatchedVectors(
  queryEmbedding: Float32Array,
  storedVectors: readonly Readonly<EmbeddingVectorRecord>[],
  provider: EmbeddingRecallServiceDependencies["provider"]
): ReadonlyMap<string, number> {
  const scores = new Map<string, number>();
  for (const record of storedVectors) {
    if (!isProviderMatchedEmbedding(record, provider) || record.dimensions !== record.embedding.length) {
      continue;
    }
    const sim = cosineSimilarity(queryEmbedding, record.embedding);
    if (sim > 0) {
      scores.set(record.object_id, sim);
    }
  }
  return scores;
}

// invariant: cosine space is valid only within one (provider_kind, model_id,
// schema_version); self-inconsistent records (dimensions !== embedding length)
// are dropped before pair keys are emitted.
export function computeCoherentPairKeys(
  storedVectors: readonly Readonly<EmbeddingVectorRecord>[],
  objectIds: readonly string[],
  floor: number,
  provider: EmbeddingRecallServiceDependencies["provider"]
): ReadonlySet<string> {
  const vectorsByObjectId = new Map<string, Float32Array>();
  for (const record of storedVectors) {
    if (
      record.provider_kind === provider.providerKind &&
      record.model_id === provider.modelId &&
      record.schema_version === provider.schemaVersion &&
      record.dimensions === record.embedding.length
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
    if (vecB === undefined) {
      continue;
    }
    if (cosineSimilarity(vecA, vecB) >= floor) {
      const [low, high] =
        objectIds[index]! < objectIds[j]! ? [objectIds[index]!, objectIds[j]!] : [objectIds[j]!, objectIds[index]!];
      coherent.add(`${low}|${high}`);
    }
  }
}
