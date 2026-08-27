import {
  LEXICAL_BOUND_PRODUCER_ID,
  LEXICAL_RAW_RANK_RECEIPT_ID,
  type LexicalBoundCandidateProvenance,
  type LexicalBoundLaneCapture,
  type LexicalBoundLaneHit,
  type LexicalBoundLaneId,
  type LexicalBoundLaneRow,
  type LexicalBoundListStatus,
  type LexicalBoundPostMergeRow,
  type LexicalBoundProducerReceipt,
  type LexicalBoundRawKeyKind,
  type LexicalUnseenFrontier
} from "../../recall-search-port-types.js";
import { assertReceiptUniverseSet, freezeLaneUniverse } from "./lexical-lane-universe-freeze.js";

export {
  LEXICAL_BOUND_PRODUCER_ID,
  LEXICAL_RAW_RANK_RECEIPT_ID
} from "../../recall-search-port-types.js";
export type {
  LexicalBoundCandidateProvenance,
  LexicalBoundLaneCapture,
  LexicalBoundLaneHit,
  LexicalBoundLaneId,
  LexicalBoundLaneRow,
  LexicalBoundListStatus,
  LexicalBoundPostMergeRow,
  LexicalBoundProducerReceipt,
  LexicalBoundRawKeyKind,
  LexicalUnseenFrontier
} from "../../recall-search-port-types.js";

export function freezeProducerReceipt(value: unknown): LexicalBoundProducerReceipt {
  if (!isRecord(value) || value.schema_version !== 1 ||
      value.receipt_id !== LEXICAL_RAW_RANK_RECEIPT_ID ||
      value.producer_id !== LEXICAL_BOUND_PRODUCER_ID ||
      typeof value.query_run_id !== "string" || value.query_run_id.trim().length === 0 ||
      !Number.isInteger(value.merge_limit) || Number(value.merge_limit) < 0 ||
      !Array.isArray(value.lanes) || !isDenseArray(value.lanes) ||
      !Array.isArray(value.candidates) || !isDenseArray(value.candidates) ||
      !Array.isArray(value.post_merge) || !isDenseArray(value.post_merge)) {
    throw new TypeError("lexical bound producer receipt is invalid");
  }
  const lanes = Object.freeze(value.lanes.map(freezeLane));
  assertReceiptUniverseSet(lanes);
  return Object.freeze({
    schema_version: 1 as const,
    receipt_id: LEXICAL_RAW_RANK_RECEIPT_ID,
    producer_id: LEXICAL_BOUND_PRODUCER_ID,
    query_run_id: value.query_run_id,
    merge_limit: Number(value.merge_limit),
    lanes,
    candidates: Object.freeze(value.candidates.map(freezeCandidate)),
    post_merge: Object.freeze(value.post_merge.map(freezePostMerge))
  });
}

function lexicalRankingKeysAreMonotone(
  rows: readonly Readonly<{ readonly raw_group_key: number }>[],
  kind: LexicalBoundRawKeyKind
): boolean {
  for (let index = 1; index < rows.length; index += 1) {
    const previous = rows[index - 1]!.raw_group_key;
    const next = rows[index]!.raw_group_key;
    if (kind === "bm25_raw_rank" && next < previous) return false;
    if (kind === "matched_token_count" && next > previous) return false;
  }
  return true;
}

function freezeLane(value: unknown): LexicalBoundLaneCapture {
  if (!isRecord(value) || !isLaneId(value.lane_id) ||
      (value.raw_key_kind !== "matched_token_count" &&
        value.raw_key_kind !== "bm25_raw_rank") ||
      (value.source_priority !== 0 && value.source_priority !== 1 &&
        value.source_priority !== 2) ||
      value.applicability_source !== "memory_fts_lane" ||
      !Number.isInteger(value.list_n) || Number(value.list_n) < 0 ||
      !Number.isInteger(value.requested_limit) || Number(value.requested_limit) < 0 ||
      !isListStatus(value.status) ||
      !Array.isArray(value.rows) || !isDenseArray(value.rows)) {
    throw new TypeError("lexical bound lane is invalid");
  }
  const rows = Object.freeze(value.rows.map(freezeLaneRow));
  const listN = Number(value.list_n);
  const requestedLimit = Number(value.requested_limit);
  if (listN !== rows.length || value.status !== expectedStatus(listN, requestedLimit)) {
    throw new TypeError("lexical bound lane closure is inconsistent");
  }
  const universe = freezeLaneUniverse(value.evaluated_universe, value.lane_id);
  return Object.freeze({
    lane_id: value.lane_id,
    raw_key_kind: value.raw_key_kind,
    source_priority: value.source_priority,
    applicability_source: "memory_fts_lane",
    list_n: listN,
    requested_limit: requestedLimit,
    status: value.status,
    rows,
    unseen_upper_bound: freezeFrontier(
      value.unseen_upper_bound, value.raw_key_kind, value.status, rows
    ),
    ...(universe === undefined ? {} : { evaluated_universe: universe })
  });
}

