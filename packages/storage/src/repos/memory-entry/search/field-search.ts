import type { StorageTier } from "@do-soul/alaya-protocol";

import {
  buildAnchorScopedFtsMatch,
} from "../../shared/fts-lane-routing.js";
import { buildMonotoneFieldRefinementLevels } from
  "../../shared/monotone-field-refinement.js";
import {
  buildGroupedOrdinalScores,
  mergeExactKeywordSearchRows,
  mergeKeywordSearchRows,
  normalizeKeywordSearchObjectIds,
  partitionKeywordLaneTokens,
  tokenizeFtsQuery,
  type ExactKeywordSearchRow,
  type FtsKeywordSearchRow,
  type KeywordLaneTokens
} from "../keyword-search.js";
import type {
  MemoryEntryKeywordFieldResult,
  MemoryEntryKeywordLaneReceipt
} from "../types.js";
import {
  searchExactKeywordRows,
  searchMemoryFtsLaneRows,
  searchPorterKeywordRows,
  searchTrigramKeywordRows,
  type MemoryEntrySearchWorkflowHost
} from "../search-workflows.js";
import { searchObjectKeyKeywordLanes } from "./object-key-fts.js";
import { captureLexicalRawRankReceipt } from "./lexical-raw-rank-capture.js";

type KeywordFieldLane = MemoryEntryKeywordLaneReceipt["lane"];

const MEMORY_FTS_TRIGRAM = "memory_content_fts";
const MEMORY_FTS_PORTER = "memory_content_fts_porter";

export async function searchByKeywordField(
  this: MemoryEntrySearchWorkflowHost,
  workspaceId: string,
  queryText: string,
  limit: number,
  scope: Readonly<{ readonly objectIds?: readonly string[]; readonly tier?: StorageTier }> = {},
  refinementDepths: readonly number[] = []
): Promise<Readonly<MemoryEntryKeywordFieldResult>> {
  if (!Number.isInteger(limit) || limit <= 0) return emptyKeywordField();
  const tokens = tokenizeFtsQuery(queryText);
  if (tokens.length === 0) return ineligibleKeywordField();
  const laneTokens = partitionKeywordLaneTokens(tokens);
  const objectIds = scope.objectIds === undefined
    ? undefined
    : normalizeKeywordSearchObjectIds(scope.objectIds);
  const depths = normalizeRefinementDepths(limit, refinementDepths);
  const maxDepth = depths.at(-1) ?? limit;
  const rows = this.activeConnection().transaction(() => {
    const objectKeys = searchObjectKeyKeywordLanes.call(this, {
      workspaceId,
      porterTokens: laneTokens.porter,
      trigramTokens: laneTokens.trigram,
      exactTokens: laneTokens.exact,
      limit: maxDepth,
      candidateObjectIds: objectIds,
      tier: scope.tier
    });
    return Object.freeze({
      exact: mergeExactKeywordSearchRows(
        searchExactKeywordRows.call(
          this, workspaceId, laneTokens.exact, maxDepth, objectIds, scope.tier
        ),
        objectKeys.exact
      ),
      porter: searchPorterKeywordRows.call(
        this, workspaceId, laneTokens.porter, maxDepth, objectIds, scope.tier
      ),
      trigram: searchTrigramKeywordRows.call(
        this, workspaceId, laneTokens.trigram, maxDepth, objectIds, scope.tier
      ),
      keyPorter: objectKeys.porter,
      keyTrigram: objectKeys.trigram
    });
  })();
  const base = buildKeywordFieldView(rows, laneTokens, limit);
  return fieldWithRefinements(base, buildMonotoneFieldRefinementLevels(
    base.matches,
    depths,
    (depth) => buildKeywordFieldView(rows, laneTokens, depth)
  ));
}

export async function searchByAnchorField(
  this: MemoryEntrySearchWorkflowHost,
  workspaceId: string,
  anchorTokens: readonly string[],
  optionalTokens: readonly string[],
  limit: number,
  scope: Readonly<{ readonly objectIds?: readonly string[]; readonly tier?: StorageTier }> = {},
  refinementDepths: readonly number[] = []
): Promise<Readonly<MemoryEntryKeywordFieldResult>> {
  if (!Number.isInteger(limit) || limit <= 0) return emptyKeywordField();
  const matchExpression = buildAnchorScopedFtsMatch(workspaceId, anchorTokens, optionalTokens);
  if (matchExpression === null) return ineligibleKeywordField();
  const objectIds = scope.objectIds === undefined
    ? undefined
    : normalizeKeywordSearchObjectIds(scope.objectIds);
  const depths = normalizeRefinementDepths(limit, refinementDepths);
  const maxDepth = depths.at(-1) ?? limit;
  const rows = this.activeConnection().transaction(() => Object.freeze({
    trigram: searchMemoryFtsLaneRows.call(
      this, MEMORY_FTS_TRIGRAM, workspaceId, matchExpression, maxDepth, objectIds, scope.tier
    ),
    porter: searchMemoryFtsLaneRows.call(
      this, MEMORY_FTS_PORTER, workspaceId, matchExpression, maxDepth, objectIds, scope.tier
    )
  }))();
  const base = buildAnchorFieldView(rows, limit);
  return fieldWithRefinements(base, buildMonotoneFieldRefinementLevels(
    base.matches,
    depths,
    (depth) => buildAnchorFieldView(rows, depth)
  ));
}

