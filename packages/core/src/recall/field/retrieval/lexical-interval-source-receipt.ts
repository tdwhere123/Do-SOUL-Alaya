import type {
  KeywordLexicalMergeCapture,
  KeywordSearchFieldResult
} from "../../runtime/recall-service-types.js";
import type {
  LexicalBoundCandidateProvenance,
  LexicalBoundLaneCapture,
  LexicalBoundLaneHit,
  LexicalBoundProducerReceipt
} from "../../runtime/recall-search-port-types.js";
import { freezeLexicalBoundProducerReceipt } from
  "../../runtime/diagnostics/lexical-bound-proof.js";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../field-identity.js";

export const LEXICAL_INTERVAL_SOURCE_RECEIPT_ID =
  "alaya.recall.lexical-interval-source.v1";
export const LEXICAL_INTERVAL_SOURCE_ADAPTER_ID =
  "alaya.recall.lexical-interval.normal-field-adapter.v1";

type LexicalFieldPrefix = "lexical_relaxed" | "lexical_expanded";
const LEXICAL_LANES = Object.freeze([
  "exact", "porter", "object_key_porter", "trigram", "object_key_trigram"
] as const);
const LEXICAL_LANE_PRIORITY = Object.freeze({
  exact: 0,
  porter: 1,
  object_key_porter: 1,
  trigram: 2,
  object_key_trigram: 2
} as const);

type SourceIdentity = Readonly<{
  readonly workspace_id: string;
  readonly request_digest: RecallFieldDigest;
  readonly snapshot_digest: RecallFieldDigest;
  readonly field_prefix: LexicalFieldPrefix;
  readonly candidate_key_domain: "memory_object_id";
  readonly requested_depth: number;
}>;

export type LexicalIntervalSourceReceiptCapturedV1 = Readonly<SourceIdentity & {
  readonly schema_version: 1;
  readonly receipt_id: typeof LEXICAL_INTERVAL_SOURCE_RECEIPT_ID;
  readonly adapter_id: typeof LEXICAL_INTERVAL_SOURCE_ADAPTER_ID;
  readonly status: "captured";
  readonly capture: Readonly<KeywordLexicalMergeCapture>;
  readonly producer_receipt: Readonly<LexicalBoundProducerReceipt>;
  readonly normal_matches_digest: RecallFieldDigest;
  readonly receipt_digest: RecallFieldDigest;
}>;

export type LexicalIntervalSourceReceiptUnavailableV1 = Readonly<SourceIdentity & {
  readonly schema_version: 1;
  readonly receipt_id: typeof LEXICAL_INTERVAL_SOURCE_RECEIPT_ID;
  readonly adapter_id: typeof LEXICAL_INTERVAL_SOURCE_ADAPTER_ID;
  readonly status: "unavailable";
  readonly capture: null;
  readonly producer_receipt: null;
  readonly reason:
    | "normal_merge_capture_absent"
    | "producer_lane_observations_absent";
  readonly receipt_digest: RecallFieldDigest;
}>;

export type LexicalIntervalSourceReceiptV1 =
  | LexicalIntervalSourceReceiptCapturedV1
  | LexicalIntervalSourceReceiptUnavailableV1;

