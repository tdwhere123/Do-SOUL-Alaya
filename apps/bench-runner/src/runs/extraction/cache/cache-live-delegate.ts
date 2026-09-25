import {
  completeBenchTerminalRetryClassifications,
  isBenchTerminalRetryClassification,
  type BenchProviderUsage,
  type BenchTransportResponseWitness,
  type BenchSignalExtractor,
  type BenchTerminalRetryClassification,
  type BenchTransportFailureAttempt,
  type CompileSeedExtractionStats
} from "../../compile-seed/compile-seed-types.js";
import { createHash } from "node:crypto";

export interface ExtractionLiveTransportOutcome {
  readonly retryCount: number;
  readonly rateLimitRetries: number;
  readonly successfulRequestCount?: number;
  readonly usageRequestCount?: number;
  readonly unknownRequestCount?: number;
  readonly postComposeFailure?: true;
  readonly terminalRetryClassification?: BenchTerminalRetryClassification;
  readonly transportFailures: readonly BenchTransportFailureAttempt[];
  readonly usage?: BenchProviderUsage;
  readonly attemptUsages?: readonly (BenchProviderUsage | null)[];
  readonly attemptResponses?: readonly (BenchTransportResponseWitness | null)[];
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
    const outcome = failureOutcome(cause);
    try {
      if (outcome !== undefined) input.onOutcome?.(outcome);
    } finally {
      input.onFailure();
    }
    throw cause;
  }
  recordRetrySuccess(input.stats, result.extractorMeta);
  try {
    input.onOutcome?.(successOutcome(result, input.request));
  } catch (cause) {
    input.onFailure();
    throw cause;
  }
  return result;
}

function successOutcome(result: Awaited<ReturnType<BenchSignalExtractor["extract"]>>,
  request: Parameters<BenchSignalExtractor["extract"]>[0]):
  ExtractionLiveTransportOutcome {
  return {
    retryCount: result.extractorMeta?.retryCount ?? 0,
    rateLimitRetries: result.extractorMeta?.rateLimitRetries ?? 0,
    successfulRequestCount: result.extractorMeta?.successfulRequestCount ?? 1,
    usageRequestCount: result.extractorMeta?.usageRequestCount ??
      (result.usage === undefined ? 0 : 1),
    transportFailures: result.extractorMeta?.transportFailures ?? [],
    ...(result.extractorMeta?.attemptUsages === undefined ? {} : {
      attemptUsages: result.extractorMeta.attemptUsages
    }),
    attemptResponses: result.extractorMeta?.attemptResponses ??
      ((result.extractorMeta?.successfulRequestCount ?? 1) === 1 ?
        [...(result.extractorMeta?.transportFailures ?? []).map(() => null), {
          userPrompt: request.userPrompt,
          requestSha256: createHash("sha256").update(request.userPrompt, "utf8").digest("hex"),
          rawJson: result.rawJson,
          ...(result.httpResponse === undefined ? {} : { httpResponse: result.httpResponse })
        }] : undefined),
    ...(result.usage === undefined ? {} : { usage: result.usage })
  };
}

export function readLiveTransportFailure(cause: unknown): ExtractionLiveTransportOutcome | undefined {
  return failureOutcome(cause);
}