type KeywordFieldRows = Readonly<{
  readonly exact: readonly ExactKeywordSearchRow[];
  readonly porter: readonly FtsKeywordSearchRow[];
  readonly trigram: readonly FtsKeywordSearchRow[];
  readonly keyPorter: readonly FtsKeywordSearchRow[];
  readonly keyTrigram: readonly FtsKeywordSearchRow[];
}>;

function buildKeywordFieldView(
  rows: KeywordFieldRows,
  tokens: KeywordLaneTokens,
  depth: number
) {
  const exactRows = rows.exact.slice(0, depth);
  const trigramRows = rows.trigram.slice(0, depth);
  const porterRows = rows.porter.slice(0, depth);
  const objectKeyLanes = Object.freeze({
    porter: rows.keyPorter.slice(0, depth),
    trigram: rows.keyTrigram.slice(0, depth)
  });
  const matches = mergeKeywordSearchRows(
    exactRows, trigramRows, depth, porterRows, objectKeyLanes
  );
  return Object.freeze({
    matches,
    lanes: Object.freeze([
      buildKeywordFieldLaneReceipt(
        "exact", rows.exact, depth, tokens.exact.length > 0,
        (row) => row.matched_token_count
      ),
      buildKeywordFieldLaneReceipt(
        "porter", rows.porter, depth, tokens.porter.length > 0,
        (row) => row.raw_rank
      ),
      buildKeywordFieldLaneReceipt(
        "trigram", rows.trigram, depth, tokens.trigram.length > 0,
        (row) => row.raw_rank
      )
    ]),
    lexical_raw_rank: captureLexicalRawRankReceipt({
      query_run_id: `memory.keyword.depth:${depth}`,
      limit: depth,
      exactRows,
      trigramRows,
      porterRows,
      objectKeyLanes,
      merged: matches
    })
  });
}

function buildAnchorFieldView(
  rows: Readonly<{
    readonly porter: readonly FtsKeywordSearchRow[];
    readonly trigram: readonly FtsKeywordSearchRow[];
  }>,
  depth: number
) {
  return Object.freeze({
    matches: mergeKeywordSearchRows(
      [], rows.trigram.slice(0, depth), depth, rows.porter.slice(0, depth)
    ),
    lanes: Object.freeze([
      unavailableOrIneligibleRawLane("exact", "ineligible"),
      buildKeywordFieldLaneReceipt("porter", rows.porter, depth, true, (row) => row.raw_rank),
      buildKeywordFieldLaneReceipt("trigram", rows.trigram, depth, true, (row) => row.raw_rank)
    ])
  });
}

function fieldWithRefinements(
  base: Pick<MemoryEntryKeywordFieldResult, "matches" | "lanes">,
  levels: readonly NonNullable<MemoryEntryKeywordFieldResult["refinement_levels"]>[number][]
): Readonly<MemoryEntryKeywordFieldResult> {
  return Object.freeze({
    ...base,
    ...(levels.length === 0
      ? {}
      : { refinement_levels: Object.freeze(levels.map((level) => Object.freeze(level))) })
  });
}

function normalizeRefinementDepths(
  baseDepth: number,
  depths: readonly number[]
): readonly number[] {
  const normalized = [...new Set(depths)].sort((left, right) => left - right);
  if (normalized.some((depth) => !Number.isSafeInteger(depth) || depth <= baseDepth)) {
    throw new RangeError("field refinement depths must be increasing above the base depth");
  }
  return Object.freeze(normalized);
}

function buildKeywordFieldLaneReceipt<T extends ExactKeywordSearchRow | FtsKeywordSearchRow>(
  lane: KeywordFieldLane,
  rows: readonly Readonly<T>[],
  limit: number,
  eligible: boolean,
  groupValue: (row: Readonly<T>) => number
): Readonly<MemoryEntryKeywordLaneReceipt> {
  if (!eligible) return unavailableOrIneligibleRawLane(lane, "ineligible");
  const retained = rows.slice(0, limit);
  const scores = buildGroupedOrdinalScores(retained, groupValue);
  const truncated = rows.length >= limit;
  const observations = Object.freeze(retained.map((row, index) => Object.freeze({
    object_id: row.object_id,
    rank: index + 1,
    normalized_rank: scores[index] ?? 0
  })));
  return Object.freeze({
    lane,
    status: truncated ? "truncated" as const : "complete" as const,
    depth: observations.length,
    observations,
    unseen_upper_bound: truncated ? 1 : 0
  });
}

function ineligibleKeywordField(): Readonly<MemoryEntryKeywordFieldResult> {
  return Object.freeze({
    matches: Object.freeze([]),
    lanes: Object.freeze([
    unavailableOrIneligibleRawLane("exact", "ineligible"),
    unavailableOrIneligibleRawLane("porter", "ineligible"),
    unavailableOrIneligibleRawLane("trigram", "ineligible")
    ])
  });
}

function unavailableOrIneligibleRawLane(
  lane: KeywordFieldLane,
  status: "ineligible" | "unavailable"
): Readonly<MemoryEntryKeywordLaneReceipt> {
  return Object.freeze({
    lane,
    status,
    depth: 0,
    observations: Object.freeze([]),
    unseen_upper_bound: null
  });
}

function emptyKeywordField(): Readonly<MemoryEntryKeywordFieldResult> {
  return Object.freeze({ matches: Object.freeze([]), lanes: Object.freeze([]) });
}