export function createLexicalIntervalSourceReceiptIntegrityV1(input: Readonly<{
  readonly workspace_id: string;
  readonly request_digest: RecallFieldDigest;
  readonly snapshot_digest: RecallFieldDigest;
  readonly field_prefix: LexicalFieldPrefix;
  readonly requested_depth: number;
  readonly result: Readonly<KeywordSearchFieldResult>;
}>): LexicalIntervalSourceReceiptV1 {
  const identity = Object.freeze({
    workspace_id: input.workspace_id,
    request_digest: input.request_digest,
    snapshot_digest: input.snapshot_digest,
    field_prefix: input.field_prefix,
    candidate_key_domain: "memory_object_id" as const,
    requested_depth: input.requested_depth
  });
  const capture = input.result.lexical_raw_rank;
  const producerReceipt = input.result.lexical_raw_rank_receipt;
  const unavailableReason = capture === undefined
    ? "normal_merge_capture_absent" as const
    : producerReceipt === undefined
      ? "producer_lane_observations_absent" as const
      : null;
  const body = unavailableReason !== null
    ? Object.freeze({
      schema_version: 1 as const,
      receipt_id: LEXICAL_INTERVAL_SOURCE_RECEIPT_ID,
      adapter_id: LEXICAL_INTERVAL_SOURCE_ADAPTER_ID,
      status: "unavailable" as const,
      ...identity,
      capture: null,
      producer_receipt: null,
      reason: unavailableReason
    })
    : Object.freeze({
      schema_version: 1 as const,
      receipt_id: LEXICAL_INTERVAL_SOURCE_RECEIPT_ID,
      adapter_id: LEXICAL_INTERVAL_SOURCE_ADAPTER_ID,
      status: "captured" as const,
      ...identity,
      capture: capture!,
      producer_receipt: producerReceipt!,
      normal_matches_digest: digestNormalMatches(input.result.matches)
    });
  return Object.freeze({
    ...body,
    receipt_digest: digestRecallFieldIdentity(body)
  });
}

export function verifyLexicalIntervalSourceReceiptIntegrityV1(
  receipt: LexicalIntervalSourceReceiptV1
): void {
  verifyCommon(receipt);
  const { receipt_digest: _ignored, ...body } = receipt;
  if (receipt.receipt_digest !== digestRecallFieldIdentity(body)) {
    throw new TypeError("lexical interval source receipt digest is invalid");
  }
  if (receipt.status === "unavailable") {
    if (receipt.capture !== null || receipt.producer_receipt !== null ||
        (receipt.reason !== "normal_merge_capture_absent" &&
          receipt.reason !== "producer_lane_observations_absent")) {
      throw new TypeError("lexical interval unavailable source is invalid");
    }
    return;
  }
  verifyCapture(receipt.capture, receipt.producer_receipt, receipt.requested_depth);
  if (receipt.normal_matches_digest !== digestAdmittedCapture(receipt.capture) ||
      receipt.normal_matches_digest !== digestProducerPostMerge(receipt.producer_receipt)) {
    throw new TypeError("lexical interval source does not match the normal field result");
  }
}

function verifyCommon(receipt: LexicalIntervalSourceReceiptV1): void {
  if (receipt.schema_version !== 1 ||
      receipt.receipt_id !== LEXICAL_INTERVAL_SOURCE_RECEIPT_ID ||
      receipt.adapter_id !== LEXICAL_INTERVAL_SOURCE_ADAPTER_ID ||
      receipt.workspace_id.trim().length === 0 ||
      !isDigest(receipt.request_digest) || !isDigest(receipt.snapshot_digest) ||
      (receipt.field_prefix !== "lexical_relaxed" &&
        receipt.field_prefix !== "lexical_expanded") ||
      receipt.candidate_key_domain !== "memory_object_id" ||
      !Number.isSafeInteger(receipt.requested_depth) || receipt.requested_depth <= 0 ||
      !isDigest(receipt.receipt_digest)) {
    throw new TypeError("lexical interval source receipt identity is invalid");
  }
}

function verifyCapture(
  capture: Readonly<KeywordLexicalMergeCapture>,
  producerReceipt: Readonly<LexicalBoundProducerReceipt>,
  requestedDepth: number
): void {
  verifyCaptureIdentity(capture, producerReceipt, requestedDepth);
  const lanes = verifiedLaneMaps(capture, producerReceipt);
  verifyCandidateProjections(capture, producerReceipt, lanes);
}

