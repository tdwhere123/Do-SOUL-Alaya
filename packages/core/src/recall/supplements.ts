import type { MemoryEntry, RecallPolicy } from "@do-soul/alaya-protocol";
import type {
  EmbeddingRecallSupplementResult,
  PreparedEmbeddingQueryHandle,
  PreparedEmbeddingSupplement
} from "../embedding-recall/embedding-recall-service.js";
import { buildSynthesisCoarseRecallCandidate } from "./recall-candidate-builder.js";
import type { RecallQueryProbes } from "./recall-query-probes.js";
import {
  clamp01,
  compareMemoryEntries,
  parseEmbeddingPrecheckReason,
  toErrorMessage
} from "./recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "./recall-service-types.js";
import { buildEvidenceSearchQueries } from "./coarse-candidates.js";
import { normalizeEmbeddingProviderDegradationReason } from "./diagnostics.js";
import { recallFusionRetuneEnabled } from "./recall-retune-flags.js";

const EMBEDDING_INJECTION_SIMILARITY_FLOOR = 0.5;
const EMBEDDING_MAX_INJECTED_DELIVERY = 2;
// C2: under the retune flag, relax the semantic-injection gate (pairs with the
// embedding weight bump and a retrieval-tuned model).
const EMBEDDING_INJECTION_SIMILARITY_FLOOR_RETUNED = 0.35;
const EMBEDDING_MAX_INJECTED_DELIVERY_RETUNED = 10;

export function emptyEmbeddingSupplementResult(): EmbeddingRecallSupplementResult {
  return Object.freeze({
    supplementaryEntries: Object.freeze([]),
    similarityHintsByObjectId: Object.freeze({})
  });
}

export function emptySynthesisCoarseFilter(): Readonly<{
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly synthesisFtsRanks: Readonly<Record<string, number>>;
}> {
  return Object.freeze({
    candidates: Object.freeze([]),
    synthesisFtsRanks: Object.freeze({})
  });
}

/**
 * Embedding-on coarse-injection path. Lexical coarse filtering admits only
 * memories that match deterministic / FTS / precomputed-rank predicates, so
 * a semantically relevant memory with zero lexical overlap never enters the
 * candidate pool. When the embedding_enabled gate is true this fetches the
 * top-K workspace cosine neighbors, resolves them into MemoryEntry coarse
 * candidates tagged with the semantic_supplement source channel, and returns
 * their similarity scores for the embedding_similarity fusion stream.
 *
 * invariant: returns an empty injection whenever the gate is false, so the
 * embedding-off recall path is unchanged at the bit level.
 */
