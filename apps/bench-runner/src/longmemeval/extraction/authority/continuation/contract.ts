import {
  assertExtractionPreservedValidClosure,
  type ExtractionPreservedValidClosure
} from "../repair/preserved-valid-closure.js";

export interface SameRootExtractionContinuation {
  readonly schema_version: 1 | 2 | 3 | 4;
  readonly kind: "same-root-settled-predecessor";
  readonly mode?: "revision_successor" | "output_token_cap_renewal" |
    "transport_successor";
  readonly successor_revision: string;
  readonly starting_manifest_sha256: string;
  readonly predecessor_transport_authority?: ExtractionTransportAuthorityTerms;
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

export interface ExtractionTransportAuthorityTerms {
  readonly action: "fill";
  readonly target_selection_digest: string;
  readonly starting_missing: number;
  readonly maximum_attempts: number;
  readonly successful_shard_ceiling: number;
  readonly max_concurrency: number;
  readonly max_output_tokens: number;
  readonly output_token_field: "max_tokens" | "max_completion_tokens";
  readonly disk_floor_bytes: number;
  readonly no_progress_timeout_ms: number;
  readonly input_usd_per_million: number;
  readonly output_usd_per_million: number;
  readonly maximum_input_tokens_per_attempt: number;
}

export function sameRootContinuationMode(
  continuation: SameRootExtractionContinuation
): "revision_successor" | "output_token_cap_renewal" | "transport_successor" {
  return continuation.schema_version >= 3
    ? continuation.mode!
    : "revision_successor";
}

export function assertSameRootExtractionContinuation(
  value: unknown
): asserts value is SameRootExtractionContinuation {
  if (!isRecord(value) ||
      (value.schema_version !== 1 && value.schema_version !== 2 &&
       value.schema_version !== 3 && value.schema_version !== 4) ||
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
  if (value.schema_version >= 3 &&
      ((value.mode !== "revision_successor" && value.mode !== "output_token_cap_renewal" &&
        (value.schema_version !== 4 || value.mode !== "transport_successor")) ||
       !isTransportAuthorityTerms(value.predecessor_transport_authority))) {
    throw invalidContinuation();
  }
  assertExtractionPreservedValidClosure(value.preserved_valid_closure);
  if (value.preserved_valid_closure.shard_count !== predecessor.successful_shards) {
    throw invalidContinuation();
  }
}

function isTransportAuthorityTerms(value: unknown): value is ExtractionTransportAuthorityTerms {
  if (!isRecord(value) || value.action !== "fill" ||
      !isDigest(value.target_selection_digest) ||
      (value.output_token_field !== "max_tokens" &&
       value.output_token_field !== "max_completion_tokens")) return false;
  return [
    value.starting_missing,
    value.maximum_attempts,
    value.successful_shard_ceiling,
    value.max_concurrency,
    value.max_output_tokens,
    value.disk_floor_bytes,
    value.no_progress_timeout_ms,
    value.maximum_input_tokens_per_attempt
  ].every(isNonnegativeInteger) &&
    typeof value.input_usd_per_million === "number" &&
    Number.isFinite(value.input_usd_per_million) && value.input_usd_per_million >= 0 &&
    typeof value.output_usd_per_million === "number" &&
    Number.isFinite(value.output_usd_per_million) && value.output_usd_per_million >= 0;
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