function verifyCaptureIdentity(
  capture: Readonly<KeywordLexicalMergeCapture>,
  producerReceipt: Readonly<LexicalBoundProducerReceipt>,
  requestedDepth: number
): void {
  const frozenProducer = freezeLexicalBoundProducerReceipt(producerReceipt);
  if (frozenProducer === undefined ||
      digestRecallFieldIdentity(frozenProducer) !== digestRecallFieldIdentity(producerReceipt)) {
    throw new TypeError("lexical interval producer receipt is invalid");
  }
  if (capture.query_run_id.trim().length === 0 ||
      !Number.isSafeInteger(capture.merge_limit) || capture.merge_limit !== requestedDepth ||
      producerReceipt.query_run_id !== capture.query_run_id ||
      producerReceipt.merge_limit !== capture.merge_limit ||
      !dense(capture.lanes) || !dense(capture.candidates)) {
    throw new TypeError("lexical interval source capture is invalid");
  }
}

function verifiedLaneMaps(
  capture: Readonly<KeywordLexicalMergeCapture>,
  producerReceipt: Readonly<LexicalBoundProducerReceipt>
) {
  const lanes = new Map(capture.lanes.map((lane) => [lane.lane_id, lane]));
  if (!canonicalLaneOrder(capture.lanes) || lanes.size !== LEXICAL_LANES.length) {
    throw new TypeError("lexical interval source lane set is invalid");
  }
  const producerLanes = new Map(producerReceipt.lanes.map((lane) => [lane.lane_id, lane]));
  if (!canonicalLaneOrder(producerReceipt.lanes) ||
      producerLanes.size !== LEXICAL_LANES.length) {
    throw new TypeError("lexical interval producer lane set is invalid");
  }
  for (const lane of capture.lanes) {
    verifyLane(lane, capture.merge_limit);
    verifyLaneProjection(lane, producerLanes.get(lane.lane_id)!, capture.merge_limit);
  }
  return Object.freeze({ lanes, producerLanes });
}

function verifyCandidateProjections(
  capture: Readonly<KeywordLexicalMergeCapture>,
  producerReceipt: Readonly<LexicalBoundProducerReceipt>,
  laneMaps: ReturnType<typeof verifiedLaneMaps>
): void {
  const producerCandidates = new Map(
    producerReceipt.candidates.map((candidate) => [candidate.candidate_key, candidate])
  );
  if (producerCandidates.size !== capture.candidates.length) {
    throw new TypeError("lexical interval producer candidate set is invalid");
  }
  const keys = new Set<string>();
  for (const candidate of capture.candidates) {
    if (candidate.candidate_key.trim().length === 0 || keys.has(candidate.candidate_key)) {
      throw new TypeError("lexical interval source candidate identity is invalid");
    }
    keys.add(candidate.candidate_key);
    const producerCandidate = producerCandidates.get(candidate.candidate_key);
    if (producerCandidate === undefined || !sameCandidateProjection(candidate, producerCandidate)) {
      throw new TypeError("lexical interval producer candidate projection is invalid");
    }
    verifyCandidateObservation(candidate, producerCandidate, laneMaps);
  }
  verifyProducerPostMerge(producerReceipt);
}

function verifyCandidateObservation(
  candidate: KeywordLexicalMergeCapture["candidates"][number],
  producerCandidate: Readonly<LexicalBoundCandidateProvenance>,
  laneMaps: ReturnType<typeof verifiedLaneMaps>
): void {
  verifyProducerCandidateRows(producerCandidate, laneMaps.producerLanes);
  const hasLane = candidate.chosen_lane_id !== null;
  const hasRank = candidate.chosen_normalized_rank !== null;
  if (hasLane !== hasRank || (candidate.admitted && !hasLane)) {
    throw new TypeError("lexical interval source candidate observation is incomplete");
  }
  if (!hasLane) return;
  const lane = laneMaps.lanes.get(candidate.chosen_lane_id!);
  const rank = candidate.chosen_normalized_rank!;
  if (lane === undefined || lane.status === "empty" ||
      !Number.isFinite(rank) || rank <= 0 || rank > 1) {
    throw new TypeError("lexical interval source candidate observation is invalid");
  }
  verifyProducerObservation(
    laneMaps.producerLanes.get(candidate.chosen_lane_id!)!, producerCandidate, rank
  );
}