export async function collectEmbeddingCoarseInjection(params: {
  readonly dependencies: Pick<RecallServiceDependencies, "embeddingRecallService" | "memoryRepo">;
  readonly warn: RecallServiceWarnPort;
  readonly policy: Readonly<RecallPolicy>;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryText: string | null;
  readonly poolCandidates: readonly Readonly<CoarseRecallCandidate>[];
}): Promise<Readonly<{
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly similarityScores: Readonly<Record<string, number>>;
  readonly embeddingInferenceCalls: number;
}>> {
  const empty = Object.freeze({
    candidates: Object.freeze([]) as readonly Readonly<CoarseRecallCandidate>[],
    similarityScores: Object.freeze({}),
    embeddingInferenceCalls: 0
  });
  const embeddingRecallService = params.dependencies.embeddingRecallService;
  const maxSupplement = params.policy.coarse_filter.semantic_supplement.max_supplement;
  if (
    params.policy.coarse_filter.semantic_supplement.embedding_enabled !== true ||
    maxSupplement <= 0 ||
    params.queryText === null ||
    embeddingRecallService === undefined ||
    (typeof embeddingRecallService.collectWorkspaceNeighbors !== "function" &&
      typeof embeddingRecallService.collectWorkspaceNeighborsWithMetadata !== "function") ||
    typeof params.dependencies.memoryRepo.findByIds !== "function"
  ) {
    return empty;
  }

  const poolObjectIds = params.poolCandidates.map((candidate) => candidate.entry.object_id);
  const neighborResult =
    typeof embeddingRecallService.collectWorkspaceNeighborsWithMetadata === "function"
      ? await embeddingRecallService.collectWorkspaceNeighborsWithMetadata({
          workspaceId: params.workspaceId,
          runId: params.runId,
          queryText: params.queryText,
          excludeObjectIds: poolObjectIds,
          maxNeighbors: maxSupplement
        })
      : {
          hits: await embeddingRecallService.collectWorkspaceNeighbors!({
            workspaceId: params.workspaceId,
            runId: params.runId,
            queryText: params.queryText,
            excludeObjectIds: poolObjectIds,
            maxNeighbors: maxSupplement
          }),
          embedding_inference_calls: 0,
          query_embedding_cache_hit: true
        };
  const neighbors = neighborResult.hits;
  if (neighbors.length === 0) {
    return Object.freeze({
      ...empty,
      embeddingInferenceCalls: neighborResult.embedding_inference_calls
    });
  }

  const similarityByObjectId = new Map(
    neighbors.map((neighbor) => [neighbor.object_id, neighbor.normalized_similarity] as const)
  );
  let neighborEntries: readonly Readonly<MemoryEntry>[];
  try {
    neighborEntries = await params.dependencies.memoryRepo.findByIds([...similarityByObjectId.keys()]);
  } catch (error) {
    params.warn("embedding coarse injection lookup failed", {
      workspace_id: params.workspaceId,
      run_id: params.runId,
      error: toErrorMessage(error)
    });
    return Object.freeze({
      ...empty,
      embeddingInferenceCalls: neighborResult.embedding_inference_calls
    });
  }

  const poolObjectIdSet = new Set(poolObjectIds);
  const retune = recallFusionRetuneEnabled();
  const injectionFloor = retune
    ? EMBEDDING_INJECTION_SIMILARITY_FLOOR_RETUNED
    : EMBEDDING_INJECTION_SIMILARITY_FLOOR;
  const maxInjected = retune
    ? EMBEDDING_MAX_INJECTED_DELIVERY_RETUNED
    : EMBEDDING_MAX_INJECTED_DELIVERY;
  // Gate the injected neighbors on the query cosine floor and hard-cap the
  // count: the semantic facet contributes at most maxInjected pool-external
  // objects, each clearing the cosine floor. The cosine floor IS the relevance
  // gate — these are pure-semantic objects with zero lexical overlap, so no
  // lexical/deterministic filter applies.
  const candidates = neighborEntries
    .filter(
      (entry) =>
        entry.workspace_id === params.workspaceId &&
        !poolObjectIdSet.has(entry.object_id) &&
        (similarityByObjectId.get(entry.object_id) ?? 0) >= injectionFloor
    )
    .sort(
      (left, right) =>
        (similarityByObjectId.get(right.object_id) ?? 0) -
        (similarityByObjectId.get(left.object_id) ?? 0)
    )
    .slice(0, maxInjected)
    .map((entry) =>
      Object.freeze({
        entry,
        originPlane: "workspace_local" as const,
        sourceChannel: "semantic_supplement",
        sourceChannels: Object.freeze(["semantic_supplement"]),
        admissionPlanes: Object.freeze(["semantic_supplement" as const]),
        firstAdmissionPlane: "semantic_supplement" as const,
        structuralScore: 0
      })
  ) as readonly Readonly<CoarseRecallCandidate>[];
  if (candidates.length === 0) {
    return Object.freeze({
      ...empty,
      embeddingInferenceCalls: neighborResult.embedding_inference_calls
    });
  }

  const similarityScores = Object.fromEntries(
    candidates.map((candidate) => [
      candidate.entry.object_id,
      similarityByObjectId.get(candidate.entry.object_id) ?? 0
    ] as const)
  );
  return Object.freeze({
    candidates: Object.freeze([...candidates]),
    similarityScores: Object.freeze(similarityScores),
    embeddingInferenceCalls: neighborResult.embedding_inference_calls
  });
}

