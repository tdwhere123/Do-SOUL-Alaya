import type {
  BenchTerminalRetryClassification,
  CompileSeedExtractionStats
} from "../compile-seed-types.js";

export interface FillRetryTelemetry {
  readonly retrySuccesses: number;
  readonly rateLimitRetries: number;
  readonly terminalRetryClassifications: Readonly<
    Record<BenchTerminalRetryClassification, number>
  >;
}

export function newFillStats(): CompileSeedExtractionStats {
  return {
    path: "official_api_compile",
    cacheHits: 0,
    llmCalls: 0,
    offlineFallbacks: 0,
    liveExtractionFailures: 0,
    cachedExtractionFailures: 0,
    retrySuccesses: 0,
    rateLimitRetries: 0,
    terminalRetryClassifications: {},
    factsProduced: 0,
    signalsDropped: 0,
    signalsDroppedByReason: { candidate_absent: 0, materialization_drop: 0 },
    parseDropped: 0,
    compileOverflowDropped: 0,
    lastTurnRawSignalCount: 0,
    lastTurnDraftCount: 0,
    lastExtractionSource: null,
    lastCacheKey: null
  };
}

export function readFillRetryTelemetry(
  stats: CompileSeedExtractionStats
): FillRetryTelemetry {
  const terminal = stats.terminalRetryClassifications ?? {};
  return {
    retrySuccesses: stats.retrySuccesses ?? 0,
    rateLimitRetries: stats.rateLimitRetries ?? 0,
    terminalRetryClassifications: {
      failure_max_retries: terminal.failure_max_retries ?? 0,
      failure_non_retryable_4xx: terminal.failure_non_retryable_4xx ?? 0,
      failure_timeout: terminal.failure_timeout ?? 0,
      failure_aborted: terminal.failure_aborted ?? 0
    }
  };
}
