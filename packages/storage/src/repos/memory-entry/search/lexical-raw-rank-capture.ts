import { compareCodeUnits } from "@do-soul/alaya-protocol";
import {
  buildGroupedOrdinalScores,
  mergeKeywordSearchRows,
  type ExactKeywordSearchRow,
  type FtsKeywordSearchRow
} from "../keyword-search.js";
import type { MemoryEntryKeywordSearchResult } from "../types.js";

export const LEXICAL_RAW_RANK_RECEIPT_SCHEMA_VERSION = 1 as const;
export const LEXICAL_RAW_RANK_RECEIPT_ID = "alaya.recall.x0.lexical-raw-rank.v1";
export const LEXICAL_RAW_RANK_PRODUCER_ID =
  "alaya.storage.mergeKeywordSearchRows.v1";

export type LexicalRawRankLaneId =
  | "exact"
  | "porter"
  | "trigram"
  | "object_key_porter"
  | "object_key_trigram";

export type LexicalRawKeyKind = "matched_token_count" | "bm25_raw_rank";
export type LexicalLaneListStatus = "empty" | "complete" | "truncated";
export type LexicalUnseenFrontier =
  | number
  | Readonly<{ readonly status: "unavailable"; readonly reason: "producer_order_not_monotone" }>;

export interface LexicalLaneRowReceipt {
  readonly candidate_key: string;
  readonly raw_group_key: number;
  readonly lane_index: number;
  readonly grouped_ordinal: number;
  readonly observation_state: "observed";
}

export interface LexicalLaneCapture {
  readonly lane_id: LexicalRawRankLaneId;
  readonly raw_key_kind: LexicalRawKeyKind;
  readonly source_priority: 0 | 1 | 2;
  readonly applicability_source: "memory_fts_lane";
  readonly list_n: number;
  readonly requested_limit: number;
  readonly status: LexicalLaneListStatus;
  readonly rows: readonly LexicalLaneRowReceipt[];
  readonly unseen_upper_bound: LexicalUnseenFrontier;
}

export interface LexicalLaneHit {
  readonly lane_id: LexicalRawRankLaneId;
  readonly raw_group_key: number;
  readonly grouped_ordinal: number;
  readonly lane_index: number;
}

export interface LexicalCandidateMergeProvenance {
  readonly candidate_key: string;
  readonly lane_hits: readonly LexicalLaneHit[];
  readonly admitted: boolean;
  readonly chosen_lane_id: LexicalRawRankLaneId | null;
  readonly chosen_normalized_rank: number | null;
  readonly post_merge_index: number | null;
  readonly discarded_lane_ids: readonly LexicalRawRankLaneId[];
}

export interface LexicalPostMergeRow {
  readonly candidate_key: string;
  readonly normalized_rank: number;
  readonly trigram_rank?: number;
  readonly object_key_rank?: number;
}

export interface LexicalRawRankReceipt {
  readonly schema_version: typeof LEXICAL_RAW_RANK_RECEIPT_SCHEMA_VERSION;
  readonly receipt_id: typeof LEXICAL_RAW_RANK_RECEIPT_ID;
  readonly producer_id: typeof LEXICAL_RAW_RANK_PRODUCER_ID;
  readonly query_run_id: string;
  readonly merge_limit: number;
  readonly lanes: readonly LexicalLaneCapture[];
  readonly candidates: readonly LexicalCandidateMergeProvenance[];
  readonly post_merge: readonly LexicalPostMergeRow[];
}

export interface LexicalRawRankCaptureInput {
  readonly query_run_id: string;
  readonly limit: number;
  readonly exactRows: readonly ExactKeywordSearchRow[];
  readonly trigramRows: readonly FtsKeywordSearchRow[];
  readonly porterRows?: readonly FtsKeywordSearchRow[];
  readonly objectKeyLanes?: Readonly<{
    readonly porter?: readonly FtsKeywordSearchRow[];
    readonly trigram?: readonly FtsKeywordSearchRow[];
  }>;
}

type LaneSpec = Readonly<{
  readonly lane_id: LexicalRawRankLaneId;
  readonly raw_key_kind: LexicalRawKeyKind;
  readonly source_priority: 0 | 1 | 2;
  readonly rows: readonly Readonly<{
    readonly object_id: string;
    readonly raw_group_key: number;
  }>[];
}>;

type MergeWinner = Readonly<{
  readonly lane_id: LexicalRawRankLaneId;
  readonly ordinal: number;
  readonly priority: number;
}>;

