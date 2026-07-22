import type {
  BenchProviderUsage,
  BenchRetryClassification,
  BenchSignalExtractor,
  BenchTerminalRetryClassification,
  BenchTransportFailureAttempt,
  CompileSeedExtractionStats
} from "../../compile-seed/compile-seed-types.js";
import { inspectExtractionRawJson } from "../content-closure.js";

export interface ExtractionLiveTransportOutcome {
  readonly retryCount: number;
  readonly rateLimitRetries: number;
  readonly terminalRetryClassification?: BenchTerminalRetryClassification;
  readonly transportFailures: readonly BenchTransportFailureAttempt[];
  readonly usage?: BenchProviderUsage;
}

export async function extractLiveDelegate(input: {
  readonly delegate: BenchSignalExtractor;
  readonly request: Parameters<BenchSignalExtractor["extract"]>[0];
  readonly stats: CompileSeedExtractionStats | undefined;
  readonly onFailure: () => void;
  readonly onOutcome?: (outcome: ExtractionLiveTransportOutcome) => void;
}): ReturnType<BenchSignalExtractor["extract"]> {
  const result = await extractReportedAttempt(input, input.request);
  if (!shouldRecheckStrictEmptyResult(input.request, result.rawJson)) return result;
  let rechecked: Awaited<ReturnType<BenchSignalExtractor["extract"]>>;
  try {
    rechecked = await extractReportedAttempt(
      input, { ...input.request, retryMode: "disabled" }
    );
  } catch (cause) {
    throw attachTaskRateLimitRetries(
      cause,
      readTaskRateLimitRetries(result) + (readBenchRetryFailure(cause)?.rateLimitRetries ?? 0)
    );
  }
  return {
    ...rechecked,
    taskRateLimitRetries: readTaskRateLimitRetries(result) + readTaskRateLimitRetries(rechecked)
  };
}

function readTaskRateLimitRetries(
  result: Awaited<ReturnType<BenchSignalExtractor["extract"]>>
): number {
  return result.taskRateLimitRetries ?? result.extractorMeta?.rateLimitRetries ?? 0;
}

function attachTaskRateLimitRetries(cause: unknown, count: number): Error {
  const error = cause instanceof Error ? cause : new Error("extraction task failed", { cause });
  Object.defineProperty(error, "taskRateLimitRetries", { value: count, configurable: true });
  return error;
}

async function extractReportedAttempt(
  input: Parameters<typeof extractLiveDelegate>[0],
  request: Parameters<BenchSignalExtractor["extract"]>[0]
): ReturnType<BenchSignalExtractor["extract"]> {
  let result: Awaited<ReturnType<BenchSignalExtractor["extract"]>>;
  try {
    result = await input.delegate.extract(request);
  } catch (cause) {
    recordRetryFailure(input.stats, cause);
    const outcome = failureOutcome(cause);
    if (outcome !== undefined) input.onOutcome?.(outcome);
    input.onFailure();
    throw cause;
  }
  recordRetrySuccess(input.stats, result.extractorMeta);
  input.onOutcome?.(successOutcome(result));
  return result;
}

function shouldRecheckStrictEmptyResult(
  request: Parameters<BenchSignalExtractor["extract"]>[0],
  rawJson: string
): boolean {
  return request.retryMode !== "disabled" && hasSourceAssertions(request.userPrompt) &&
    isStrictEmptyEnvelope(rawJson);
}

function hasSourceAssertions(userPrompt: string): boolean {
  try {
    const parsed = JSON.parse(userPrompt) as unknown;
    if (typeof parsed !== "object" || parsed === null) return false;
    const assertions = (parsed as { readonly source_assertions?: unknown }).source_assertions;
    return Array.isArray(assertions) && assertions.length > 0;
  } catch {
    return false;
  }
}

function isStrictEmptyEnvelope(rawJson: string): boolean {
  try {
    const parsed = JSON.parse(rawJson) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return false;
    const record = parsed as Readonly<Record<string, unknown>>;
    if (Object.keys(record).length !== 1 || !Array.isArray(record.signals) ||
        record.signals.length !== 0) return false;
    const inspection = inspectExtractionRawJson(rawJson);
    return inspection.rawSignalCount === 0 && inspection.parsedDraftCount === 0;
  } catch {
    return false;
  }
}

function successOutcome(result: Awaited<ReturnType<BenchSignalExtractor["extract"]>>):
  ExtractionLiveTransportOutcome {
  return {
    retryCount: result.extractorMeta?.retryCount ?? 0,
    rateLimitRetries: result.extractorMeta?.rateLimitRetries ?? 0,
    transportFailures: result.extractorMeta?.transportFailures ?? [],
    ...(result.usage === undefined ? {} : { usage: result.usage })
  };
}

function failureOutcome(cause: unknown): ExtractionLiveTransportOutcome | undefined {
  const meta = readBenchRetryFailure(cause);
  if (meta === undefined) return undefined;
  return {
    retryCount: meta.retryCount,
    rateLimitRetries: meta.rateLimitRetries,
    terminalRetryClassification: meta.retryClassification,
    transportFailures: meta.transportFailures ?? []
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
  readonly transportFailures?: readonly BenchTransportFailureAttempt[];
} | undefined {
  if (typeof cause !== "object" || cause === null) return undefined;
  const value = (cause as { readonly benchRetry?: unknown }).benchRetry;
  return isBenchRetryFailure(value) ? value : undefined;
}

function isBenchRetryFailure(value: unknown): value is {
  readonly retryCount: number;
  readonly rateLimitRetries: number;
  readonly retryClassification: BenchTerminalRetryClassification;
  readonly transportFailures?: readonly BenchTransportFailureAttempt[];
} {
  if (typeof value !== "object" || value === null) return false;
  const input = value as {
    retryCount?: unknown;
    rateLimitRetries?: unknown;
    retryClassification?: unknown;
    transportFailures?: unknown;
  };
  return isNonNegativeSafeInteger(input.retryCount) && isNonNegativeSafeInteger(input.rateLimitRetries) &&
    isTerminalRetryClassification(input.retryClassification) &&
    (input.transportFailures === undefined || Array.isArray(input.transportFailures));
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
