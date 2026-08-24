import {
  mergeFtsLaneIds,
  type MemoryEntry,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import {
  clamp01,
  errorNameOf,
  isEvidenceProjectionIntegrityError,
  toErrorMessage
} from "../runtime/recall-service-helpers.js";
import { recordRecallDegradation } from "../runtime/diagnostics.js";
import type { KeywordSearchResult } from "../runtime/recall-service-types.js";
import type { RecallEvidenceProjectionMatchReceipt } from
  "../runtime/recall-service-results.js";
import type { RecallQueryProbes } from "../query/recall-query-probes.js";
import {
  EXPANDED_QUERY_RANK_DISCOUNT,
  buildExpandedKeywordQuery
} from "./coarse-candidates.js";
import type { RunCoarseFilterContext } from "./coarse-filter.js";
import type { AddCoarseCandidate } from "./coarse-filter-admission.js";
import { selectEvidenceSearchQueries } from "./evidence/search-query-planner.js";
import { admitQualifiedEvidenceMatches } from
  "./evidence/qualified-evidence-admission.js";
import type {
  RecallMemoryFieldVariant,
  RecallRetrievalFieldBundle
} from "../field/retrieval/retrieval-field-bundle.js";

export interface SemanticSupplementParams {
  readonly context: RunCoarseFilterContext;
  readonly workspaceId: string;
  readonly config: Readonly<RecallPolicy>["coarse_filter"];
  readonly queryText: string | null;
  readonly queryProbes: Readonly<RecallQueryProbes>;
  readonly tier: MemoryEntry["storage_tier"];
  readonly tierScopedSearchEligible: boolean;
  readonly byId: ReadonlyMap<string, Readonly<MemoryEntry>>;
  readonly addCandidate: AddCoarseCandidate;
  readonly ftsRanks: Map<string, number>;
  readonly trigramFtsRanks: Map<string, number>;
  readonly evidenceFtsRanks: Map<string, number>;
  readonly evidenceFtsRanksPerRef: Map<string, number>;
  readonly evidenceProjectionMatchesByRef: Map<
    string,
    RecallEvidenceProjectionMatchReceipt[]
  >;
  readonly retrievalFieldBundle: Readonly<RecallRetrievalFieldBundle>;
}

type KeywordHit = Readonly<{
  readonly object_id: string;
  readonly normalized_rank: number;
  readonly trigram_rank?: number;
}>;

export async function addSemanticSupplementCandidates(params: SemanticSupplementParams): Promise<void> {
  if (
    !params.config.semantic_supplement.enabled ||
    params.config.semantic_supplement.max_supplement <= 0 ||
    params.queryText === null
  ) {
    return;
  }

  const objectIds = [...params.byId.keys()];
  const searchScoped = createScopedKeywordSearch(params, objectIds);
  const expandedQuery = buildExpandedKeywordQuery(params.queryProbes);
  const relaxedPromise = searchScoped(
    "lexical_relaxed",
    params.queryText,
    params.config.semantic_supplement.max_supplement
  );
  const expandedPromise = expandedQuery === null
    ? Promise.resolve([])
    : searchScoped(
      "lexical_expanded",
      expandedQuery,
      params.config.semantic_supplement.max_supplement
    );
  const evidencePromise = loadEvidenceFtsHitBatches(params);

  admitRelaxedKeywordMatches(params, await relaxedPromise);
  admitExpandedKeywordMatches(params, await expandedPromise);
  const evidenceHitBatches = await evidencePromise;
  if (evidenceHitBatches !== null) {
    await admitEvidenceFtsHitBatches(params, evidenceHitBatches);
  }
}

type ScopedKeywordSearch = (
  variant: RecallMemoryFieldVariant,
  queryText: string,
  limit: number
) => Promise<readonly KeywordHit[]>;

function createScopedKeywordSearch(
  params: SemanticSupplementParams,
  objectIds: readonly string[]
): ScopedKeywordSearch {
  const scope = params.tierScopedSearchEligible
    ? Object.freeze({ tier: params.tier })
    : Object.freeze({ objectIds: Object.freeze([...objectIds]) });
  return async (variant, queryText, limit) =>
    await params.retrievalFieldBundle.searchMemoryKeyword({
      variant,
      queryText,
      limit,
      scope
    });
}

function admitRelaxedKeywordMatches(
  params: SemanticSupplementParams,
  supplement: readonly KeywordHit[]
): void {
  for (const match of supplement) {
    const entry = params.byId.get(match.object_id);
    if (entry === undefined) continue;
    params.ftsRanks.set(match.object_id, clamp01(match.normalized_rank));
    if (match.trigram_rank !== undefined && match.trigram_rank > 0) {
      params.trigramFtsRanks.set(match.object_id, clamp01(match.trigram_rank));
    }
    params.addCandidate(entry, "lexical", clamp01(match.normalized_rank), "lexical");
  }
}

function admitExpandedKeywordMatches(
  params: SemanticSupplementParams,
  expandedSupplement: readonly KeywordHit[]
): void {
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

async function loadEvidenceFtsHitBatches(
  params: SemanticSupplementParams
): Promise<readonly (readonly KeywordSearchResult[])[] | null> {
  if (params.queryText === null) {
    return [];
  }
  const evidenceQueries = selectEvidenceSearchQueries(params.queryText, params.queryProbes);
  const limit = params.config.semantic_supplement.max_supplement;
  try {
    return await params.retrievalFieldBundle.searchEvidenceKeywords({
      queries: evidenceQueries.map((queryText) => ({ queryText, limit }))
    });
  } catch (error) {
    recordEvidenceFtsFailure(params, error);
    return null;
  }
}

async function admitEvidenceFtsHitBatches(
  params: SemanticSupplementParams,
  evidenceHitBatches: readonly (readonly KeywordSearchResult[])[]
): Promise<void> {
  const evidenceMatchByKey = new Map<string, Readonly<KeywordSearchResult>>();
  for (const evidenceMatches of evidenceHitBatches) {
    for (const match of evidenceMatches) {
      const rankedMatch = Object.freeze({
        ...match,
        normalized_rank: clamp01(match.normalized_rank)
      });
      const key = evidenceMatchKey(rankedMatch);
      const current = evidenceMatchByKey.get(key);
      evidenceMatchByKey.set(
        key,
        current === undefined
          ? rankedMatch
          : mergeEvidenceMatchProvenance(rankedMatch, current)
      );
    }
  }
  try {
    await admitEvidenceMatches(params, [...evidenceMatchByKey.values()]);
  } catch (error) {
    if (isEvidenceProjectionIntegrityError(error)) throw error;
    recordEvidenceFtsFailure(params, error);
  }
}

function mergeEvidenceMatchProvenance(
  candidate: Readonly<KeywordSearchResult>,
  current: Readonly<KeywordSearchResult>
): Readonly<KeywordSearchResult> {
  const preferred = isPreferredEvidenceMatch(candidate, current) ? candidate : current;
  const lanes = mergeFtsLaneIds(
    current.matched_fts_lanes ?? [],
    candidate.matched_fts_lanes ?? []
  );
  return Object.freeze({
    ...preferred,
    ...(lanes.length === 0 ? {} : { matched_fts_lanes: lanes })
  });
}

function recordEvidenceFtsFailure(
  params: SemanticSupplementParams,
  error: unknown
): void {
  recordRecallDegradation(params.context, "evidence_fts_failed");
  params.context.warn("evidence FTS lookup failed", {
    workspace_id: params.workspaceId,
    operation: "evidence_fts_lookup",
    errorName: errorNameOf(error),
    error: toErrorMessage(error)
  });
}

function evidenceMatchKey(match: Readonly<KeywordSearchResult>): string {
  const projection = match.matched_projection;
  return projection === undefined
    ? `${match.object_id}\u0000owner`
    : `${match.object_id}\u0000${projection.projection_kind}\u0000${projection.projection_id}`;
}

function isPreferredEvidenceMatch(
  candidate: Readonly<KeywordSearchResult>,
  current: Readonly<KeywordSearchResult>
): boolean {
  if (candidate.normalized_rank !== current.normalized_rank) {
    return candidate.normalized_rank > current.normalized_rank;
  }
  const candidateProjection = candidate.matched_projection;
  const currentProjection = current.matched_projection;
  if (candidateProjection === undefined) return false;
  if (currentProjection === undefined) return true;
  if (candidateProjection.projection_kind !== currentProjection.projection_kind) {
    return candidateProjection.projection_kind < currentProjection.projection_kind;
  }
  return candidateProjection.projection_id < currentProjection.projection_id;
}

async function admitEvidenceMatches(
  params: SemanticSupplementParams,
  evidenceMatches: readonly Readonly<KeywordSearchResult>[]
): Promise<void> {
  const rankedMatches = buildEvidenceMatches(params, evidenceMatches);
  if (rankedMatches.length === 0) return;
  await admitQualifiedEvidenceMatches(params, rankedMatches);
}

function buildEvidenceMatches(
  params: SemanticSupplementParams,
  evidenceMatches: readonly Readonly<KeywordSearchResult>[]
): readonly Readonly<KeywordSearchResult>[] {
  return Object.freeze(evidenceMatches.map((match) => {
    const ranked = clamp01(match.normalized_rank);
    params.evidenceFtsRanksPerRef.set(
      match.object_id,
      Math.max(params.evidenceFtsRanksPerRef.get(match.object_id) ?? 0, ranked)
    );
    return Object.freeze({ ...match, normalized_rank: ranked });
  }));
}