export function mergeKeywordSearchRowsWithLexicalCapture(
  input: Omit<LexicalRawRankCaptureInput, "query_run_id">,
  capture: Readonly<{
    readonly query_run_id: string;
    readonly sink: (receipt: LexicalRawRankReceipt) => void;
  }>
): readonly Readonly<MemoryEntryKeywordSearchResult>[] {
  const merged = mergeKeywordSearchRows(
    input.exactRows,
    input.trigramRows,
    input.limit,
    input.porterRows ?? [],
    input.objectKeyLanes ?? {}
  );
  capture.sink(captureLexicalRawRankReceipt({
    ...input,
    query_run_id: capture.query_run_id,
    merged
  }));
  return merged;
}

export type LexicalLiveMergeCapture = Readonly<{
  readonly query_run_id: string;
  readonly merge_limit: number;
  readonly lanes: readonly Readonly<{
    readonly lane_id: LexicalRawRankLaneId;
    readonly raw_key_kind: LexicalRawKeyKind;
    readonly list_n: number;
    readonly status: LexicalLaneListStatus;
  }>[];
  readonly candidates: readonly Readonly<{
    readonly candidate_key: string;
    readonly chosen_lane_id: LexicalRawRankLaneId | null;
    readonly chosen_normalized_rank: number | null;
    readonly admitted: boolean;
  }>[];
}>;

export function stripLexicalRawRankForLiveCapture(
  receipt: LexicalRawRankReceipt
): LexicalLiveMergeCapture {
  return Object.freeze({
    query_run_id: receipt.query_run_id,
    merge_limit: receipt.merge_limit,
    lanes: Object.freeze(receipt.lanes.map((lane) => Object.freeze({
      lane_id: lane.lane_id,
      raw_key_kind: lane.raw_key_kind,
      list_n: lane.list_n,
      status: lane.status
    }))),
    candidates: Object.freeze(receipt.candidates.map((candidate) => Object.freeze({
      candidate_key: candidate.candidate_key,
      chosen_lane_id: candidate.chosen_lane_id,
      chosen_normalized_rank: candidate.chosen_normalized_rank,
      admitted: candidate.admitted
    })))
  });
}

export function captureLexicalRawRankReceipt(
  input: LexicalRawRankCaptureInput & {
    readonly merged: readonly Readonly<MemoryEntryKeywordSearchResult>[];
  }
): LexicalRawRankReceipt {
  const lanes = Object.freeze(laneSpecs(input).map((spec) => captureOneLane(spec, input.limit)));
  return Object.freeze({
    schema_version: LEXICAL_RAW_RANK_RECEIPT_SCHEMA_VERSION,
    receipt_id: LEXICAL_RAW_RANK_RECEIPT_ID,
    producer_id: LEXICAL_RAW_RANK_PRODUCER_ID,
    query_run_id: input.query_run_id,
    merge_limit: input.limit,
    lanes,
    candidates: buildCandidateProvenance(lanes, selectMergeWinners(lanes), input.merged),
    post_merge: Object.freeze(input.merged.map(toPostMergeRow))
  });
}

function laneSpecs(input: LexicalRawRankCaptureInput): readonly LaneSpec[] {
  const objectKey = input.objectKeyLanes ?? {};
  return Object.freeze([
    exactLaneSpec(input.exactRows),
    ftsLaneSpec("porter", 1, input.porterRows ?? []),
    ftsLaneSpec("object_key_porter", 1, objectKey.porter ?? []),
    ftsLaneSpec("trigram", 2, input.trigramRows),
    ftsLaneSpec("object_key_trigram", 2, objectKey.trigram ?? [])
  ]);
}

function exactLaneSpec(rows: readonly ExactKeywordSearchRow[]): LaneSpec {
  return Object.freeze({
    lane_id: "exact",
    raw_key_kind: "matched_token_count",
    source_priority: 0,
    rows: Object.freeze(rows.map((row) => Object.freeze({
      object_id: row.object_id,
      raw_group_key: row.matched_token_count
    })))
  });
}

function ftsLaneSpec(
  lane_id: Exclude<LexicalRawRankLaneId, "exact">,
  source_priority: 1 | 2,
  rows: readonly FtsKeywordSearchRow[]
): LaneSpec {
  return Object.freeze({
    lane_id,
    raw_key_kind: "bm25_raw_rank",
    source_priority,
    rows: Object.freeze(rows.map((row) => Object.freeze({
      object_id: row.object_id,
      raw_group_key: row.raw_rank
    })))
  });
}

function captureOneLane(spec: LaneSpec, limit: number): LexicalLaneCapture {
  const scores = buildGroupedOrdinalScores(spec.rows, (row) => row.raw_group_key);
  const rows = Object.freeze(spec.rows.map((row, index) => Object.freeze({
    candidate_key: row.object_id,
    raw_group_key: row.raw_group_key,
    lane_index: index,
    grouped_ordinal: scores[index] ?? 0,
    observation_state: "observed" as const
  })));
  const status = laneStatus(rows.length, limit);
  return Object.freeze({
    lane_id: spec.lane_id,
    raw_key_kind: spec.raw_key_kind,
    source_priority: spec.source_priority,
    applicability_source: "memory_fts_lane",
    list_n: rows.length,
    requested_limit: limit,
    status,
    rows,
    unseen_upper_bound: laneUnseenFrontier(rows, spec.raw_key_kind, status)
  });
}

