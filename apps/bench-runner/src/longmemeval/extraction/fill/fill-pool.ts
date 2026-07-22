import {
  GardenProviderError,
  OfficialApiGardenProvider
} from "@do-soul/alaya-soul";
import type {
  BenchSignalExtractor,
  BenchTerminalRetryClassification,
  CompileSeedExtractionStats
} from "../../compile-seed/compile-seed-types.js";
import {
  EXTRACTION_HTTP_MAX_RETRY_JITTER_MS,
  EXTRACTION_REQUEST_TIMEOUT_MS
} from "../../compile-seed/compile-seed-http.js";
import { ExtractionCacheInvariantError } from "../cache/cache-invariant-error.js";
import { createAdaptiveConcurrencyController } from "../adaptive-concurrency.js";
import { EXTRACTION_FILL_TRANSPORT_ATTEMPTS_PER_MISSING_SHARD } from
  "../authority/receipt-limits.js";
import type { LongMemEvalExtractionTurn } from "../turn-contents.js";
import { readFillRetryTelemetry } from "./fill-stats.js";

type FillTaskRetryClassification = BenchTerminalRetryClassification | "unknown";

const EXTRACTION_FILL_PROVIDER_WALL_CLOCK_GRACE_MS = 30_000;
export const EXTRACTION_FILL_PROVIDER_WALL_CLOCK_BUDGET_MS =
  EXTRACTION_REQUEST_TIMEOUT_MS * EXTRACTION_FILL_TRANSPORT_ATTEMPTS_PER_MISSING_SHARD +
  EXTRACTION_HTTP_MAX_RETRY_JITTER_MS + EXTRACTION_FILL_PROVIDER_WALL_CLOCK_GRACE_MS;

export class ExtractionFillTaskError extends Error {
  readonly exitCode = 1;
  readonly retryClassification: FillTaskRetryClassification;

  constructor(input: {
    readonly retryClassification: FillTaskRetryClassification;
    readonly retrySuccesses: number;
    readonly rateLimitRetries: number;
    readonly processedTurns: number;
    readonly requestedTurns: number;
  }) {
    super(
      `terminal task failure: retry_classification=${input.retryClassification} ` +
        `retry_successes=${input.retrySuccesses} ` +
        `rate_limit_retries=${input.rateLimitRetries} ` +
        `processed_turns=${input.processedTurns}/${input.requestedTurns}`
    );
    this.name = "ExtractionFillTaskError";
    this.retryClassification = input.retryClassification;
  }
}

interface ExtractionPoolInput {
  readonly extractor: BenchSignalExtractor;
  readonly turns: readonly LongMemEvalExtractionTurn[];
  readonly concurrency: number;
  readonly initialConcurrency?: number;
  readonly requestedTurns: number;
  readonly stats: CompileSeedExtractionStats;
  readonly log: (message: string) => void;
  readonly signal?: AbortSignal;
  readonly transport?: {
    readonly retryMode: "default" | "disabled";
    readonly maxOutputTokens: number;
    readonly outputTokenField: "max_tokens" | "max_completion_tokens";
  };
  /** Leaves failed provider tasks missing so a later fill can retry them. */
  readonly tolerateProviderTaskFailures?: boolean;
}

export async function runExtractionPool(input: ExtractionPoolInput): Promise<void> {
  const scope = createPoolAbortScope(input.signal);
  const initialConcurrency = input.initialConcurrency ?? Math.min(input.concurrency, 32);
  const adaptive = createAdaptiveConcurrencyController({
    maximum: input.concurrency,
    initial: initialConcurrency,
    minimumConcurrency: Math.min(8, initialConcurrency, input.concurrency)
  });
  let processed = 0;
  let toleratedFailures = 0;
  const progressEvery = Math.max(1, Math.floor(input.requestedTurns / 20));
  try {
    await runBoundedPool(input.turns, input.concurrency, async (turn) => {
      scope.signal.throwIfAborted();
      await adaptive.acquire(scope.signal);
      let rateLimited = false;
      try {
        rateLimited = await extractTurn(
          input.extractor, turn, scope.signal, input.transport
        ) > 0;
      } catch (cause) {
        rateLimited = readRateLimitRetries(cause) > 0;
        scope.signal.throwIfAborted();
        if (cause instanceof ExtractionCacheInvariantError) {
          scope.abort(cause);
          throw cause;
        }
        processed += 1;
        if (input.tolerateProviderTaskFailures === true && isContinuableProviderFailure(cause)) {
          toleratedFailures += 1;
          input.log(
            `[extraction-fill] leaving provider failure for a later fill: ` +
              `retry_classification=${readTerminalClassification(cause)} ` +
              `processed_turns=${processed}/${input.requestedTurns}`
          );
          logProgress(
            input, processed, progressEvery, toleratedFailures
          );
          return;
        }
        const failure = buildTaskFailure(input, cause, processed);
        input.log(`[extraction-fill] stopping: ${failure.message}`);
        scope.abort(failure);
        throw failure;
      } finally {
        const priorBackoffs = adaptive.snapshot().rateLimitBackoffs;
        const concurrency = adaptive.release(rateLimited);
        recordAdaptiveTelemetry(
          input, concurrency.rateLimitBackoffs > priorBackoffs, concurrency
        );
      }
      processed += 1;
      logProgress(input, processed, progressEvery, toleratedFailures);
    });
  } finally {
    adaptive.dispose();
    scope.dispose();
  }
}