function verifyProducerCandidateRows(
  candidate: Readonly<LexicalBoundCandidateProvenance>,
  lanes: ReturnType<typeof verifiedLaneMaps>["producerLanes"]
): void {
  const observed = [...lanes.values()].flatMap((lane) => lane.rows
    .filter((row) => row.candidate_key === candidate.candidate_key)
    .map((row) => Object.freeze({ lane, row })));
  const expectedHits = new Set(observed.map(({ lane, row }) => hitKey({
    lane_id: lane.lane_id,
    raw_group_key: row.raw_group_key,
    grouped_ordinal: row.grouped_ordinal,
    lane_index: row.lane_index
  })));
  const actualHits = new Set(candidate.lane_hits.map(hitKey));
  if (expectedHits.size !== observed.length || actualHits.size !== candidate.lane_hits.length ||
      expectedHits.size !== actualHits.size ||
      [...expectedHits].some((key) => !actualHits.has(key))) {
    throw new TypeError("lexical interval producer candidate lane hits are invalid");
  }
  const winner = observed.reduce<(typeof observed)[number] | undefined>(selectWinner, undefined);
  if (winner === undefined || candidate.chosen_lane_id !== winner.lane.lane_id ||
      candidate.chosen_normalized_rank !== winner.row.grouped_ordinal) {
    throw new TypeError("lexical interval producer candidate winner is invalid");
  }
}

function selectWinner(
  current: ProducerObservedRow | undefined,
  next: ProducerObservedRow
) {
  if (current === undefined || next.row.grouped_ordinal > current.row.grouped_ordinal ||
      (next.row.grouped_ordinal === current.row.grouped_ordinal &&
        next.lane.source_priority < current.lane.source_priority)) return next;
  return current;
}

type ProducerObservedRow = Readonly<{
  readonly lane: LexicalBoundLaneCapture;
  readonly row: LexicalBoundLaneCapture["rows"][number];
}>;

function hitKey(hit: Readonly<LexicalBoundLaneHit>): string {
  return JSON.stringify([
    hit.lane_id, hit.raw_group_key, hit.grouped_ordinal, hit.lane_index
  ]);
}

function verifyLaneProjection(
  lane: KeywordLexicalMergeCapture["lanes"][number],
  producerLane: Readonly<LexicalBoundLaneCapture>,
  mergeLimit: number
): void {
  if (producerLane.raw_key_kind !== lane.raw_key_kind ||
      producerLane.list_n !== lane.list_n || producerLane.status !== lane.status ||
      producerLane.source_priority !== LEXICAL_LANE_PRIORITY[lane.lane_id] ||
      producerLane.requested_limit !== mergeLimit ||
      producerLane.list_n !== producerLane.rows.length) {
    throw new TypeError("lexical interval producer lane projection is invalid");
  }
}

function canonicalLaneOrder(
  lanes: readonly Readonly<{ readonly lane_id: KeywordLexicalMergeCapture["lanes"][number]["lane_id"] }>[]
): boolean {
  return lanes.length === LEXICAL_LANES.length &&
    lanes.every((lane, index) => lane.lane_id === LEXICAL_LANES[index]);
}

function sameCandidateProjection(
  candidate: KeywordLexicalMergeCapture["candidates"][number],
  producerCandidate: Readonly<LexicalBoundCandidateProvenance>
): boolean {
  return producerCandidate.admitted === candidate.admitted &&
    producerCandidate.chosen_lane_id === candidate.chosen_lane_id &&
    producerCandidate.chosen_normalized_rank === candidate.chosen_normalized_rank;
}