// FTS/exact producers emit ranking-key order; last ordinal is a bound only when that order holds.

function laneUnseenFrontier(
  rows: readonly LexicalLaneRowReceipt[],
  kind: LexicalRawKeyKind,
  status: LexicalLaneListStatus
): LexicalUnseenFrontier {
  if (status === "empty" || status === "complete") return 0;
  if (!rankingKeysAreMonotone(rows, kind)) {
    return Object.freeze({
      status: "unavailable" as const,
      reason: "producer_order_not_monotone" as const
    });
  }
  return rows[rows.length - 1]!.grouped_ordinal;
}

function rankingKeysAreMonotone(
  rows: readonly LexicalLaneRowReceipt[],
  kind: LexicalRawKeyKind
): boolean {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!.raw_group_key;
    const next = rows[index]!.raw_group_key;
    if (kind === "bm25_raw_rank" && next < previous) return false;
    if (kind === "matched_token_count" && next > previous) return false;
  }
  return true;
}

function laneStatus(listN: number, limit: number): LexicalLaneListStatus {
  if (listN === 0) return "empty";
  return listN >= limit ? "truncated" : "complete";
}

function selectMergeWinners(
  lanes: readonly LexicalLaneCapture[]
): ReadonlyMap<string, MergeWinner> {
  const winners = new Map<string, MergeWinner>();
  for (const lane of lanes) {
    for (const row of lane.rows) {
      considerWinner(winners, row.candidate_key, Object.freeze({
        lane_id: lane.lane_id,
        ordinal: row.grouped_ordinal,
        priority: lane.source_priority
      }));
    }
  }
  return winners;
}

function considerWinner(
  winners: Map<string, MergeWinner>,
  candidateKey: string,
  hit: MergeWinner
): void {
  const existing = winners.get(candidateKey);
  if (
    existing !== undefined &&
    (existing.ordinal > hit.ordinal ||
      (existing.ordinal === hit.ordinal && existing.priority <= hit.priority))
  ) {
    return;
  }
  winners.set(candidateKey, hit);
}

function buildCandidateProvenance(
  lanes: readonly LexicalLaneCapture[],
  winners: ReadonlyMap<string, MergeWinner>,
  merged: readonly Readonly<MemoryEntryKeywordSearchResult>[]
): readonly LexicalCandidateMergeProvenance[] {
  const mergedIndex = new Map(merged.map((row, index) => [row.object_id, index]));
  const keys = [...new Set(lanes.flatMap((lane) => lane.rows.map((row) => row.candidate_key)))]
    .sort(compareCodeUnits);
  return Object.freeze(keys.map((candidateKey) =>
    provenanceForCandidate(candidateKey, lanes, winners.get(candidateKey), mergedIndex.get(candidateKey))
  ));
}

function provenanceForCandidate(
  candidateKey: string,
  lanes: readonly LexicalLaneCapture[],
  winner: MergeWinner | undefined,
  postMergeIndex: number | undefined
): LexicalCandidateMergeProvenance {
  const laneHits = Object.freeze(lanes.flatMap((lane) =>
    lane.rows.filter((row) => row.candidate_key === candidateKey).map((row) => Object.freeze({
      lane_id: lane.lane_id,
      raw_group_key: row.raw_group_key,
      grouped_ordinal: row.grouped_ordinal,
      lane_index: row.lane_index
    }))
  ));
  return Object.freeze({
    candidate_key: candidateKey,
    lane_hits: laneHits,
    admitted: postMergeIndex !== undefined,
    chosen_lane_id: winner?.lane_id ?? null,
    chosen_normalized_rank: winner?.ordinal ?? null,
    post_merge_index: postMergeIndex ?? null,
    discarded_lane_ids: Object.freeze(
      laneHits.map((hit) => hit.lane_id).filter((laneId) => laneId !== winner?.lane_id)
    )
  });
}

function toPostMergeRow(
  row: Readonly<MemoryEntryKeywordSearchResult>
): LexicalPostMergeRow {
  return Object.freeze({
    candidate_key: row.object_id,
    normalized_rank: row.normalized_rank,
    ...(row.trigram_rank === undefined ? {} : { trigram_rank: row.trigram_rank }),
    ...(row.object_key_rank === undefined ? {} : { object_key_rank: row.object_key_rank })
  });
}
