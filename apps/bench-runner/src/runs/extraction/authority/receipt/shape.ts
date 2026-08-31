import {
  EXTRACTION_AUTHORITY_NO_PROGRESS_TIMEOUT_MS,
  expectedExtractionAuthorityLimits
} from "../receipt-limits.js";

export const LEGACY_RECEIPT_VERSION = 2;
export const PREVIOUS_RECEIPT_VERSION = 3;
export const PARTITIONLESS_RECEIPT_VERSION = 4;
export const CURRENT_RECEIPT_VERSION = 5;

export function hasExpectedExtractionAuthorityReceiptLimits(input: {
  readonly schemaVersion: 2 | 3 | 4 | 5;
  readonly action: "probe" | "fill";
  readonly startingMissing: number;
  readonly maximumAttempts: number;
  readonly successfulShardCeiling: number;
}): boolean {
  const expectedSuccesses = input.action === "probe" ? 1 : input.startingMissing;
  if (input.successfulShardCeiling !== expectedSuccesses) return false;
  if (input.schemaVersion === CURRENT_RECEIPT_VERSION) {
    return input.maximumAttempts === expectedExtractionAuthorityLimits(
      input.action, input.startingMissing
    ).maximumAttempts;
  }
  return legacyAttemptCeilings(input.schemaVersion, input.action, input.startingMissing)
    .includes(input.maximumAttempts);
}

function legacyAttemptCeilings(
  schemaVersion: 2 | 3 | 4,
  action: "probe" | "fill",
  startingMissing: number
): readonly number[] {
  if (action === "probe") return [1];
  const original = Math.ceil(startingMissing * 1.1);
  const fiveAttempt = startingMissing * 5;
  const candidates = schemaVersion === LEGACY_RECEIPT_VERSION
    ? [original]
    : schemaVersion === PREVIOUS_RECEIPT_VERSION
      ? [original, fiveAttempt]
      : [startingMissing * 4, fiveAttempt];
  return candidates.filter(Number.isSafeInteger);
}

export function isExtractionAuthorityReceiptLimits(value: unknown): boolean {
  if (!isObject(value)) return false;
  return isNonNegativeSafeInteger(value.starting_missing) &&
    isNonNegativeSafeInteger(value.maximum_attempts) &&
    isNonNegativeSafeInteger(value.successful_shard_ceiling) &&
    isNonNegativeSafeInteger(value.max_concurrency) &&
    isNonNegativeSafeInteger(value.max_output_tokens) &&
    (value.output_token_field === "max_tokens" ||
      value.output_token_field === "max_completion_tokens") &&
    isNonNegativeSafeInteger(value.disk_floor_bytes) &&
    value.no_progress_timeout_ms === EXTRACTION_AUTHORITY_NO_PROGRESS_TIMEOUT_MS;
}

export function isExtractionAuthorityReceiptPrice(value: unknown): boolean {
  return isObject(value) && typeof value.input_usd_per_million === "number" &&
    typeof value.output_usd_per_million === "number" &&
    isNonNegativeSafeInteger(value.maximum_input_tokens_per_attempt) &&
    typeof value.estimated_upper_usd === "number";
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
