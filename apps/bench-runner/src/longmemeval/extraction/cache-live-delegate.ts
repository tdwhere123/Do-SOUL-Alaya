import type {
  BenchProviderUsage,
  BenchRetryClassification,
  BenchSignalExtractor,
  BenchTerminalRetryClassification,
  CompileSeedExtractionStats
} from "../compile-seed-types.js";

export interface ExtractionLiveTransportOutcome {
  readonly retryCount: number;
  readonly rateLimitRetries: number;
  readonly terminalRetryClassification?: BenchTerminalRetryClassification;
  readonly usage?: BenchProviderUsage;
}

export async function extractLiveDelegate(input: {
  readonly delegate: BenchSignalExtractor;
  readonly request: Parameters<BenchSignalExtractor["extract"]>[0];
  readonly stats: CompileSeedExtractionStats | undefined;
  readonly onFailure: () => void;
  readonly onOutcome?: (outcome: ExtractionLiveTransportOutcome) => void;
}): ReturnType<BenchSignalExtractor["extract"]> {
  let result: Awaited<ReturnType<BenchSignalExtractor["extract"]>>;
  try {
    result = await input.delegate.extract(input.request);
  } catch (cause) {
    recordRetryFailure(input.stats, cause);
    input.onOutcome?.(failureOutcome(cause));
    input.onFailure();
    throw cause;
  }
  recordRetrySuccess(input.stats, result.extractorMeta);
  input.onOutcome?.(successOutcome(result));
  return result;
}

function successOutcome(result: Awaited<ReturnType<BenchSignalExtractor["extract"]>>):
  ExtractionLiveTransportOutcome {
  return {
    retryCount: result.extractorMeta?.retryCount ?? 0,
    rateLimitRetries: result.extractorMeta?.rateLimitRetries ?? 0,
    ...(result.usage === undefined ? {} : { usage: result.usage })
  };
}

function failureOutcome(cause: unknown): ExtractionLiveTransportOutcome {
  const meta = readBenchRetryFailure(cause);
  return {
    retryCount: meta?.retryCount ?? 0,
    rateLimitRetries: meta?.rateLimitRetries ?? 0,
    ...(meta === undefined ? {} : { terminalRetryClassification: meta.retryClassification })
  };
}

function recordRetrySuccess(
  stats: CompileSeedExtractionStats | undefined,
  meta: Awaited<ReturnType<BenchSignalExtractor["extract"]>>["extractorMeta"]
): void {
  if (stats === undefined || meta === undefined) return;
  stats.rateLimitRetries = (stats.rateLimitRetries ?? 0) + meta.rateLimitRetries;
  if (meta.retryClassification === "success_after_retry") {
    stats.retrySuccesses = (stats.retrySuccesses ?? 0) + 1;
  }
}

function recordRetryFailure(stats: CompileSeedExtractionStats | undefined, cause: unknown): void {
  if (stats === undefined) return;
  const meta = readBenchRetryFailure(cause);
  if (meta === undefined) return;
  stats.rateLimitRetries = (stats.rateLimitRetries ?? 0) + meta.rateLimitRetries;
  const totals = stats.terminalRetryClassifications ?? {};
  totals[meta.retryClassification] = (totals[meta.retryClassification] ?? 0) + 1;
  stats.terminalRetryClassifications = totals;
}

function readBenchRetryFailure(cause: unknown): {
  readonly retryCount: number;
  readonly rateLimitRetries: number;
  readonly retryClassification: BenchTerminalRetryClassification;
} | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const value = (cause as { readonly benchRetry?: unknown }).benchRetry;
  return isBenchRetryFailure(value) ? value : undefined;
}

function isBenchRetryFailure(value: unknown): value is {
  readonly retryCount: number;
  readonly rateLimitRetries: number;
  readonly retryClassification: BenchTerminalRetryClassification;
} {
  if (typeof value !== "object" || value === null) return false;
  const input = value as {
    retryCount?: unknown;
    rateLimitRetries?: unknown;
    retryClassification?: unknown;
  };
  return isNonNegativeSafeInteger(input.retryCount) && isNonNegativeSafeInteger(input.rateLimitRetries) &&
    isTerminalRetryClassification(input.retryClassification);
}

function isTerminalRetryClassification(value: unknown): value is BenchTerminalRetryClassification {
  const classification = value as BenchRetryClassification;
  return classification === "failure_max_retries" ||
    classification === "failure_non_retryable_4xx" || classification === "failure_timeout" ||
    classification === "failure_aborted";
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
