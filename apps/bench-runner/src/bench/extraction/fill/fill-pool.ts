import {
  buildOfficialApiExtractionRequests,
  GardenProviderError,
  OfficialApiGardenProvider
} from "@do-soul/alaya-soul";
import type {
  BenchSignalExtractor,
  BenchTerminalRetryClassification,
  CompileSeedExtractionStats
} from "../../compile-seed/compile-seed-types.js";
import { ExtractionCacheInvariantError } from "../cache/cache-invariant-error.js";
import { createAdaptiveConcurrencyController } from "../adaptive-concurrency.js";
import type { AdaptiveConcurrencyReleaseOutcome } from "../adaptive-concurrency.js";
import type { LongMemEvalExtractionTurn } from "../turn-contents.js";
import { readFillRetryTelemetry } from "./fill-stats.js";
import {
  EXTRACTION_FILL_PROVIDER_WALL_CLOCK_BUDGET_MS,
  resolveExtractionFillProviderTimeBudget
} from "./policy/provider-time-budget.js";
import {
  createExtractionRequestPlanDeadline,
  resolveExtractionRequestPlanBudget
} from "./policy/provider-request-plan-budget.js";
import { inspectExtractionRawJson } from "../content-closure.js";

export { EXTRACTION_FILL_PROVIDER_WALL_CLOCK_BUDGET_MS };

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
    readonly cause: unknown;
  }) {
    super(
      `terminal task failure: retry_classification=${input.retryClassification} ` +
        `retry_successes=${input.retrySuccesses} ` +
        `rate_limit_retries=${input.rateLimitRetries} ` +
        `processed_turns=${input.processedTurns}/${input.requestedTurns}`,
      { cause: input.cause }
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
    minimumConcurrency: 1
  });
  const state: ExtractionPoolState = {
    processed: 0,
    toleratedFailures: 0,
    progressEvery: Math.max(1, Math.floor(input.requestedTurns / 20))
  };
  try {
    await runBoundedPool(input.turns, input.concurrency, (turn) =>
      runExtractionTask(input, scope, adaptive, state, turn)
    );
  } finally {
    adaptive.dispose();
    scope.dispose();
  }
}

interface ExtractionPoolState {
  processed: number;
  toleratedFailures: number;
  readonly progressEvery: number;
}

async function runExtractionTask(
  input: ExtractionPoolInput,
  scope: ReturnType<typeof createPoolAbortScope>,
  adaptive: ReturnType<typeof createAdaptiveConcurrencyController>,
  state: ExtractionPoolState,
  turn: LongMemEvalExtractionTurn
): Promise<void> {
  scope.signal.throwIfAborted();
  await adaptive.acquire(scope.signal);
  let outcome: AdaptiveConcurrencyReleaseOutcome = "neutral";
  try {
    outcome = await extractTurn(input.extractor, turn, scope.signal, input.transport) > 0
      ? "rate_limit"
      : "success";
  } catch (cause) {
    outcome = releaseOutcomeForFailure(cause);
    if (handleExtractionTaskFailure(input, scope, state, cause)) return;
  } finally {
    const prior = adaptive.snapshot();
    const concurrency = adaptive.release(outcome);
    recordAdaptiveTelemetry(input, outcome, prior, concurrency);
  }
  state.processed += 1;
  logProgress(input, state.processed, state.progressEvery, state.toleratedFailures);
}

function handleExtractionTaskFailure(
  input: ExtractionPoolInput,
  scope: ReturnType<typeof createPoolAbortScope>,
  state: ExtractionPoolState,
  cause: unknown
): boolean {
  scope.signal.throwIfAborted();
  if (cause instanceof ExtractionCacheInvariantError) {
    scope.abort(cause);
    throw cause;
  }
  state.processed += 1;
  if (input.tolerateProviderTaskFailures === true && isContinuableProviderFailure(cause)) {
    state.toleratedFailures += 1;
    input.log(
      `[extraction-fill] leaving provider failure for a later fill: ` +
        `retry_classification=${readTerminalClassification(cause)} ` +
        `failure_reason=${classifyProviderFailureReason(cause)} ` +
        `processed_turns=${state.processed}/${input.requestedTurns}`
    );
    logProgress(input, state.processed, state.progressEvery, state.toleratedFailures);
    return true;
  }
  const failure = buildTaskFailure(input, cause, state.processed);
  input.log(`[extraction-fill] stopping: ${failure.message}`);
  scope.abort(failure);
  throw failure;
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
  const runtime = createExtractionTurnRuntime(extractor, turn, signal, transport);
  try {
    await compileExtractionTurn(runtime.provider, turn);
  } finally {
    runtime.dispose();
  }
  return runtime.rateLimitRetries();
}

function createExtractionTurnRuntime(
  extractor: BenchSignalExtractor,
  turn: LongMemEvalExtractionTurn,
  signal: AbortSignal,
  transport: ExtractionPoolInput["transport"]
) {
  const timeBudget = resolveExtractionFillProviderTimeBudget(transport?.maxOutputTokens);
  const requests = buildOfficialApiExtractionRequests(
    turn.turnContent,
    turn.turnMessages
  );
  const planBudget = resolveExtractionRequestPlanBudget(
    requests,
    transport?.maxOutputTokens ?? 2_048
  );
  const deadline = createExtractionRequestPlanDeadline({
    budgetMs: planBudget.wallClockBudgetMs
  });
  const state = { rateLimitRetries: 0 };
  return {
    provider: new OfficialApiGardenProvider({
      apiKey: "extraction-fill-injected",
      requestTimeoutMs: timeBudget.requestTimeoutMs,
      wallClockBudgetMs: planBudget.wallClockBudgetMs,
      diagnosticDir: null,
      extractor: createPlanBoundExtractor(
        extractor, signal, transport, deadline, state
      )
    }),
    rateLimitRetries: () => state.rateLimitRetries,
    dispose: deadline.dispose
  };
}

