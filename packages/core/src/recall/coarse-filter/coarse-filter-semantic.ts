import { type MemoryEntry, type RecallPolicy } from "@do-soul/alaya-protocol";
import { clamp01, errorNameOf, toErrorMessage } from "../runtime/recall-service-helpers.js";
import { recordRecallDegradation } from "../runtime/diagnostics.js";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import {
  intentSplitsByAnchor,
  type RecallQueryAnchors,
  type RecallQueryIntent
} from "../query/recall-query-plan.js";
import {
  EXPANDED_QUERY_RANK_DISCOUNT,
  buildExpandedKeywordQuery
} from "./coarse-candidates.js";
import type { RunCoarseFilterContext } from "./coarse-filter.js";
import type { AddCoarseCandidate } from "./coarse-filter-admission.js";
import { loadEvidenceSearchHitBatches } from "./evidence/search-hit-batches.js";
import { selectEvidenceSearchQueries } from "./evidence/search-query-planner.js";

export interface SemanticSupplementParams {
  readonly context: RunCoarseFilterContext;
  readonly workspaceId: string;
  readonly config: Readonly<RecallPolicy>["coarse_filter"];
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly tier: MemoryEntry["storage_tier"];
  readonly tierScopedSearchEligible: boolean;
  readonly anchors: RecallQueryAnchors;
  readonly intent: RecallQueryIntent;
  readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly addCandidate: AddCoarseCandidate;
  readonly ftsRanks: Map<string, number>;
  readonly trigramFtsRanks: Map<string, number>;
  readonly evidenceFtsRanks: Map<string, number>;
  readonly evidenceFtsRanksPerRef: Map<string, number>;
}

export async function addSemanticSupplementCandidates(params: SemanticSupplementParams): Promise<void> {
  if (
    !params.config.semantic_supplement.enabled ||
    params.config.semantic_supplement.max_supplement <= 0 ||
    params.queryText === null ||
    (params.context.dependencies.memoryRepo.searchByKeywordWithinTier === undefined &&
      params.context.dependencies.memoryRepo.searchByKeywordWithinObjectIds === undefined &&
      params.context.dependencies.memoryRepo.searchByKeyword === undefined)
  ) {
    return;
  }

  const memoryRepo = params.context.dependencies.memoryRepo;
  const searchWithinTier = memoryRepo.searchByKeywordWithinTier?.bind(memoryRepo);
  const searchWithinObjectIds = memoryRepo.searchByKeywordWithinObjectIds?.bind(memoryRepo);
  const searchByKeywordFn = memoryRepo.searchByKeyword?.bind(memoryRepo);
  const objectIds = [...params.byId.keys()];
  const searchScoped = createScopedKeywordSearch(params, {
    searchWithinTier,
    searchWithinObjectIds,
    searchByKeyword: searchByKeywordFn,
    objectIds
  });
  const supplement = await searchScoped(
    params.queryText,
    params.config.semantic_supplement.max_supplement
  );
  for (const match of supplement) {
    const entry = params.byId.get(match.object_id);
    if (entry === undefined) continue;
    params.ftsRanks.set(match.object_id, clamp01(match.normalized_rank));
    if (match.trigram_rank !== undefined && match.trigram_rank > 0) {
      params.trigramFtsRanks.set(match.object_id, clamp01(match.trigram_rank));
    }
    params.addCandidate(entry, "lexical", clamp01(match.normalized_rank), "lexical");
  }

  await addAnchorLaneCandidates(params, objectIds);
  await addExpandedKeywordCandidates(params, searchScoped);
  await addEvidenceFtsCandidates(params);
}

type ScopedKeywordSearch = (
  queryText: string,
  limit: number
) => Promise<readonly { readonly object_id: string; readonly normalized_rank: number; readonly trigram_rank?: number }[]>;
type KeywordSearchResult = Awaited<ReturnType<ScopedKeywordSearch>>;

function createScopedKeywordSearch(
  params: SemanticSupplementParams,
  ports: Readonly<{
    readonly searchWithinTier?: (
      workspaceId: string,
      queryText: string,
      limit: number,
      tier: MemoryEntry["storage_tier"]
    ) => Promise<KeywordSearchResult>;
    readonly searchWithinObjectIds?: (
      workspaceId: string,
      queryText: string,
      limit: number,
      objectIds: readonly string[]
    ) => Promise<KeywordSearchResult>;
    readonly searchByKeyword?: (
      workspaceId: string,
      queryText: string,
      limit: number
    ) => Promise<KeywordSearchResult>;
    readonly objectIds: readonly string[];
  }>
): ScopedKeywordSearch {
  if (params.tierScopedSearchEligible && ports.searchWithinTier !== undefined) {
    return async (queryText, limit) =>
      await ports.searchWithinTier!(params.workspaceId, queryText, limit, params.tier);
  }
  if (ports.searchWithinObjectIds !== undefined) {
    return async (queryText, limit) =>
      await ports.searchWithinObjectIds!(params.workspaceId, queryText, limit, ports.objectIds);
  }
  return async (queryText, limit) =>
    ports.searchByKeyword === undefined
      ? []
      : await ports.searchByKeyword(params.workspaceId, queryText, limit);
}