export async function collectEmbeddingSupplement(params: {
  readonly dependencies: Pick<RecallServiceDependencies, "embeddingRecallService">;
  readonly baseCandidateIds: readonly string[];
  readonly localEligibleCandidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly config: Readonly<RecallPolicy>;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryText: string | null;
  readonly preparedEmbeddingQuery: PreparedEmbeddingQueryHandle | null;
  readonly preparedStoredVectors: PreparedEmbeddingSupplement["storedVectors"] | null;
}): Promise<EmbeddingRecallSupplementResult> {
  const embeddingRecallService = params.dependencies.embeddingRecallService;
  if (
    embeddingRecallService === undefined ||
    params.queryText === null ||
    params.config.coarse_filter.semantic_supplement.embedding_enabled !== true ||
    params.config.coarse_filter.semantic_supplement.max_supplement <= 0 ||
    params.localEligibleCandidates.length === 0
  ) {
    return emptyEmbeddingSupplementResult();
  }

  if (
    params.preparedEmbeddingQuery === null ||
    typeof embeddingRecallService.querySupplementIfReady !== "function"
  ) {
    return emptyEmbeddingSupplementResult();
  }

  const supplement = await embeddingRecallService.querySupplementIfReady({
    workspaceId: params.workspaceId,
    runId: params.runId,
    eligibleMemories: params.localEligibleCandidates.map((candidate) => candidate.entry),
    baseCandidateIds: params.baseCandidateIds,
    maxSupplement: params.config.coarse_filter.semantic_supplement.max_supplement,
    preparedQuery: params.preparedEmbeddingQuery,
    ...(params.preparedStoredVectors === null
      ? {}
      : { storedVectors: params.preparedStoredVectors })
  });

  return supplement;
}

export async function collectSynthesisCoarseCandidates(params: {
  readonly dependencies: Pick<RecallServiceDependencies, "synthesisSearchPort">;
  readonly warn: RecallServiceWarnPort;
  readonly workspaceId: string;
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly policy: Readonly<RecallPolicy>;
}): Promise<Readonly<{
  readonly candidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly synthesisFtsRanks: Readonly<Record<string, number>>;
}>> {
  const synthesisSearchPort = params.dependencies.synthesisSearchPort;
  if (synthesisSearchPort === undefined || params.queryText === null) {
    return emptySynthesisCoarseFilter();
  }
  const limit = params.policy.coarse_filter.semantic_supplement.max_supplement;
  if (limit <= 0) {
    return emptySynthesisCoarseFilter();
  }
  try {
    const rankById = new Map<string, number>();
    for (const synthesisQuery of buildEvidenceSearchQueries(
      params.queryText,
      params.queryProbes
    )) {
      const matches = await synthesisSearchPort.searchByKeyword(
        params.workspaceId,
        synthesisQuery,
        limit
      );
      for (const match of matches) {
        rankById.set(
          match.object_id,
          Math.max(rankById.get(match.object_id) ?? 0, clamp01(match.normalized_rank))
        );
      }
    }
    if (rankById.size === 0) {
      return emptySynthesisCoarseFilter();
    }
    const synthesisRows = await synthesisSearchPort.findByIds([...rankById.keys()]);
    const candidates = synthesisRows
      .filter((synthesis) => synthesis.workspace_id === params.workspaceId)
      .map((synthesis) =>
        buildSynthesisCoarseRecallCandidate({
          synthesis,
          normalizedRank: rankById.get(synthesis.object_id) ?? 0
        })
      )
      .sort((left, right) => {
        const leftRank = rankById.get(left.entry.object_id) ?? 0;
        const rightRank = rankById.get(right.entry.object_id) ?? 0;
        const delta = rightRank - leftRank;
        return delta !== 0 ? delta : compareMemoryEntries(left.entry, right.entry);
      });
    return Object.freeze({
      candidates: Object.freeze(candidates),
      synthesisFtsRanks: Object.freeze(
        Object.fromEntries(
          candidates.map((candidate) => [
            candidate.entry.object_id,
            rankById.get(candidate.entry.object_id) ?? 0
          ] as const)
        )
      )
    });
  } catch (error) {
    params.warn("synthesis FTS lookup failed", {
      workspace_id: params.workspaceId,
      error: toErrorMessage(error)
    });
    return emptySynthesisCoarseFilter();
  }
}

