import {
  EXTRACTION_HTTP_MAX_RETRY_JITTER_MS
} from "../../../compile-seed/http/garden-http-retry-policy.js";
import {
  EXTRACTION_OUTPUT_TOKEN_QUANTUM,
  EXTRACTION_REQUEST_TIMEOUT_MS
} from "../../../compile-seed/http/output-token-retry.js";
import {
  EXTRACTION_FILL_TRANSPORT_ATTEMPTS_PER_MISSING_SHARD
} from "../../authority/receipt-limits.js";

const PROVIDER_WALL_CLOCK_GRACE_MS = 30_000;

export interface ExtractionFillProviderTimeBudget {
  readonly requestTimeoutMs: number;
  readonly providerWallClockBudgetMs: number;
}

export function resolveExtractionFillProviderTimeBudget(
  maxOutputTokens = EXTRACTION_OUTPUT_TOKEN_QUANTUM
): ExtractionFillProviderTimeBudget {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error("extraction output-token ceiling must be a positive integer");
  }
  const requestTimeoutMs = EXTRACTION_REQUEST_TIMEOUT_MS * Math.ceil(
    maxOutputTokens / EXTRACTION_OUTPUT_TOKEN_QUANTUM
  );
  const providerWallClockBudgetMs =
    requestTimeoutMs * EXTRACTION_FILL_TRANSPORT_ATTEMPTS_PER_MISSING_SHARD +
    EXTRACTION_HTTP_MAX_RETRY_JITTER_MS + PROVIDER_WALL_CLOCK_GRACE_MS;
  if (!Number.isSafeInteger(providerWallClockBudgetMs)) {
    throw new Error("extraction provider time budget exceeds the safe integer range");
  }
  return Object.freeze({ requestTimeoutMs, providerWallClockBudgetMs });
}

export const EXTRACTION_FILL_PROVIDER_WALL_CLOCK_BUDGET_MS =
  resolveExtractionFillProviderTimeBudget().providerWallClockBudgetMs;