const MAX_SUBQUERY_ANCHORS = 4;
const MIN_SUBQUERY_ANCHOR_QUOTA = 8;

import { recallEnvFlagEnabled } from "../../config/recall-env-access.js";

// Opt-in flags, default OFF: the anchor lane is recall-neutral and slower.
function envOptIn(...names: readonly string[]): boolean {
  return names.some(recallEnvFlagEnabled);
}

type AnchorSearchFn = (
  workspaceId: string,
  anchorTokens: readonly string[],
  optionalTokens: readonly string[],
  limit: number,
  objectIds: readonly string[]
) => Promise<readonly { readonly object_id: string; readonly normalized_rank: number; readonly trigram_rank?: number }[]>;

// Additive; no-op (relaxed lane stands) when there is no anchor or no repo support.
async function addAnchorLaneCandidates(
  params: SemanticSupplementParams,
  objectIds: readonly string[]
): Promise<void> {
  if (
    params.anchors.required.length === 0 ||
    !envOptIn("ALAYA_RECALL_SEMANTIC_ANCHOR_LANE", "ALAYA_RECALL_ANCHOR_LANE")
  ) {
    return;
  }
  const searchByAnchor = resolveAnchorSearch(params);
  if (searchByAnchor === undefined) return;
  const quota = params.config.semantic_supplement.max_supplement;
  if (shouldSplitAnchors(params)) {
    await addSplitAnchorLaneCandidates(params, objectIds, searchByAnchor, quota);
    return;
  }
  const matches = await searchByAnchor(
    params.workspaceId,
    params.anchors.required,
    params.anchors.optional,
    quota,
    objectIds
  );
  admitAnchorMatches(params, matches);
}

function resolveAnchorSearch(params: SemanticSupplementParams): AnchorSearchFn | undefined {
  const memoryRepo = params.context.dependencies.memoryRepo;
  const searchByAnchorWithinTier = memoryRepo.searchByAnchorWithinTier?.bind(memoryRepo);
  const searchByAnchorWithinIds = memoryRepo.searchByAnchorWithinObjectIds?.bind(memoryRepo);
  return !params.tierScopedSearchEligible || searchByAnchorWithinTier === undefined
    ? searchByAnchorWithinIds
    : async (
        workspaceId: string,
        anchorTokens: readonly string[],
        optionalTokens: readonly string[],
        limit: number
      ) => await searchByAnchorWithinTier(
        workspaceId, anchorTokens, optionalTokens, limit, params.tier
      );
}

async function addSplitAnchorLaneCandidates(
  params: SemanticSupplementParams,
  objectIds: readonly string[],
  searchByAnchor: AnchorSearchFn,
  quota: number
): Promise<void> {
  const perAnchorQuota = Math.max(
    MIN_SUBQUERY_ANCHOR_QUOTA,
    Math.ceil(quota / params.anchors.required.length)
  );
  const matchesByAnchor = await Promise.allSettled(
    params.anchors.required.slice(0, MAX_SUBQUERY_ANCHORS).map((anchor) =>
      searchByAnchor(params.workspaceId, [anchor], params.anchors.optional, perAnchorQuota, objectIds)
    )
  );
  for (const result of matchesByAnchor) {
    if (result.status === "rejected") throw result.reason;
    admitAnchorMatches(params, result.value);
  }
}

// Split a multi-fact query into one anchor lane per anchor so the first cannot crowd the others out. Reserved-quota recall, not delivery.
function shouldSplitAnchors(params: SemanticSupplementParams): boolean {
  return (
    params.anchors.required.length >= 2 &&
    intentSplitsByAnchor(params.intent) &&
    envOptIn("ALAYA_RECALL_SEMANTIC_SUBQUERY", "ALAYA_RECALL_SUBQUERY")
  );
}

function admitAnchorMatches(
  params: SemanticSupplementParams,
  matches: Awaited<ReturnType<AnchorSearchFn>>
): void {
  for (const match of matches) {
    const ranked = clamp01(match.normalized_rank);
    params.ftsRanks.set(match.object_id, Math.max(params.ftsRanks.get(match.object_id) ?? 0, ranked));
    if (match.trigram_rank !== undefined && match.trigram_rank > 0) {
      params.trigramFtsRanks.set(
        match.object_id,
        Math.max(params.trigramFtsRanks.get(match.object_id) ?? 0, clamp01(match.trigram_rank))
      );
    }
    const entry = params.byId.get(match.object_id);
    if (entry !== undefined) {
      params.addCandidate(entry, "lexical_anchor", ranked, "lexical_anchor");
    }
  }
}