function createPlanBoundExtractor(
  extractor: BenchSignalExtractor,
  signal: AbortSignal,
  transport: ExtractionPoolInput["transport"],
  deadline: ReturnType<typeof createExtractionRequestPlanDeadline>,
  state: { rateLimitRetries: number }
): BenchSignalExtractor {
  return {
    extract: async (request) => {
      const result = await extractor.extract(deadline.bindRequest({
        ...request,
        ...(transport === undefined ? {} : transport),
        // Envelope-only: a graphless but well-formed {"signals":[...]} is an
        // empty F3 proposal, not a transport failure. Requiring a graph here
        // retries the provider 3-5 times on a systematic MiMo miss.
        validateRawJson: inspectExtractionRawJson,
        abortSignal: request.abortSignal === undefined
          ? signal
          : AbortSignal.any([signal, request.abortSignal])
      }));
      state.rateLimitRetries = result.taskRateLimitRetries ??
        result.extractorMeta?.rateLimitRetries ?? 0;
      return result;
    }
  };
}

async function compileExtractionTurn(
  provider: OfficialApiGardenProvider,
  turn: LongMemEvalExtractionTurn
): Promise<void> {
  try {
    await provider.compile(turn.turnContent, {
      workspace_id: "extraction-fill",
      run_id: "extraction-fill",
      surface_id: null,
      turn_messages: turn.turnMessages
    });
  } catch (error) {
    const inner = error instanceof GardenProviderError && error.cause !== undefined
      ? error.cause
      : error;
    if (isAcceptedGraphlessExtract(inner)) return;
    if (error instanceof GardenProviderError && error.cause !== undefined) {
      throw error.cause;
    }
    throw error;
  }
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

function releaseOutcomeForFailure(cause: unknown): AdaptiveConcurrencyReleaseOutcome {
  if (readRateLimitRetries(cause) > 0) return "rate_limit";
  if (hasResponseSchemaFailure(cause)) return "neutral";
  const classification = readTerminalClassification(cause);
  return classification === "failure_max_retries" || classification === "failure_timeout"
    ? "transient_failure"
    : "neutral";
}

function hasResponseSchemaFailure(cause: unknown): boolean {
  if (typeof cause !== "object" || cause === null) return false;
  const retry = (cause as { readonly benchRetry?: unknown }).benchRetry;
  if (typeof retry !== "object" || retry === null) return false;
  const failures = (retry as { readonly transportFailures?: unknown }).transportFailures;
  return Array.isArray(failures) && failures.some((failure) =>
    typeof failure === "object" && failure !== null &&
      (failure as { readonly kind?: unknown }).kind === "response_schema_error"
  );
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
    requestedTurns: input.requestedTurns,
    cause
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

function isAcceptedGraphlessExtract(cause: unknown): boolean {
  if (typeof cause === "object" && cause !== null && "benchRetry" in cause) {
    return false;
  }
  const reason = classifyProviderFailureReason(cause);
  return reason === "semantic_factor_graph_required" ||
    reason === "no_valid_open_semantic_entries";
}

function classifyProviderFailureReason(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : "";
  if (/semantic_factor_graph_missing/iu.test(message)) {
    return "semantic_factor_graph_missing";
  }
  if (/semantic_factor_graph_required/iu.test(message)) {
    return "semantic_factor_graph_required";
  }
  const graphInvalid = /semantic_factor_graph_invalid_[a-z_]+/iu.exec(message);
  if (graphInvalid !== null) {
    return graphInvalid[0]!.toLowerCase();
  }
  if (/signal_entry_invalid/iu.test(message)) return "signal_entry_invalid";
  if (/no valid open semantic factor entries/iu.test(message)) {
    return "no_valid_open_semantic_entries";
  }
  if (/unparseable and no element recoverable/iu.test(message)) {
    return "unparseable_signals_envelope";
  }
  if (/signals array missing/iu.test(message)) return "signals_array_missing";
  if (/semantic factor graph has unbound values/iu.test(message)) {
    return "semantic_graph_unbound_values";
  }
  if (/output-token limit/iu.test(message)) return "output_token_limit";
  if (/schema validation/iu.test(message)) return "provider_response_schema";
  return "unclassified";
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
  outcome: AdaptiveConcurrencyReleaseOutcome,
  prior: ReturnType<ReturnType<typeof createAdaptiveConcurrencyController>["snapshot"]>,
  concurrency: ReturnType<ReturnType<typeof createAdaptiveConcurrencyController>["snapshot"]>
): void {
  const priorBackoffs = totalAdaptiveBackoffs(prior);
  const currentBackoffs = totalAdaptiveBackoffs(concurrency);
  input.stats.adaptiveConcurrencyBackoffs = currentBackoffs;
  input.stats.adaptiveConcurrencyBackoffMs = concurrency.backoffMs;
  if (currentBackoffs === priorBackoffs) return;
  const prefix = outcome === "rate_limit"
    ? "rate-limit backoff: "
    : `provider-pressure backoff: cause=${outcome} `;
  input.log(`[extraction-fill] ${prefix}concurrency=${concurrency.current}/` +
    `${concurrency.maximum} total_backoff_ms=${concurrency.backoffMs}`);
}

function totalAdaptiveBackoffs(
  snapshot: ReturnType<ReturnType<typeof createAdaptiveConcurrencyController>["snapshot"]>
): number {
  return snapshot.rateLimitBackoffs + snapshot.transientFailureBackoffs;
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