export async function prepareEmbeddingSupplementQuery(params: {
  readonly dependencies: Pick<RecallServiceDependencies, "embeddingRecallService">;
  readonly config: Readonly<RecallPolicy>;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryText: string | null;
  readonly localEligibleCandidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly lexicalFallbackCount: number;
}): Promise<Readonly<{
  readonly handle: PreparedEmbeddingQueryHandle | null;
  readonly storedVectors: PreparedEmbeddingSupplement["storedVectors"] | null;
  readonly degradedReason: string | null;
}>> {
  const embeddingRecallService = params.dependencies.embeddingRecallService;
  const hasSupplementPreparation =
    typeof embeddingRecallService?.prepareQuerySupplement === "function" ||
    typeof embeddingRecallService?.prepareQueryEmbedding === "function";
  if (
    embeddingRecallService === undefined ||
    !hasSupplementPreparation ||
    params.queryText === null ||
    params.config.coarse_filter.semantic_supplement.embedding_enabled !== true ||
    params.config.coarse_filter.semantic_supplement.max_supplement <= 0 ||
    params.localEligibleCandidates.length === 0
  ) {
    return Object.freeze({ handle: null, storedVectors: null, degradedReason: null });
  }

  if (typeof embeddingRecallService.prepareQuerySupplement === "function") {
    const prepared = await embeddingRecallService.prepareQuerySupplement({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryText: params.queryText,
      eligibleMemories: params.localEligibleCandidates.map((candidate) => candidate.entry),
      baseCandidateCount: params.lexicalFallbackCount
    });
    return Object.freeze({
      handle: prepared.preparedQuery,
      storedVectors: prepared.storedVectors,
      degradedReason:
        prepared.degradedReason === null
          ? null
          : normalizeEmbeddingProviderDegradationReason(prepared.degradedReason)
    });
  }

  const prepareQueryEmbedding = embeddingRecallService.prepareQueryEmbedding;
  if (typeof prepareQueryEmbedding !== "function") {
    return Object.freeze({ handle: null, storedVectors: null, degradedReason: null });
  }

  if (typeof embeddingRecallService.hasStoredVectors === "function") {
    let hasStoredVectors: boolean;
    try {
      hasStoredVectors = await embeddingRecallService.hasStoredVectors({
        workspaceId: params.workspaceId,
        eligibleMemories: params.localEligibleCandidates.map((candidate) => candidate.entry)
      });
    } catch (error) {
      const reason = parseEmbeddingPrecheckReason(error);

      if (reason === null) {
        throw error;
      }

      await embeddingRecallService.recordPrecheckDegraded?.({
        workspaceId: params.workspaceId,
        runId: params.runId,
        reason,
        baseCandidateCount: params.lexicalFallbackCount,
        fallbackCandidateCount: params.lexicalFallbackCount
      });
      return Object.freeze({
        handle: null,
        storedVectors: null,
        degradedReason: normalizeEmbeddingProviderDegradationReason(reason)
      });
    }

    if (!hasStoredVectors) {
      return Object.freeze({ handle: null, storedVectors: null, degradedReason: null });
    }
  }

  return Object.freeze({
    handle: prepareQueryEmbedding({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryText: params.queryText
    }),
    storedVectors: null,
    degradedReason: null
  });
}