function verifyProducerObservation(
  lane: Readonly<LexicalBoundLaneCapture>,
  candidate: Readonly<LexicalBoundCandidateProvenance>,
  normalizedRank: number
): void {
  const row = lane.rows.find((item) =>
    item.candidate_key === candidate.candidate_key &&
    item.grouped_ordinal === normalizedRank
  );
  const hit = candidate.lane_hits.find((item) =>
    item.lane_id === lane.lane_id && item.grouped_ordinal === normalizedRank &&
    item.lane_index === row?.lane_index && item.raw_group_key === row?.raw_group_key
  );
  if (row === undefined || hit === undefined) {
    throw new TypeError("lexical interval producer lane observation is invalid");
  }
}

function verifyLane(
  lane: KeywordLexicalMergeCapture["lanes"][number],
  mergeLimit: number
): void {
  const expectedKind = lane.lane_id === "exact"
    ? "matched_token_count" : "bm25_raw_rank";
  if (lane.raw_key_kind !== expectedKind || !Number.isSafeInteger(lane.list_n) ||
      lane.list_n < 0 || lane.list_n > mergeLimit ||
      (lane.status === "empty") !== (lane.list_n === 0) ||
      (lane.status === "truncated" && lane.list_n !== mergeLimit)) {
    throw new TypeError("lexical interval source lane is invalid");
  }
}

function digestNormalMatches(
  matches: Readonly<KeywordSearchFieldResult>["matches"]
): RecallFieldDigest {
  return digestRecallFieldIdentity([...matches].map((match) => Object.freeze({
    candidate_key: match.object_id,
    normalized_rank: match.normalized_rank
  })).sort(compareObservedMatches));
}

function digestAdmittedCapture(
  capture: Readonly<KeywordLexicalMergeCapture>
): RecallFieldDigest {
  return digestRecallFieldIdentity(capture.candidates.filter((candidate) =>
    candidate.admitted
  ).map((candidate) => Object.freeze({
    candidate_key: candidate.candidate_key,
    normalized_rank: candidate.chosen_normalized_rank
  })).sort(compareObservedMatches));
}

function verifyProducerPostMerge(receipt: Readonly<LexicalBoundProducerReceipt>): void {
  const keys = new Set<string>();
  for (const [index, row] of receipt.post_merge.entries()) {
    if (keys.has(row.candidate_key)) {
      throw new TypeError("lexical interval producer post-merge set is invalid");
    }
    keys.add(row.candidate_key);
    const candidate = receipt.candidates.find((item) => item.candidate_key === row.candidate_key);
    if (candidate?.admitted !== true || candidate.post_merge_index !== index ||
        candidate.chosen_normalized_rank !== row.normalized_rank) {
      throw new TypeError("lexical interval producer post-merge admission is invalid");
    }
  }
  for (const candidate of receipt.candidates) {
    const admitted = candidate.post_merge_index !== null;
    if (candidate.admitted !== admitted || (admitted && !keys.has(candidate.candidate_key))) {
      throw new TypeError("lexical interval producer candidate admission is invalid");
    }
  }
}

function digestProducerPostMerge(
  receipt: Readonly<LexicalBoundProducerReceipt>
): RecallFieldDigest {
  return digestRecallFieldIdentity(receipt.post_merge.map((row) => Object.freeze({
    candidate_key: row.candidate_key,
    normalized_rank: row.normalized_rank
  })).sort(compareObservedMatches));
}

function compareObservedMatches(
  left: Readonly<{ readonly candidate_key: string; readonly normalized_rank: number | null }>,
  right: Readonly<{ readonly candidate_key: string; readonly normalized_rank: number | null }>
): number {
  return left.candidate_key.localeCompare(right.candidate_key);
}

function dense<T>(values: readonly T[]): boolean {
  for (let index = 0; index < values.length; index += 1) {
    if (!(index in values)) return false;
  }
  return true;
}

function isDigest(value: unknown): value is RecallFieldDigest {
  return typeof value === "string" && /^sha256:[0-9a-f]{64}$/u.test(value);
}
