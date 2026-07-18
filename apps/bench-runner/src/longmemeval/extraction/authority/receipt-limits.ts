import { computeExtractionAttemptCeiling } from "./attempt-ledger.js";

export const EXTRACTION_AUTHORITY_NO_PROGRESS_TIMEOUT_MS: 1_800_000 = 1_800_000;
const DEFAULT_MAX_CONCURRENCY = 32;
const MILLION = 1_000_000;

export interface ExtractionAuthorityReceiptLimits {
  readonly starting_missing: number;
  readonly maximum_attempts: number;
  readonly successful_shard_ceiling: number;
  readonly max_concurrency: number;
  readonly max_output_tokens: number;
  readonly output_token_field: "max_tokens" | "max_completion_tokens";
  readonly disk_floor_bytes: number;
  readonly no_progress_timeout_ms: typeof EXTRACTION_AUTHORITY_NO_PROGRESS_TIMEOUT_MS;
}

export interface ExtractionAuthorityReceiptPrice {
  readonly input_usd_per_million: number;
  readonly output_usd_per_million: number;
  readonly maximum_input_tokens_per_attempt: number;
  readonly estimated_upper_usd: number;
}

export interface ExtractionAuthorityReceiptLimitInput {
  readonly action: "probe" | "fill";
  readonly observation: { readonly inventory: { readonly missingTurns: number } };
  readonly outputTokenCap: {
    readonly field: ExtractionAuthorityReceiptLimits["output_token_field"];
    readonly value: number;
  };
  readonly diskFloorBytes: number;
  readonly maxConcurrency?: number;
  readonly cumulativeLimits?: {
    readonly startingMissing: number;
    readonly maximumAttempts: number;
    readonly successfulShardCeiling: number;
  };
}

export interface ExtractionAuthorityPriceEstimate {
  readonly inputUsdPerMillion: number;
  readonly outputUsdPerMillion: number;
  readonly maximumInputTokensPerAttempt: number;
}

export function resolveExtractionAuthorityReceiptLimits(
  input: ExtractionAuthorityReceiptLimitInput
): ExtractionAuthorityReceiptLimits {
  const carried = input.cumulativeLimits;
  const missing = carried?.startingMissing ?? input.observation.inventory.missingTurns;
  const expected = expectedExtractionAuthorityLimits(input.action, missing);
  if (carried !== undefined && (carried.maximumAttempts !== expected.maximumAttempts ||
      carried.successfulShardCeiling !== expected.successfulShardCeiling)) {
    throw new Error("extraction authority cumulative limits are not derivable from its starting inventory");
  }
  assertConcurrency(input.maxConcurrency);
  assertOutputTokenCap(input.outputTokenCap.value);
  assertDiskFloor(input.diskFloorBytes);
  return Object.freeze({
    starting_missing: missing,
    maximum_attempts: carried?.maximumAttempts ?? expected.maximumAttempts,
    successful_shard_ceiling: carried?.successfulShardCeiling ?? expected.successfulShardCeiling,
    max_concurrency: input.maxConcurrency ?? DEFAULT_MAX_CONCURRENCY,
    max_output_tokens: input.outputTokenCap.value,
    output_token_field: input.outputTokenCap.field,
    disk_floor_bytes: input.diskFloorBytes,
    no_progress_timeout_ms: EXTRACTION_AUTHORITY_NO_PROGRESS_TIMEOUT_MS
  });
}

export function resolveExtractionAuthorityReceiptPrice(
  input: ExtractionAuthorityPriceEstimate,
  limits: ExtractionAuthorityReceiptLimits
): ExtractionAuthorityReceiptPrice {
  assertNonNegativeFinite(input.inputUsdPerMillion, "input price");
  assertNonNegativeFinite(input.outputUsdPerMillion, "output price");
  if (!Number.isSafeInteger(input.maximumInputTokensPerAttempt) ||
      input.maximumInputTokensPerAttempt < 0) {
    throw new Error("extraction authority maximum input tokens must be a non-negative integer");
  }
  const perAttempt = (
    input.maximumInputTokensPerAttempt * input.inputUsdPerMillion +
    limits.max_output_tokens * input.outputUsdPerMillion
  ) / MILLION;
  return Object.freeze({
    input_usd_per_million: input.inputUsdPerMillion,
    output_usd_per_million: input.outputUsdPerMillion,
    maximum_input_tokens_per_attempt: input.maximumInputTokensPerAttempt,
    estimated_upper_usd: perAttempt * limits.maximum_attempts
  });
}

export function expectedExtractionAuthorityLimits(
  action: "probe" | "fill",
  missing: number
): { readonly maximumAttempts: number; readonly successfulShardCeiling: number } {
  if (action === "probe") {
    if (missing < 1) throw new Error("extraction probe requires at least one missing shard");
    return { maximumAttempts: 1, successfulShardCeiling: 1 };
  }
  return {
    maximumAttempts: computeExtractionAttemptCeiling(missing),
    successfulShardCeiling: missing
  };
}

function assertConcurrency(raw: number | undefined): void {
  const value = raw ?? DEFAULT_MAX_CONCURRENCY;
  if (!Number.isSafeInteger(value) || value < 1 || value > DEFAULT_MAX_CONCURRENCY) {
    throw new Error(`extraction authority max concurrency must be 1-${DEFAULT_MAX_CONCURRENCY}`);
  }
}

function assertOutputTokenCap(value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error("extraction authority output token cap must be a positive integer");
  }
}

function assertDiskFloor(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error("extraction authority disk floor must be a non-negative safe integer");
  }
}

function assertNonNegativeFinite(value: number, name: string): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new Error(`extraction authority ${name} must be non-negative and finite`);
  }
}
