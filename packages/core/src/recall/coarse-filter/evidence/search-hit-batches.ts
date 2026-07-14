import {
  loadIndexAlignedSearchBatches,
  type IndexAlignedBatchFailure
} from "../../runtime/orchestration/index-aligned-search-batches.js";
import type {
  KeywordSearchBatchQuery,
  KeywordSearchResult,
  RecallServiceEvidenceSearchPort,
  RecallServiceWarnPort
} from "../../runtime/recall-service-types.js";

type LoadEvidenceSearchHitBatchesParams = Readonly<{
  readonly workspaceId: string;
  readonly queries: readonly Readonly<KeywordSearchBatchQuery>[];
  readonly searchPort: RecallServiceEvidenceSearchPort;
  readonly warn: RecallServiceWarnPort;
}>;

export async function loadEvidenceSearchHitBatches(
  params: LoadEvidenceSearchHitBatchesParams
): Promise<readonly (readonly KeywordSearchResult[])[]> {
  const searchMany = params.searchPort.searchManyByKeyword;
  return loadIndexAlignedSearchBatches({
    lookups: params.queries,
    ...(searchMany === undefined ? {} : {
      searchMany: (queries: readonly Readonly<KeywordSearchBatchQuery>[]) =>
        searchMany.call(params.searchPort, params.workspaceId, queries)
    }),
    searchOne: (query) => params.searchPort.searchByKeyword(
      params.workspaceId,
      query.queryText,
      query.limit
    ),
    isHit: isKeywordSearchResult,
    maxHitsForLookup: (query) => query.limit,
    onBatchFailure: (failure) => warnBatchFailure(params, failure)
  });
}

function isKeywordSearchResult(value: unknown): value is KeywordSearchResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const hit = value as Record<string, unknown>;
  return typeof hit.object_id === "string" && hit.object_id.trim().length > 0 &&
    typeof hit.normalized_rank === "number" && Number.isFinite(hit.normalized_rank) &&
    (hit.trigram_rank === undefined ||
      (typeof hit.trigram_rank === "number" && Number.isFinite(hit.trigram_rank)));
}

function warnBatchFailure(
  params: LoadEvidenceSearchHitBatchesParams,
  failure: IndexAlignedBatchFailure
): void {
  params.warn("evidence FTS batch lookup failed; using scalar lookups", {
    operation: "evidence_fts_batch_lookup",
    failure_class: failure.failureClass,
    expected_count: params.queries.length,
    returned_count: failure.returnedCount,
    valid_batch_count: failure.validBatchCount,
    invalid_index: failure.invalidIndex
  });
}
