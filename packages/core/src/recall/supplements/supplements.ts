import type { MemoryEntry, RecallPolicy } from "@do-soul/alaya-protocol";
import type {
  EmbeddingRecallSupplementResult,
  PreparedEmbeddingQueryHandle,
  PreparedEmbeddingSupplement
} from "../../embedding-recall/embedding-recall-service.js";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import {
  clamp01,
  compareMemoryEntries,
  errorNameOf,
  parseEmbeddingPrecheckReason,
  toErrorMessage
} from "../runtime/recall-service-helpers.js";
import type {
  CoarseRecallCandidate,
  RecallServiceDependencies,
  RecallServiceWarnPort
} from "../runtime/recall-service-types.js";
import { buildEvidenceSearchQueries } from "../coarse-filter/coarse-candidates.js";
import { normalizeEmbeddingProviderDegradationReason } from "../runtime/diagnostics.js";
import { recordRecallDegradation } from "../runtime/diagnostics.js";
import { scoreEvidenceAnchorMatch, scoreQueryEvidenceMatch } from "../scoring/query-evidence-scoring.js";
export { collectEmbeddingCoarseInjection } from "../coarse-filter/embedding-coarse-injection.js";

type SynthesisSearchPort = NonNullable<RecallServiceDependencies["synthesisSearchPort"]>;
type SynthesisSearchRow = Awaited<ReturnType<SynthesisSearchPort["findByIds"]>>[number];
type SynthesisChildCandidate = Readonly<{
  readonly candidate: Readonly<CoarseRecallCandidate>;
  readonly synthesisRank: number;
}>;
type RankedSynthesisChildRef = Readonly<{
  readonly synthesisId: string;
  readonly memoryId: string;
  readonly synthesisRank: number;
}>;

const SYNTHESIS_CHILDREN_PER_CAPSULE = 20;
const SYNTHESIS_CHILDREN_GLOBAL_CAP = 40;

export type EmbeddingSupplementCollectionStatus =
  | "disabled"
  | "provider_missing"
  | "query_missing"
  | "empty_candidate_pool"
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
    return params.preparedSupplementSupported
      ? emptyRequestedEmbeddingSupplementResult()
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