async function runBoundedPool<T>(
  tasks: readonly T[],
  concurrency: number,
  worker: (task: T) => Promise<void>
): Promise<void> {
  let cursor = 0;
  async function pump(): Promise<void> {
    while (cursor < tasks.length) {
      const task = tasks[cursor++];
      if (task !== undefined) await worker(task);
    }
  }
  const count = Math.min(Math.max(1, concurrency), tasks.length);
  const settled = await Promise.allSettled(Array.from({ length: count }, () => pump()));
  const rejected = settled.find(
    (result): result is PromiseRejectedResult => result.status === "rejected"
  );
  if (rejected !== undefined) throw rejected.reason;
}

async function extractTurn(
  extractor: BenchSignalExtractor,
  turn: LongMemEvalExtractionTurn,
  signal: AbortSignal,
  transport: ExtractionPoolInput["transport"]
): Promise<number> {
  let rateLimitRetries = 0;
  const provider = new OfficialApiGardenProvider({
    apiKey: "extraction-fill-injected",
    requestTimeoutMs: EXTRACTION_REQUEST_TIMEOUT_MS,
    wallClockBudgetMs: EXTRACTION_FILL_PROVIDER_WALL_CLOCK_BUDGET_MS,
    diagnosticDir: null,
    extractor: {
      extract: async (request) => {
        const result = await extractor.extract({
          ...request,
          ...(transport === undefined ? {} : transport),
          abortSignal: request.abortSignal === undefined
            ? signal
            : AbortSignal.any([signal, request.abortSignal])
        });
        rateLimitRetries = result.taskRateLimitRetries ??
          result.extractorMeta?.rateLimitRetries ?? 0;
        return result;
      }
    }
  });
  try {
    await provider.compile(turn.turnContent, {
      workspace_id: "extraction-fill",
      run_id: "extraction-fill",
      surface_id: null,
      turn_messages: turn.turnMessages
    });
  } catch (error) {
    if (error instanceof GardenProviderError && error.cause !== undefined) {
      throw error.cause;
    }
    throw error;
  }
  return rateLimitRetries;
}

function readRateLimitRetries(cause: unknown): number {
  if (typeof cause !== "object" || cause === null) return 0;
  const taskCount = (cause as { readonly taskRateLimitRetries?: unknown }).taskRateLimitRetries;
  if (typeof taskCount === "number" && Number.isSafeInteger(taskCount) && taskCount >= 0) {
    return taskCount;
  }
  const retry = (cause as { readonly benchRetry?: unknown }).benchRetry;
  if (typeof retry !== "object" || retry === null) return 0;
  const count = (retry as { readonly rateLimitRetries?: unknown }).rateLimitRetries;
  return typeof count === "number" && Number.isSafeInteger(count) && count >= 0 ? count : 0;
}

function buildTaskFailure(
  input: ExtractionPoolInput,
  cause: unknown,
  processedTurns: number
): ExtractionFillTaskError {
  const telemetry = readFillRetryTelemetry(input.stats);
  return new ExtractionFillTaskError({
    retryClassification: readTerminalClassification(cause),
    retrySuccesses: telemetry.retrySuccesses,
    rateLimitRetries: telemetry.rateLimitRetries,
    processedTurns,
    requestedTurns: input.requestedTurns
  });
}

function readTerminalClassification(cause: unknown): FillTaskRetryClassification {
  if (typeof cause !== "object" || cause === null) return "unknown";
  const retry = (cause as { readonly benchRetry?: unknown }).benchRetry;
  if (typeof retry !== "object" || retry === null) return "unknown";
  const value = (retry as { readonly retryClassification?: unknown }).retryClassification;
  return value === "failure_max_retries" || value === "failure_non_retryable_4xx" ||
    value === "failure_timeout" || value === "failure_aborted" ? value : "unknown";
}

function isContinuableProviderFailure(cause: unknown): boolean {
  const classification = readTerminalClassification(cause);
  return classification === "failure_max_retries" ||
    classification === "failure_non_retryable_4xx" ||
    classification === "failure_timeout";
}

function logProgress(
  input: ExtractionPoolInput,
  processed: number,
  progressEvery: number,
  toleratedFailures: number
): void {
  if (processed % progressEvery !== 0 && processed !== input.requestedTurns) return;
  input.log(
    `[extraction-fill] ${processed}/${input.requestedTurns} ` +
      `cache_hits=${input.stats.cacheHits} newly_extracted=${input.stats.llmCalls} ` +
      `tolerated_failures=${toleratedFailures}`
  );
}

function recordAdaptiveTelemetry(
  input: ExtractionPoolInput,
  backoffApplied: boolean,
  concurrency: ReturnType<ReturnType<typeof createAdaptiveConcurrencyController>["snapshot"]>
): void {
  input.stats.adaptiveConcurrencyBackoffs = concurrency.rateLimitBackoffs;
  input.stats.adaptiveConcurrencyBackoffMs = concurrency.backoffMs;
  if (!backoffApplied) return;
  input.log(
    `[extraction-fill] rate-limit backoff: concurrency=${concurrency.current}/` +
      `${concurrency.maximum} total_backoff_ms=${concurrency.backoffMs}`
  );
}

function createPoolAbortScope(external: AbortSignal | undefined): {
  readonly signal: AbortSignal;
  readonly abort: (reason: unknown) => void;
  readonly dispose: () => void;
} {
  const controller = new AbortController();
  const forward = (): void => controller.abort(external?.reason);
  if (external?.aborted === true) forward();
  else external?.addEventListener("abort", forward, { once: true });
  return {
    signal: controller.signal,
    abort: (reason) => {
      if (!controller.signal.aborted) controller.abort(reason);
    },
    dispose: () => external?.removeEventListener("abort", forward)
  };
}