function failureOutcome(cause: unknown): ExtractionLiveTransportOutcome | undefined {
  const meta = readBenchRetryFailure(cause);
  if (meta === undefined) return undefined;
  return {
    retryCount: meta.retryCount,
    rateLimitRetries: meta.rateLimitRetries,
    ...(meta.successfulRequestCount === undefined
      ? {}
      : { successfulRequestCount: meta.successfulRequestCount }),
    ...(meta.usageRequestCount === undefined
      ? {}
      : { usageRequestCount: meta.usageRequestCount }),
    ...(meta.unknownRequestCount === undefined
      ? {}
      : { unknownRequestCount: meta.unknownRequestCount }),
    ...(meta.postComposeFailure === true ? { postComposeFailure: true as const } : {}),
    ...(meta.retryClassification === undefined
      ? {}
      : { terminalRetryClassification: meta.retryClassification }),
    transportFailures: meta.transportFailures ?? [],
    ...(meta.attemptUsages === undefined ? {} : { attemptUsages: meta.attemptUsages }),
    ...(meta.attemptResponses === undefined ? {} : { attemptResponses: meta.attemptResponses }),
    ...(meta.usage === undefined ? {} : { usage: meta.usage })
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
  if (meta.retryClassification === undefined) return;
  const totals = completeBenchTerminalRetryClassifications(
    stats.terminalRetryClassifications
  );
  totals[meta.retryClassification] += 1;
  stats.terminalRetryClassifications = totals;
}

function readBenchRetryFailure(cause: unknown): {
  readonly retryCount: number;
  readonly rateLimitRetries: number;
  readonly retryClassification?: BenchTerminalRetryClassification;
  readonly successfulRequestCount?: number;
  readonly usageRequestCount?: number;
  readonly unknownRequestCount?: number;
  readonly postComposeFailure?: true;
  readonly usage?: BenchProviderUsage;
  readonly transportFailures?: readonly BenchTransportFailureAttempt[];
  readonly attemptUsages?: readonly (BenchProviderUsage | null)[];
  readonly attemptResponses?: readonly (BenchTransportResponseWitness | null)[];
} | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const value = (cause as { readonly benchRetry?: unknown }).benchRetry;
  return isBenchRetryFailure(value) ? value : undefined;
}

function isBenchRetryFailure(value: unknown): value is {
  readonly retryCount: number;
  readonly rateLimitRetries: number;
  readonly retryClassification?: BenchTerminalRetryClassification;
  readonly successfulRequestCount?: number;
  readonly usageRequestCount?: number;
  readonly unknownRequestCount?: number;
  readonly postComposeFailure?: true;
  readonly usage?: BenchProviderUsage;
  readonly transportFailures?: readonly BenchTransportFailureAttempt[];
  readonly attemptUsages?: readonly (BenchProviderUsage | null)[];
  readonly attemptResponses?: readonly (BenchTransportResponseWitness | null)[];
} {
  if (typeof value !== "object" || value === null) return false;
  const input = value as {
    retryCount?: unknown;
    rateLimitRetries?: unknown;
    retryClassification?: unknown;
    successfulRequestCount?: unknown;
    usageRequestCount?: unknown;
    unknownRequestCount?: unknown;
    postComposeFailure?: unknown;
    usage?: unknown;
    transportFailures?: unknown;
    attemptUsages?: unknown;
    attemptResponses?: unknown;
  };
  const isTerminal = isBenchTerminalRetryClassification(input.retryClassification);
  const isPostCompose = input.postComposeFailure === true;
  return isNonNegativeSafeInteger(input.retryCount) && isNonNegativeSafeInteger(input.rateLimitRetries) &&
    (isTerminal !== isPostCompose) &&
    isOptionalNonNegativeSafeInteger(input.successfulRequestCount) &&
    isOptionalNonNegativeSafeInteger(input.usageRequestCount) &&
    isOptionalNonNegativeSafeInteger(input.unknownRequestCount) &&
    isOptionalUsage(input.usage) &&
    (input.transportFailures === undefined || Array.isArray(input.transportFailures)) &&
    (input.attemptUsages === undefined || Array.isArray(input.attemptUsages) &&
      input.attemptUsages.every((usage) => usage === null || isOptionalUsage(usage))) &&
    (input.attemptResponses === undefined || Array.isArray(input.attemptResponses));
}

function isNonNegativeSafeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOptionalNonNegativeSafeInteger(value: unknown): boolean {
  return value === undefined || isNonNegativeSafeInteger(value);
}

function isOptionalUsage(value: unknown): value is BenchProviderUsage | undefined {
  if (value === undefined) return true;
  if (typeof value !== "object" || value === null) return false;
  const usage = value as Partial<BenchProviderUsage>;
  return isNonNegativeSafeInteger(usage.inputTokens) &&
    isNonNegativeSafeInteger(usage.outputTokens) &&
    isNonNegativeSafeInteger(usage.totalTokens);
}
