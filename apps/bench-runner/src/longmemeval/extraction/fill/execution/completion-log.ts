import type { ExtractionAttemptLedgerSnapshot } from
  "../../authority/attempt-ledger.js";
import type { FillRetryTelemetry } from "../fill-stats.js";

export function renderFillCompletion(input: {
  readonly status: string;
  readonly cacheHits: number;
  readonly newlyExtracted: number;
  readonly failureCount: number;
  readonly intentionalSkippedTurns: number;
  readonly retryTelemetry: FillRetryTelemetry;
  readonly authorityTelemetry: ExtractionAttemptLedgerSnapshot | undefined;
  readonly completion: { readonly coverage: number; readonly validTurns: number };
}): string {
  return `[extraction-fill] done: status=${input.status} cache_hits=${input.cacheHits} ` +
    `newly_extracted=${input.newlyExtracted} failures=${input.failureCount} ` +
    `intentional_skips=${input.intentionalSkippedTurns} ` +
    `retry_successes=${input.retryTelemetry.retrySuccesses} ` +
    `rate_limit_retries=${input.retryTelemetry.rateLimitRetries} ` +
    `adaptive_backoffs=${input.retryTelemetry.adaptiveConcurrencyBackoffs} ` +
    `adaptive_backoff_ms=${input.retryTelemetry.adaptiveConcurrencyBackoffMs} ` +
    `terminal_max_retries=${input.retryTelemetry.terminalRetryClassifications.failure_max_retries} ` +
    `terminal_nonretryable_4xx=${input.retryTelemetry.terminalRetryClassifications.failure_non_retryable_4xx} ` +
    `terminal_timeouts=${input.retryTelemetry.terminalRetryClassifications.failure_timeout} ` +
    `${renderAuthorityTelemetry(input.authorityTelemetry)} ` +
    `coverage=${(input.completion.coverage * 100).toFixed(1)}% ` +
    `cached_turns=${input.completion.validTurns}`;
}

export function renderAuthorityTelemetry(
  telemetry: ExtractionAttemptLedgerSnapshot | undefined
): string {
  if (telemetry === undefined) return "authority=none";
  return `attempts=${telemetry.attempts}/${telemetry.maximumAttempts} ` +
    `successful_shards=${telemetry.successfulShards}/${telemetry.successfulShardCeiling} ` +
    `usage_input_tokens=${telemetry.telemetry.inputTokens} ` +
    `usage_output_tokens=${telemetry.telemetry.outputTokens} ` +
    `usage_total_tokens=${telemetry.telemetry.totalTokens} ` +
    `usage_unavailable=${telemetry.telemetry.usageUnavailableRequests} ` +
    `usage_unresolved=${telemetry.telemetry.unresolvedTransportAttempts} ` +
    `usage_unknown=${telemetry.telemetry.usageUnknownAttempts}`;
}