function emptyRequestedEmbeddingSupplementResult(): CollectedEmbeddingSupplementResult {
  return withEmbeddingSupplementStatus({
    supplementaryEntries: Object.freeze([]),
    similarityHintsByObjectId: Object.freeze({})
  });
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
    const rankById = await collectSynthesisRankById(params, synthesisSearchPort, limit);
    if (rankById.size === 0) {
      return emptySynthesisCoarseFilter();
    }
    const synthesisRows = await synthesisSearchPort.findByIds(params.workspaceId, [...rankById.keys()]);
    const candidates = await buildSynthesisChildCandidates(params, synthesisRows, rankById);
    return Object.freeze({
      candidates: Object.freeze(candidates.map((candidate) => candidate.candidate)),
      synthesisFtsRanks: buildSynthesisChildFtsRanks(candidates)
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
  readonly preparedSupplementSupported: boolean;
}>> {
  const embeddingRecallService = params.dependencies.embeddingRecallService;
  const preparedSupplementSupported = hasEmbeddingSupplementPreparation(embeddingRecallService);
  if (!canPrepareEmbeddingSupplementQuery(params, embeddingRecallService)) {
    return Object.freeze({
      handle: null,
      storedVectors: null,
      degradedReason: null,
      preparedSupplementSupported
    });
  }
  if (embeddingRecallService === undefined || params.queryText === null) {
    return Object.freeze({
      handle: null,
      storedVectors: null,
      degradedReason: null,
      preparedSupplementSupported
    });
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
          : normalizeEmbeddingProviderDegradationReason(prepared.degradedReason),
      preparedSupplementSupported
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
  const queryResults = await Promise.allSettled(
    buildEvidenceSearchQueries(params.queryText, params.queryProbes).map((synthesisQuery) =>
      synthesisSearchPort.searchByKeyword(
        params.workspaceId,
        synthesisQuery,
        limit
      )
    )
  );
  for (const result of queryResults) {
    if (result.status === "rejected") {
      throw result.reason;
    }
    const matches = result.value;
    for (const match of matches) {
      rankById.set(
        match.object_id,
        Math.max(rankById.get(match.object_id) ?? 0, clamp01(match.normalized_rank))
      );
    }
  }
  return rankById;
}

async function buildSynthesisChildCandidates(
  params: Pick<Parameters<typeof collectSynthesisCoarseCandidates>[0], "dependencies" | "queryProbes" | "workspaceId">,
  synthesisRows: readonly Readonly<SynthesisSearchRow>[],
  rankById: ReadonlyMap<string, number>
): Promise<readonly SynthesisChildCandidate[]> {
  if (typeof params.dependencies.memoryRepo.findByIds !== "function") {
    return Object.freeze([]);
  }
  const childRefs = collectSynthesisChildRefs(params.workspaceId, synthesisRows, rankById);
  if (childRefs.length === 0) {
    return Object.freeze([]);
  }
  const childRows = await params.dependencies.memoryRepo.findByIds(
    params.workspaceId,
    uniqueMemoryIds(childRefs)
  );
  return buildResolvedSynthesisChildren(params, childRefs, childRows);
}

function collectSynthesisChildRefs(
  workspaceId: string,
  synthesisRows: readonly Readonly<SynthesisSearchRow>[],
  rankById: ReadonlyMap<string, number>
): readonly RankedSynthesisChildRef[] {
  const refs: RankedSynthesisChildRef[] = [];
  for (const synthesis of synthesisRows) {
    if (synthesis.workspace_id !== workspaceId) {
      continue;
    }
    const synthesisRank = clamp01(rankById.get(synthesis.object_id) ?? 0);
    const seenInCapsule = new Set<string>();
    for (const rawMemoryId of synthesis.source_memory_refs) {
      const memoryId = rawMemoryId.trim();
      if (memoryId.length === 0 || seenInCapsule.has(memoryId)) {
        continue;
      }
      seenInCapsule.add(memoryId);
      refs.push(Object.freeze({ synthesisId: synthesis.object_id, memoryId, synthesisRank }));
    }
  }
  return Object.freeze(
    refs.sort(
      (left, right) =>
        right.synthesisRank - left.synthesisRank ||
        left.synthesisId.localeCompare(right.synthesisId) ||
        left.memoryId.localeCompare(right.memoryId)
    )
  );
}

function uniqueMemoryIds(refs: readonly RankedSynthesisChildRef[]): readonly string[] {
  return Object.freeze(
    Array.from(new Set(refs.map((ref) => ref.memoryId)))
  );
}

function buildResolvedSynthesisChildren(
  params: Pick<Parameters<typeof collectSynthesisCoarseCandidates>[0], "queryProbes" | "workspaceId">,
  childRefs: readonly RankedSynthesisChildRef[],
  childRows: readonly Readonly<MemoryEntry>[]
): readonly SynthesisChildCandidate[] {
  const childById = new Map(childRows.map((child) => [child.object_id, child]));
  const acceptedByCapsule = new Map<string, number>();
  const candidateById = new Map<string, SynthesisChildCandidate>();
  for (const childRef of childRefs) {
    if ((acceptedByCapsule.get(childRef.synthesisId) ?? 0) >= SYNTHESIS_CHILDREN_PER_CAPSULE) {
      continue;
    }
    const child = childById.get(childRef.memoryId);
    if (child === undefined || !isUsableSynthesisChild(child, params.workspaceId)) {
      continue;
    }
    acceptedByCapsule.set(childRef.synthesisId, (acceptedByCapsule.get(childRef.synthesisId) ?? 0) + 1);
    const specificity = scoreSynthesisChildSpecificity(child, params.queryProbes);
    const next = buildSynthesisChildCandidate(child, childRef.synthesisRank, specificity);
    const current = candidateById.get(child.object_id);
    if (current === undefined || next.synthesisRank > current.synthesisRank) {
      candidateById.set(child.object_id, next);
    }
  }
  return Object.freeze(
    [...candidateById.values()]
      .sort(compareSynthesisChildCandidates)
      .slice(0, SYNTHESIS_CHILDREN_GLOBAL_CAP)
  );
}

function isUsableSynthesisChild(child: Readonly<MemoryEntry>, workspaceId: string): boolean {
  return child.workspace_id === workspaceId && child.lifecycle_state === "active";
}

function scoreSynthesisChildSpecificity(
  child: Readonly<MemoryEntry>,
  queryProbes: Readonly<RecallQueryProbes>
): number {
  return clamp01(
    scoreQueryEvidenceMatch(child, queryProbes) +
      0.5 * scoreEvidenceAnchorMatch(child, new Set(queryProbes.evidence_refs))
  );
}

function buildSynthesisChildCandidate(
  child: Readonly<MemoryEntry>,
  synthesisRank: number,
  specificity: number
): SynthesisChildCandidate {
  const childRank = clamp01(synthesisRank * Math.max(specificity, 0.05));
  return Object.freeze({
    candidate: Object.freeze({
      entry: child,
      originPlane: "workspace_local" as const,
      sourceChannel: "synthesis_child",
      sourceChannels: Object.freeze(["synthesis_child", "synthesis_fts"]),
      admissionPlanes: Object.freeze(["synthesis_child" as const]),
      firstAdmissionPlane: "synthesis_child" as const,
      structuralScore: 0
    }),
    synthesisRank: childRank
  });
}

function compareSynthesisChildCandidates(
  left: SynthesisChildCandidate,
  right: SynthesisChildCandidate
): number {
  const delta = right.synthesisRank - left.synthesisRank;
  return delta !== 0 ? delta : compareMemoryEntries(left.candidate.entry, right.candidate.entry);
}

function buildSynthesisChildFtsRanks(
  candidates: readonly SynthesisChildCandidate[]
): Readonly<Record<string, number>> {
  return Object.freeze(
    Object.fromEntries(candidates.map((candidate) => [
      candidate.candidate.entry.object_id,
      candidate.synthesisRank
    ] as const))
  );
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