async function addExpandedKeywordCandidates(
  params: SemanticSupplementParams,
  searchScoped: ScopedKeywordSearch
): Promise<void> {
  const expandedQuery = buildExpandedKeywordQuery(params.queryProbes);
  if (expandedQuery === null) {
    return;
  }
  const expandedSupplement = await searchScoped(
    expandedQuery,
    params.config.semantic_supplement.max_supplement
  );
  for (const match of expandedSupplement) {
    const entry = params.byId.get(match.object_id);
    if (entry === undefined) continue;
    const discounted = clamp01(match.normalized_rank) * EXPANDED_QUERY_RANK_DISCOUNT;
    if (discounted <= 0) {
      continue;
    }
    if (!params.ftsRanks.has(match.object_id)) {
      params.ftsRanks.set(match.object_id, discounted);
    }
    if (match.trigram_rank !== undefined && match.trigram_rank > 0 && !params.trigramFtsRanks.has(match.object_id)) {
      params.trigramFtsRanks.set(match.object_id, clamp01(match.trigram_rank) * EXPANDED_QUERY_RANK_DISCOUNT);
    }
    params.addCandidate(entry, "lexical", discounted, "lexical_expanded");
  }
}

async function addEvidenceFtsCandidates(params: SemanticSupplementParams): Promise<void> {
  if (
    params.context.dependencies.evidenceSearchPort === undefined ||
    params.context.dependencies.memoryRepo.findByEvidenceRefs === undefined ||
    params.queryText === null
  ) {
    return;
  }
  try {
    const evidenceQueries = selectEvidenceSearchQueries(params.queryText, params.queryProbes);
    const limit = params.config.semantic_supplement.max_supplement;
    const evidenceHitBatches = await loadEvidenceSearchHitBatches({
      workspaceId: params.workspaceId,
      queries: evidenceQueries.map((queryText) => ({ queryText, limit })),
      searchPort: params.context.dependencies.evidenceSearchPort,
      warn: params.context.warn
    });
    const evidenceMatchById = new Map<string, number>();
    for (const evidenceMatches of evidenceHitBatches) {
      for (const match of evidenceMatches) {
        evidenceMatchById.set(
          match.object_id,
          Math.max(evidenceMatchById.get(match.object_id) ?? 0, clamp01(match.normalized_rank))
        );
      }
    }
    await admitEvidenceMatches(params, evidenceMatchById);
  } catch (error) {
    recordRecallDegradation(params.context, "evidence_fts_failed");
    params.context.warn("evidence FTS lookup failed", {
      workspace_id: params.workspaceId,
      operation: "evidence_fts_lookup",
      errorName: errorNameOf(error),
      error: toErrorMessage(error)
    });
  }
}

async function admitEvidenceMatches(
  params: SemanticSupplementParams,
  evidenceMatchById: ReadonlyMap<string, number>
): Promise<void> {
  const evidenceRankById = new Map<string, number>();
  for (const [objectId, normalizedRank] of evidenceMatchById.entries()) {
    const ranked = clamp01(normalizedRank);
    evidenceRankById.set(objectId, ranked);
    params.evidenceFtsRanksPerRef.set(
      objectId,
      Math.max(params.evidenceFtsRanksPerRef.get(objectId) ?? 0, ranked)
    );
  }
  if (evidenceRankById.size === 0 || params.context.dependencies.memoryRepo.findByEvidenceRefs === undefined) {
    return;
  }
  const memoriesByEvidence = await params.context.dependencies.memoryRepo.findByEvidenceRefs(
    params.workspaceId,
    [...evidenceRankById.keys()]
  );
  for (const memory of memoriesByEvidence) {
    if (!params.byId.has(memory.object_id)) {
      continue;
    }
    let bestRank = 0;
    for (const ref of memory.evidence_refs) {
      const evidenceRank = evidenceRankById.get(ref);
      if (evidenceRank !== undefined && evidenceRank > bestRank) {
        bestRank = evidenceRank;
      }
    }
    if (bestRank <= 0) {
      continue;
    }
    params.evidenceFtsRanks.set(
      memory.object_id,
      Math.max(params.evidenceFtsRanks.get(memory.object_id) ?? 0, bestRank)
    );
    params.addCandidate(memory, "lexical", bestRank, "evidence_fts");
  }
}
