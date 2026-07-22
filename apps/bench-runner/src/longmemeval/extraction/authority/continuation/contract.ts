import {
  assertExtractionPreservedValidClosure,
  type ExtractionPreservedValidClosure
} from "../repair/preserved-valid-closure.js";

export interface SameRootExtractionContinuation {
  readonly schema_version: 1 | 2;
  readonly kind: "same-root-settled-predecessor";
  readonly successor_revision: string;
  readonly starting_manifest_sha256: string;
  readonly predecessor: {
    readonly receipt_digest: string;
    readonly lineage_digest: string;
    readonly ledger_sha256: string;
    readonly ledger_raw_sha256?: string;
    readonly attempts_consumed: number;
    readonly maximum_attempts: number;
    readonly remaining_attempts: number;
    readonly successful_shards: number;
    readonly successful_shard_ceiling: number;
    readonly remaining_successful_shards: number;
  };
  readonly preserved_valid_closure: ExtractionPreservedValidClosure;
}

export function assertSameRootExtractionContinuation(
  value: unknown
): asserts value is SameRootExtractionContinuation {
  if (!isRecord(value) || (value.schema_version !== 1 && value.schema_version !== 2) ||
      value.kind !== "same-root-settled-predecessor" ||
      typeof value.successor_revision !== "string" || value.successor_revision.length === 0 ||
      !isDigest(value.starting_manifest_sha256) || !isRecord(value.predecessor)) {
    throw invalidContinuation();
  }
  const predecessor = value.predecessor;
  if (!isDigest(predecessor.receipt_digest) || !isDigest(predecessor.lineage_digest) ||
      !isDigest(predecessor.ledger_sha256) ||
      (value.schema_version === 2 && !isDigest(predecessor.ledger_raw_sha256)) ||
      !isNonnegativeInteger(predecessor.attempts_consumed) ||
      !isNonnegativeInteger(predecessor.maximum_attempts) ||
      !isNonnegativeInteger(predecessor.remaining_attempts) ||
      !isNonnegativeInteger(predecessor.successful_shards) ||
      !isNonnegativeInteger(predecessor.successful_shard_ceiling) ||
      !isNonnegativeInteger(predecessor.remaining_successful_shards) ||
      predecessor.maximum_attempts - predecessor.attempts_consumed !==
        predecessor.remaining_attempts ||
      predecessor.successful_shard_ceiling - predecessor.successful_shards !==
        predecessor.remaining_successful_shards) {
    throw invalidContinuation();
  }
  assertExtractionPreservedValidClosure(value.preserved_valid_closure);
  if (value.preserved_valid_closure.shard_count !== predecessor.successful_shards) {
    throw invalidContinuation();
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDigest(value: unknown): value is string {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function isNonnegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function invalidContinuation(): Error {
  return new Error("same-root extraction continuation receipt is invalid");
}
