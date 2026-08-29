import type {
  KeywordLexicalMergeCapture,
  KeywordSearchFieldResult
} from "../../runtime/recall-service-types.js";
import type {
  LexicalBoundProducerReceipt
} from "../../runtime/recall-search-port-types.js";
import { freezeLexicalBoundProducerReceipt } from
  "../../runtime/diagnostics/lexical-bound-proof.js";
import {
  digestRecallFieldIdentity,
  type RecallFieldDigest
} from "../field-identity.js";
import { verifyLexicalIntervalProducerReplay } from
  "./lexical-interval-producer-replay.js";

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
  if (receipt.normal_matches_digest !== digestProducerPostMerge(receipt.producer_receipt)) {
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
  verifyLexicalIntervalProducerReplay(capture, producerReceipt);
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

function digestNormalMatches(
  matches: Readonly<KeywordSearchFieldResult>["matches"]
): RecallFieldDigest {
  return digestRecallFieldIdentity([...matches].map((match) => Object.freeze({
    candidate_key: match.object_id,
    normalized_rank: match.normalized_rank,
    trigram_rank: match.trigram_rank ?? null,
    object_key_rank: match.object_key_rank ?? null
  })));
}

function digestProducerPostMerge(
  receipt: Readonly<LexicalBoundProducerReceipt>
): RecallFieldDigest {
  return digestRecallFieldIdentity(receipt.post_merge.map((row) => Object.freeze({
    candidate_key: row.candidate_key,
    normalized_rank: row.normalized_rank,
    trigram_rank: row.trigram_rank ?? null,
    object_key_rank: row.object_key_rank ?? null
  })));
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
