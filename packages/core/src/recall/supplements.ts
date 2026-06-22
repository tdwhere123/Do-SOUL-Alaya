import type { RecallPolicy } from "@do-soul/alaya-protocol";
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
  errorNameOf,
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
export { collectEmbeddingCoarseInjection } from "./embedding-coarse-injection.js";

type SynthesisSearchPort = NonNullable<RecallServiceDependencies["synthesisSearchPort"]>;
type SynthesisSearchRow = Awaited<ReturnType<SynthesisSearchPort["findByIds"]>>[number];

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
    const rankById = await collectSynthesisRankById(params, synthesisSearchPort, limit);
    if (rankById.size === 0) {
      return emptySynthesisCoarseFilter();
    }
    const synthesisRows = await synthesisSearchPort.findByIds([...rankById.keys()]);
    const candidates = buildSynthesisCandidates(params.workspaceId, synthesisRows, rankById);
    return Object.freeze({
      candidates: Object.freeze(candidates),
      synthesisFtsRanks: buildSynthesisFtsRanks(candidates, rankById)
    });
  } catch (error) {
    params.warn("synthesis FTS lookup failed", {
      workspace_id: params.workspaceId,
      operation: "synthesis_fts_lookup",
      errorName: errorNameOf(error),
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
  if (!canPrepareEmbeddingSupplementQuery(params, embeddingRecallService)) {
    return Object.freeze({ handle: null, storedVectors: null, degradedReason: null });
  }
  if (embeddingRecallService === undefined || params.queryText === null) {
    return Object.freeze({ handle: null, storedVectors: null, degradedReason: null });
  }
  const queryText = params.queryText;
  if (typeof embeddingRecallService.prepareQuerySupplement === "function") {
    const prepared = await embeddingRecallService.prepareQuerySupplement({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryText,
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
  return prepareLegacyEmbeddingSupplementQuery(params, embeddingRecallService);
}

async function collectSynthesisRankById(
  params: Pick<Parameters<typeof collectSynthesisCoarseCandidates>[0], "queryText" | "queryProbes" | "workspaceId">,
  synthesisSearchPort: NonNullable<RecallServiceDependencies["synthesisSearchPort"]>,
  limit: number
): Promise<ReadonlyMap<string, number>> {
  const rankById = new Map<string, number>();
  if (params.queryText === null) {
    return rankById;
  }
  for (const synthesisQuery of buildEvidenceSearchQueries(params.queryText, params.queryProbes)) {
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
  return rankById;
}

function buildSynthesisCandidates(
  workspaceId: string,
  synthesisRows: readonly Readonly<SynthesisSearchRow>[],
  rankById: ReadonlyMap<string, number>
): readonly Readonly<CoarseRecallCandidate>[] {
  return synthesisRows
    .filter((synthesis) => synthesis.workspace_id === workspaceId)
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
}

function buildSynthesisFtsRanks(
  candidates: readonly Readonly<CoarseRecallCandidate>[],
  rankById: ReadonlyMap<string, number>
): Readonly<Record<string, number>> {
  return Object.freeze(
    Object.fromEntries(
      candidates.map((candidate) => [
        candidate.entry.object_id,
        rankById.get(candidate.entry.object_id) ?? 0
      ] as const)
    )
  );
}

function canPrepareEmbeddingSupplementQuery(
  params: Parameters<typeof prepareEmbeddingSupplementQuery>[0],
  embeddingRecallService: RecallServiceDependencies["embeddingRecallService"]
): boolean {
  const hasSupplementPreparation =
    typeof embeddingRecallService?.prepareQuerySupplement === "function" ||
    typeof embeddingRecallService?.prepareQueryEmbedding === "function";
  return !(
    embeddingRecallService === undefined ||
    !hasSupplementPreparation ||
    params.queryText === null ||
    params.config.coarse_filter.semantic_supplement.embedding_enabled !== true ||
    params.config.coarse_filter.semantic_supplement.max_supplement <= 0 ||
    params.localEligibleCandidates.length === 0
  );
}

async function prepareLegacyEmbeddingSupplementQuery(
  params: Parameters<typeof prepareEmbeddingSupplementQuery>[0],
  embeddingRecallService: NonNullable<RecallServiceDependencies["embeddingRecallService"]>
): Promise<Readonly<{
  readonly handle: PreparedEmbeddingQueryHandle | null;
  readonly storedVectors: PreparedEmbeddingSupplement["storedVectors"] | null;
  readonly degradedReason: string | null;
}>> {
  const prepareQueryEmbedding = embeddingRecallService.prepareQueryEmbedding;
  if (typeof prepareQueryEmbedding !== "function") {
    return Object.freeze({ handle: null, storedVectors: null, degradedReason: null });
  }
  const precheck = await precheckStoredVectorsForEmbeddingSupplement(params, embeddingRecallService);
  if (precheck !== null) {
    return precheck;
  }
  return Object.freeze({
    handle: prepareQueryEmbedding({
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryText: params.queryText!
    }),
    storedVectors: null,
    degradedReason: null
  });
}

async function precheckStoredVectorsForEmbeddingSupplement(
  params: Parameters<typeof prepareEmbeddingSupplementQuery>[0],
  embeddingRecallService: NonNullable<RecallServiceDependencies["embeddingRecallService"]>
): Promise<Readonly<{
  readonly handle: PreparedEmbeddingQueryHandle | null;
  readonly storedVectors: PreparedEmbeddingSupplement["storedVectors"] | null;
  readonly degradedReason: string | null;
}> | null> {
  if (typeof embeddingRecallService.hasStoredVectors !== "function") {
    return null;
  }
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
  return hasStoredVectors
    ? null
    : Object.freeze({ handle: null, storedVectors: null, degradedReason: null });
}
