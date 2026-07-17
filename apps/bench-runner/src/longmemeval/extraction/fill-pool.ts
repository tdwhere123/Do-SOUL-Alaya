import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import type {
  BenchSignalExtractor,
  BenchTerminalRetryClassification,
  CompileSeedExtractionStats
} from "../compile-seed-types.js";
import { ExtractionCacheInvariantError } from "./cache-invariant-error.js";
import { createAdaptiveConcurrencyController } from "./adaptive-concurrency.js";
import { readFillRetryTelemetry } from "./fill-stats.js";

type FillTaskRetryClassification = BenchTerminalRetryClassification | "unknown";

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
  readonly distinctTurns: readonly string[];
  readonly concurrency: number;
  readonly requestedTurns: number;
  readonly stats: CompileSeedExtractionStats;
  readonly log: (message: string) => void;
  readonly signal?: AbortSignal;
  readonly transport?: {
    readonly retryMode: "default" | "disabled";
    readonly maxOutputTokens: number;
    readonly outputTokenField: "max_tokens" | "max_completion_tokens";
  };
}

export async function runExtractionPool(input: ExtractionPoolInput): Promise<void> {
  const scope = createPoolAbortScope(input.signal);
  const adaptive = createAdaptiveConcurrencyController({ maximum: input.concurrency });
  let processed = 0;
  const progressEvery = Math.max(1, Math.floor(input.requestedTurns / 20));
  try {
    await runBoundedPool(input.distinctTurns, input.concurrency, async (turnContent) => {
      scope.signal.throwIfAborted();
      await adaptive.acquire(scope.signal);
      let rateLimited = false;
      try {
        rateLimited = await extractTurn(
          input.extractor, turnContent, scope.signal, input.transport
        ) > 0;
      } catch (cause) {
        rateLimited = readRateLimitRetries(cause) > 0;
        scope.signal.throwIfAborted();
        if (cause instanceof ExtractionCacheInvariantError) {
          scope.abort(cause);
          throw cause;
        }
        processed += 1;
        const failure = buildTaskFailure(input, cause, processed);
        input.log(`[extraction-fill] stopping: ${failure.message}`);
        scope.abort(failure);
        throw failure;
      } finally {
        const concurrency = adaptive.release(rateLimited);
        recordAdaptiveTelemetry(input, rateLimited, concurrency);
      }
      processed += 1;
      logProgress(input, processed, progressEvery);
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
  turnContent: string,
  signal: AbortSignal,
  transport: ExtractionPoolInput["transport"]
): Promise<number> {
  const result = await extractor.extract({
    systemPrompt: OFFICIAL_API_SYSTEM_PROMPT,
    userPrompt: JSON.stringify({
      workspace_id: "extraction-fill",
      run_id: "extraction-fill",
      surface_id: null,
      turn_content: turnContent,
      turn_messages: []
    }),
    abortSignal: signal,
    ...(transport === undefined ? {} : transport)
  });
  return result.extractorMeta?.rateLimitRetries ?? 0;
}

function readRateLimitRetries(cause: unknown): number {
  if (typeof cause !== "object" || cause === null) return 0;
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

function logProgress(
  input: ExtractionPoolInput,
  processed: number,
  progressEvery: number
): void {
  if (processed % progressEvery !== 0 && processed !== input.requestedTurns) return;
  input.log(
    `[extraction-fill] ${processed}/${input.requestedTurns} ` +
      `cache_hits=${input.stats.cacheHits} newly_extracted=${input.stats.llmCalls} failures=0`
  );
}

function recordAdaptiveTelemetry(
  input: ExtractionPoolInput,
  rateLimited: boolean,
  concurrency: ReturnType<ReturnType<typeof createAdaptiveConcurrencyController>["snapshot"]>
): void {
  input.stats.adaptiveConcurrencyBackoffs = concurrency.rateLimitBackoffs;
  input.stats.adaptiveConcurrencyBackoffMs = concurrency.backoffMs;
  if (!rateLimited) return;
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