function freezeFrontier(
  value: unknown,
  kind: LexicalBoundRawKeyKind,
  status: LexicalBoundListStatus,
  rows: readonly LexicalBoundLaneRow[]
): LexicalUnseenFrontier {
  if (status === "empty" || status === "complete") {
    if (value !== 0) throw new TypeError("lexical bound closed frontier must be zero");
    return 0;
  }
  const monotone = lexicalRankingKeysAreMonotone(rows, kind);
  if (isUnavailable(value) && value.reason === "producer_order_not_monotone") {
    if (monotone) throw new TypeError("lexical bound truncated frontier hid a proved bound");
    return Object.freeze({
      status: "unavailable" as const,
      reason: "producer_order_not_monotone" as const
    });
  }
  const last = rows.at(-1)?.grouped_ordinal;
  if (!monotone || last === undefined || value !== last) {
    throw new TypeError("lexical bound truncated frontier is not a safe bound");
  }
  return last;
}

function freezeLaneRow(value: unknown): LexicalBoundLaneRow {
  if (!isRecord(value) || typeof value.candidate_key !== "string" ||
      value.candidate_key.trim().length === 0 ||
      !Number.isFinite(value.raw_group_key) ||
      !Number.isInteger(value.lane_index) || Number(value.lane_index) < 0 ||
      !Number.isFinite(value.grouped_ordinal) ||
      value.observation_state !== "observed") {
    throw new TypeError("lexical bound lane row is invalid");
  }
  return Object.freeze({
    candidate_key: value.candidate_key,
    raw_group_key: Number(value.raw_group_key),
    lane_index: Number(value.lane_index),
    grouped_ordinal: Number(value.grouped_ordinal),
    observation_state: "observed"
  });
}

function freezeCandidate(value: unknown): LexicalBoundCandidateProvenance {
  if (!isRecord(value) || typeof value.candidate_key !== "string" ||
      value.candidate_key.trim().length === 0 ||
      !Array.isArray(value.lane_hits) || !isDenseArray(value.lane_hits) ||
      typeof value.admitted !== "boolean" ||
      (value.chosen_lane_id !== null && !isLaneId(value.chosen_lane_id)) ||
      (value.chosen_normalized_rank !== null &&
        !unitInterval(value.chosen_normalized_rank)) ||
      (value.post_merge_index !== null &&
        (!Number.isInteger(value.post_merge_index) ||
          Number(value.post_merge_index) < 0)) ||
      !Array.isArray(value.discarded_lane_ids) ||
      !isDenseArray(value.discarded_lane_ids) ||
      !value.discarded_lane_ids.every(isLaneId)) {
    throw new TypeError("lexical bound candidate provenance is invalid");
  }
  return Object.freeze({
    candidate_key: value.candidate_key,
    lane_hits: Object.freeze(value.lane_hits.map(freezeLaneHit)),
    admitted: value.admitted,
    chosen_lane_id: value.chosen_lane_id,
    chosen_normalized_rank: value.chosen_normalized_rank,
    post_merge_index: value.post_merge_index === null
      ? null
      : Number(value.post_merge_index),
    discarded_lane_ids: Object.freeze(value.discarded_lane_ids.filter(isLaneId))
  });
}

function freezeLaneHit(value: unknown): LexicalBoundLaneHit {
  if (!isRecord(value) || !isLaneId(value.lane_id) ||
      !Number.isFinite(value.raw_group_key) ||
      !Number.isFinite(value.grouped_ordinal) ||
      !Number.isInteger(value.lane_index) || Number(value.lane_index) < 0) {
    throw new TypeError("lexical bound lane hit is invalid");
  }
  return Object.freeze({
    lane_id: value.lane_id,
    raw_group_key: Number(value.raw_group_key),
    grouped_ordinal: Number(value.grouped_ordinal),
    lane_index: Number(value.lane_index)
  });
}

function freezePostMerge(value: unknown): LexicalBoundPostMergeRow {
  if (!isRecord(value) || typeof value.candidate_key !== "string" ||
      value.candidate_key.trim().length === 0 ||
      !unitInterval(value.normalized_rank) ||
      (value.trigram_rank !== undefined && !unitInterval(value.trigram_rank)) ||
      (value.object_key_rank !== undefined && !unitInterval(value.object_key_rank))) {
    throw new TypeError("lexical bound post-merge row is invalid");
  }
  return Object.freeze({
    candidate_key: value.candidate_key,
    normalized_rank: value.normalized_rank,
    ...(value.trigram_rank === undefined ? {} : { trigram_rank: value.trigram_rank }),
    ...(value.object_key_rank === undefined ? {} : { object_key_rank: value.object_key_rank })
  });
}

function expectedStatus(listN: number, limit: number): LexicalBoundListStatus {
  if (listN === 0) return "empty";
  return listN >= limit ? "truncated" : "complete";
}

function isLaneId(value: unknown): value is LexicalBoundLaneId {
  return value === "exact" || value === "porter" || value === "trigram" ||
    value === "object_key_porter" || value === "object_key_trigram";
}

function isListStatus(value: unknown): value is LexicalBoundListStatus {
  return value === "empty" || value === "complete" || value === "truncated";
}

function isUnavailable(
  value: unknown
): value is Readonly<{ readonly status: "unavailable"; readonly reason: string }> {
  return isRecord(value) && value.status === "unavailable" &&
    typeof value.reason === "string" && value.reason.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDenseArray(value: readonly unknown[]): boolean {
  for (let index = 0; index < value.length; index += 1) {
    if (!(index in value)) return false;
  }
  return true;
}

function unitInterval(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}
