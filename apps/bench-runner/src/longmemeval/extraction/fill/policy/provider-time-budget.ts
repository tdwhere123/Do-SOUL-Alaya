import {
  EXTRACTION_HTTP_MAX_RETRY_JITTER_MS,
  EXTRACTION_REQUEST_TIMEOUT_MS
} from "../../../compile-seed/compile-seed-http.js";
import {
  EXTRACTION_FILL_TRANSPORT_ATTEMPTS_PER_MISSING_SHARD
} from "../../authority/receipt-limits.js";

const OUTPUT_TOKEN_TIMEOUT_QUANTUM = 2_048;
const PROVIDER_WALL_CLOCK_GRACE_MS = 30_000;

export interface ExtractionFillProviderTimeBudget {
  readonly requestTimeoutMs: number;
  readonly providerWallClockBudgetMs: number;
}

export function resolveExtractionFillProviderTimeBudget(
  maxOutputTokens = OUTPUT_TOKEN_TIMEOUT_QUANTUM
): ExtractionFillProviderTimeBudget {
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 1) {
    throw new Error("extraction output-token ceiling must be a positive integer");
  }
  const requestTimeoutMs = EXTRACTION_REQUEST_TIMEOUT_MS * Math.ceil(
    maxOutputTokens / OUTPUT_TOKEN_TIMEOUT_QUANTUM
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
