import type { RecallPolicy } from "@do-soul/alaya-protocol";
import type {
  EmbeddingRecallSupplementResult,
  PreparedEmbeddingQueryHandle,
  PreparedEmbeddingSupplement
} from "../../embedding-recall/embedding-recall-service.js";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import {
  errorNameOf,
  parseEmbeddingPrecheckReason,
  toErrorMessage
} from "../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "../runtime/recall-service-types.js";
import { normalizeEmbeddingProviderDegradationReason } from "../runtime/diagnostics.js";
import { recordRecallDegradation } from "../runtime/diagnostics.js";
import { collectSynthesisChildCandidates } from "./synthesis/child-candidates.js";
export { collectEmbeddingCoarseInjection } from "../coarse-filter/embedding-coarse-injection.js";

export type EmbeddingSupplementCollectionStatus =
  | "disabled"
  | "provider_missing"
  | "query_missing"
  | "empty_candidate_pool"
  | "not_attempted"
  | "requested";

export type CollectedEmbeddingSupplementResult = EmbeddingRecallSupplementResult & Readonly<{
  readonly collectionStatus: EmbeddingSupplementCollectionStatus;
}>;

export function emptyEmbeddingSupplementResult(
  collectionStatus: Exclude<EmbeddingSupplementCollectionStatus, "requested">
): CollectedEmbeddingSupplementResult {
  return Object.freeze({
    supplementaryEntries: Object.freeze([]),
    similarityHintsByObjectId: Object.freeze({}),
    collectionStatus
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

type CollectEmbeddingSupplementParams = Readonly<{
  readonly dependencies: Pick<RecallServiceDependencies, "embeddingRecallService">;
  readonly baseCandidateIds: readonly string[];
  readonly localEligibleCandidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly config: Readonly<RecallPolicy>;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryText: string | null;
  readonly preparedEmbeddingQuery: PreparedEmbeddingQueryHandle | null;
  readonly preparedStoredVectors: PreparedEmbeddingSupplement["storedVectors"] | null;
  readonly preparedSupplementSupported: boolean;
}>;

export async function collectEmbeddingSupplement(
  params: CollectEmbeddingSupplementParams
): Promise<CollectedEmbeddingSupplementResult> {
  const embeddingRecallService = params.dependencies.embeddingRecallService;
  if (params.config.coarse_filter.semantic_supplement.embedding_enabled !== true ||
      params.config.coarse_filter.semantic_supplement.max_supplement <= 0) {
    return emptyEmbeddingSupplementResult("disabled");
  }
  if (embeddingRecallService === undefined) {
    return emptyEmbeddingSupplementResult("provider_missing");
  }
  if (params.queryText === null) {
    return emptyEmbeddingSupplementResult("query_missing");
  }
  const queryText = params.queryText;
  if (params.localEligibleCandidates.length === 0) {
    return emptyEmbeddingSupplementResult("empty_candidate_pool");
  }

  const preparedEmbeddingQuery = params.preparedEmbeddingQuery;
  if (preparedEmbeddingQuery === null) {
    // Prepared path is supported but no handle was produced — do not label as requested.
    return params.preparedSupplementSupported
      ? emptyEmbeddingSupplementResult("not_attempted")
      : collectLegacyEmbeddingSupplement(params, embeddingRecallService, queryText);
  }

  if (typeof embeddingRecallService.querySupplementIfReady !== "function") {
    return collectLegacyEmbeddingSupplement(params, embeddingRecallService, queryText);
  }

  return collectPreparedEmbeddingSupplement(
    params,
    embeddingRecallService,
    preparedEmbeddingQuery
  );
}

async function collectLegacyEmbeddingSupplement(
  params: CollectEmbeddingSupplementParams,
  service: NonNullable<RecallServiceDependencies["embeddingRecallService"]>,
  queryText: string
): Promise<CollectedEmbeddingSupplementResult> {
  const supplement = await service.querySupplement({
    workspaceId: params.workspaceId,
    runId: params.runId,
    queryText,
    eligibleMemories: params.localEligibleCandidates.map((candidate) => candidate.entry),
    baseCandidateIds: params.baseCandidateIds,
    maxSupplement: params.config.coarse_filter.semantic_supplement.max_supplement
  });
  return withEmbeddingSupplementStatus(supplement);
}

async function collectPreparedEmbeddingSupplement(
  params: CollectEmbeddingSupplementParams,
  service: NonNullable<RecallServiceDependencies["embeddingRecallService"]>,
  preparedQuery: PreparedEmbeddingQueryHandle
): Promise<CollectedEmbeddingSupplementResult> {
  const supplement = await service.querySupplementIfReady!({
    workspaceId: params.workspaceId,
    runId: params.runId,
    eligibleMemories: params.localEligibleCandidates.map((candidate) => candidate.entry),
    baseCandidateIds: params.baseCandidateIds,
    maxSupplement: params.config.coarse_filter.semantic_supplement.max_supplement,
    preparedQuery,
    ...(params.preparedStoredVectors === null
      ? {}
      : { storedVectors: params.preparedStoredVectors })
  });

  return withEmbeddingSupplementStatus(supplement);
}

function withEmbeddingSupplementStatus(
  supplement: EmbeddingRecallSupplementResult
): CollectedEmbeddingSupplementResult {
  return Object.freeze({ ...supplement, collectionStatus: "requested" });
}

export async function collectSynthesisCoarseCandidates(params: {
  readonly dependencies: Pick<RecallServiceDependencies, "memoryRepo" | "synthesisSearchPort">;
  readonly warn: RecallServiceWarnPort;
  readonly workspaceId: string;
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly policy: Readonly<RecallPolicy>;
  readonly degradationReasons?: Set<import("../runtime/recall-service-types.js").RecallDegradationReason>;
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
    return await collectSynthesisChildCandidates({
      dependencies: params.dependencies,
      workspaceId: params.workspaceId,
      queryText: params.queryText,
      queryProbes: params.queryProbes,
      synthesisSearchPort,
      limit
    });
  } catch (error) {
    recordRecallDegradation(params, "synthesis_fts_failed");
    params.warn("synthesis FTS lookup failed", {
      workspace_id: params.workspaceId,
      operation: "synthesis_fts_lookup",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
    return emptySynthesisCoarseFilter();
  }
}

type PrepareEmbeddingSupplementQueryParams = Readonly<{
  readonly dependencies: Pick<RecallServiceDependencies, "embeddingRecallService">;
  readonly config: Readonly<RecallPolicy>;
  readonly workspaceId: string;
  readonly runId: string | null;
  readonly queryText: string | null;
  readonly localEligibleCandidates: readonly Readonly<CoarseRecallCandidate>[];
  readonly lexicalFallbackCount: number;
}>;

type PreparedEmbeddingSupplementQuery = Readonly<{
  readonly handle: PreparedEmbeddingQueryHandle | null;
  readonly storedVectors: PreparedEmbeddingSupplement["storedVectors"] | null;
  readonly degradedReason: string | null;
  readonly preparedSupplementSupported: boolean;
}>;

export async function prepareEmbeddingSupplementQuery(
  params: PrepareEmbeddingSupplementQueryParams
): Promise<PreparedEmbeddingSupplementQuery> {
  const embeddingRecallService = params.dependencies.embeddingRecallService;
  const preparedSupplementSupported = hasEmbeddingSupplementPreparation(embeddingRecallService);
  if (!canPrepareEmbeddingSupplementQuery(params, embeddingRecallService)) {
    return emptyPreparedEmbeddingSupplementQuery(preparedSupplementSupported);
  }
  if (embeddingRecallService === undefined || params.queryText === null) {
    return emptyPreparedEmbeddingSupplementQuery(preparedSupplementSupported);
  }
  if (typeof embeddingRecallService.prepareQuerySupplement === "function") {
    return prepareModernEmbeddingSupplementQuery(params, embeddingRecallService);
  }
  return prepareLegacyEmbeddingSupplementQuery(params, embeddingRecallService);
}

function emptyPreparedEmbeddingSupplementQuery(
  preparedSupplementSupported: boolean
): PreparedEmbeddingSupplementQuery {
  return Object.freeze({
    handle: null,
    storedVectors: null,
    degradedReason: null,
    preparedSupplementSupported
  });
}

async function prepareModernEmbeddingSupplementQuery(
  params: PrepareEmbeddingSupplementQueryParams,
  embeddingRecallService: NonNullable<RecallServiceDependencies["embeddingRecallService"]>
): Promise<PreparedEmbeddingSupplementQuery> {
  const prepared = await embeddingRecallService.prepareQuerySupplement!({
    workspaceId: params.workspaceId,
    runId: params.runId,
    queryText: params.queryText!,
    eligibleMemories: params.localEligibleCandidates.map((candidate) => candidate.entry),
    baseCandidateCount: params.lexicalFallbackCount
  });
  return Object.freeze({
    handle: prepared.preparedQuery,
    storedVectors: prepared.storedVectors,
    degradedReason: prepared.degradedReason === null
      ? null
      : normalizeEmbeddingProviderDegradationReason(prepared.degradedReason),
    preparedSupplementSupported: true
  });
}

function canPrepareEmbeddingSupplementQuery(
  params: Parameters<typeof prepareEmbeddingSupplementQuery>[0],
  embeddingRecallService: RecallServiceDependencies["embeddingRecallService"]
): boolean {
  return !(
    embeddingRecallService === undefined ||
    !hasEmbeddingSupplementPreparation(embeddingRecallService) ||
    params.queryText === null ||
    params.config.coarse_filter.semantic_supplement.embedding_enabled !== true ||
    params.config.coarse_filter.semantic_supplement.max_supplement <= 0 ||
    params.localEligibleCandidates.length === 0
  );
}

function hasEmbeddingSupplementPreparation(
  embeddingRecallService: RecallServiceDependencies["embeddingRecallService"]
): boolean {
  return typeof embeddingRecallService?.prepareQuerySupplement === "function" ||
    typeof embeddingRecallService?.prepareQueryEmbedding === "function";
}

async function prepareLegacyEmbeddingSupplementQuery(
  params: Parameters<typeof prepareEmbeddingSupplementQuery>[0],
  embeddingRecallService: NonNullable<RecallServiceDependencies["embeddingRecallService"]>
): Promise<Readonly<{
  readonly handle: PreparedEmbeddingQueryHandle | null;
  readonly storedVectors: PreparedEmbeddingSupplement["storedVectors"] | null;
  readonly degradedReason: string | null;
  readonly preparedSupplementSupported: boolean;
}>> {
  const prepareQueryEmbedding = embeddingRecallService.prepareQueryEmbedding;
  if (typeof prepareQueryEmbedding !== "function") {
    return Object.freeze({
      handle: null,
      storedVectors: null,
      degradedReason: null,
      preparedSupplementSupported: false
    });
  }
  const precheck = await precheckStoredVectorsForEmbeddingSupplement(params, embeddingRecallService);
  if (precheck !== null) {
    return precheck;
  }
  return Object.freeze({
    handle: prepareQueryEmbedding.call(embeddingRecallService, {
      workspaceId: params.workspaceId,
      runId: params.runId,
      queryText: params.queryText!
    }),
    storedVectors: null,
    degradedReason: null,
    preparedSupplementSupported: true
  });
}

async function precheckStoredVectorsForEmbeddingSupplement(
  params: Parameters<typeof prepareEmbeddingSupplementQuery>[0],
  embeddingRecallService: NonNullable<RecallServiceDependencies["embeddingRecallService"]>
): Promise<Readonly<{
  readonly handle: PreparedEmbeddingQueryHandle | null;
  readonly storedVectors: PreparedEmbeddingSupplement["storedVectors"] | null;
  readonly degradedReason: string | null;
  readonly preparedSupplementSupported: boolean;
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
      degradedReason: normalizeEmbeddingProviderDegradationReason(reason),
      preparedSupplementSupported: true
    });
  }
  return hasStoredVectors
    ? null
    : Object.freeze({
        handle: null,
        storedVectors: null,
        degradedReason: null,
        preparedSupplementSupported: true
      });
}
