import type {
  KeywordLexicalMergeCapture,
  KeywordSearchFieldResult
} from "../../runtime/recall-service-types.js";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../field-identity.js";

export const LEXICAL_INTERVAL_SOURCE_RECEIPT_ID =
  "alaya.recall.lexical-interval-source.v1";
export const LEXICAL_INTERVAL_SOURCE_ADAPTER_ID =
  "alaya.recall.lexical-interval.normal-field-adapter.v1";

type LexicalFieldPrefix = "lexical_relaxed" | "lexical_expanded";

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
  readonly normal_matches_digest: RecallFieldDigest;
  readonly receipt_digest: RecallFieldDigest;
}>;

export type LexicalIntervalSourceReceiptUnavailableV1 = Readonly<SourceIdentity & {
  readonly schema_version: 1;
  readonly receipt_id: typeof LEXICAL_INTERVAL_SOURCE_RECEIPT_ID;
  readonly adapter_id: typeof LEXICAL_INTERVAL_SOURCE_ADAPTER_ID;
  readonly status: "unavailable";
  readonly capture: null;
  readonly reason: "normal_merge_capture_absent";
  readonly receipt_digest: RecallFieldDigest;
}>;

export type LexicalIntervalSourceReceiptV1 =
  | LexicalIntervalSourceReceiptCapturedV1
  | LexicalIntervalSourceReceiptUnavailableV1;

export function issueLexicalIntervalSourceReceiptV1(input: Readonly<{
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
  const body = capture === undefined
    ? Object.freeze({
      schema_version: 1 as const,
      receipt_id: LEXICAL_INTERVAL_SOURCE_RECEIPT_ID,
      adapter_id: LEXICAL_INTERVAL_SOURCE_ADAPTER_ID,
      status: "unavailable" as const,
      ...identity,
      capture: null,
      reason: "normal_merge_capture_absent" as const
    })
    : Object.freeze({
      schema_version: 1 as const,
      receipt_id: LEXICAL_INTERVAL_SOURCE_RECEIPT_ID,
      adapter_id: LEXICAL_INTERVAL_SOURCE_ADAPTER_ID,
      status: "captured" as const,
      ...identity,
      capture,
      normal_matches_digest: digestNormalMatches(input.result.matches)
    });
  return Object.freeze({
    ...body,
    receipt_digest: digestRecallFieldIdentity(body)
  });
}

export function verifyLexicalIntervalSourceReceiptV1(
  receipt: LexicalIntervalSourceReceiptV1
): void {
  verifyCommon(receipt);
  const { receipt_digest: _ignored, ...body } = receipt;
  if (receipt.receipt_digest !== digestRecallFieldIdentity(body)) {
    throw new TypeError("lexical interval source receipt digest is invalid");
  }
  if (receipt.status === "unavailable") {
    if (receipt.capture !== null || receipt.reason !== "normal_merge_capture_absent") {
      throw new TypeError("lexical interval unavailable source is invalid");
    }
    return;
  }
  verifyCapture(receipt.capture, receipt.requested_depth);
  if (receipt.normal_matches_digest !== digestAdmittedCapture(receipt.capture)) {
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
  requestedDepth: number
): void {
  if (capture.query_run_id.trim().length === 0 ||
      !Number.isSafeInteger(capture.merge_limit) || capture.merge_limit !== requestedDepth ||
      !dense(capture.lanes) || !dense(capture.candidates)) {
    throw new TypeError("lexical interval source capture is invalid");
  }
  const lanes = new Map(capture.lanes.map((lane) => [lane.lane_id, lane]));
  const expected = [
    "exact", "porter", "object_key_porter", "trigram", "object_key_trigram"
  ] as const;
  if (lanes.size !== expected.length || expected.some((lane) => !lanes.has(lane))) {
    throw new TypeError("lexical interval source lane set is invalid");
  }
  for (const lane of capture.lanes) verifyLane(lane, capture.merge_limit);
  const keys = new Set<string>();
  for (const candidate of capture.candidates) {
    if (candidate.candidate_key.trim().length === 0 || keys.has(candidate.candidate_key)) {
      throw new TypeError("lexical interval source candidate identity is invalid");
    }
    keys.add(candidate.candidate_key);
    const hasLane = candidate.chosen_lane_id !== null;
    const hasRank = candidate.chosen_normalized_rank !== null;
    if (hasLane !== hasRank || (candidate.admitted && !hasLane)) {
      throw new TypeError("lexical interval source candidate observation is incomplete");
    }
    if (!hasLane) continue;
    const lane = lanes.get(candidate.chosen_lane_id!);
    const rank = candidate.chosen_normalized_rank!;
    if (lane === undefined || lane.status === "empty" ||
        !Number.isFinite(rank) || rank <= 0 || rank > 1) {
      throw new TypeError("lexical interval source candidate observation is invalid");
    }
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
