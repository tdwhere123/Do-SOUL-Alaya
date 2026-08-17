import type {
  BenchSignalExtractor,
  BenchTransportFailureAttempt,
  BenchProviderUsage,
  BenchProviderResponseMetadata,
  CompileSeedExtractionConfig
} from "./compile-seed-types.js";
import {
  fetchProviderChatCompletion,
  ProviderChatCompletionError,
  type ProviderRequestProfile
} from "@do-soul/alaya-engine-gateway";
import { extractGardenHttpWithAssertionPartition } from "./http/garden-http-assertion-partition.js";
import { wrapGardenHttpTransportError } from "./http/garden-http-terminal-error.js";
import {
  runGardenHttpRetryLoop,
  type GardenHttpRetryCounters,
  type GardenHttpRetryDecision
} from "./http/garden-http-retry-loop.js";
import {
  isOutputTokenTruncation,
  resolveAttemptIdleTimeoutMs,
  withAttemptOutputTokenLimit
} from "./http/output-token-retry.js";
import {
  BENCH_HTTP_MAX_RESPONSE_SCHEMA_RETRIES,
  BENCH_HTTP_MAX_RETRIES,
  BENCH_HTTP_MAX_TIMEOUT_RETRIES,
  computeGardenHttpJitterMs,
  EXTRACTION_HTTP_MAX_RETRY_JITTER_MS
} from "./http/garden-http-retry-policy.js";
import {
  classifyBenchHttpError,
  readStatusFromBenchError
} from "./http/garden-http-error.js";
import {
  aggregateGardenHttpAttemptUsage,
  markGardenHttpFailure,
  readGardenHttpAttemptTimedOut,
  readGardenHttpFailureKind,
  settleGardenHttpAttemptFailure,
  toBenchTransportFailureAttempt
} from "./http/garden-http-failure-attempt.js";
import { buildGardenHttpAttemptResponse } from "./http/garden-http-response-validation.js";
import { observeLateGardenHttpRejection } from "./http/garden-http-late-rejection.js";
import {
  startGardenHttpAttemptSettlement,
  type GardenHttpAttemptSettlement
} from "./http/stream/garden-http-attempt-settlement.js";
import { resolveGardenSchemaRetryInstruction, withGardenResponseSchemaRepair } from
  "./http/garden-http-schema-retry.js";
import {
  assertRequiredRequestProfile,
  resolveExtractionTransportRoute
} from "../extraction/transport-route.js";
import {
  isExtractionPlanDeadlineError
} from "./http/extraction-plan-deadline.js";
export { extractContentFromChatCompletionBody } from "../extraction/chat-completion-response.js";
export { EXTRACTION_HTTP_MAX_RETRY_JITTER_MS } from "./http/garden-http-retry-policy.js";
export { EXTRACTION_REQUEST_TIMEOUT_MS } from "./http/output-token-retry.js";

// OpenAI-compatible live garden LLM delegate with bench-visible retry metadata.
export function createGardenHttpExtractor(
  config: CompileSeedExtractionConfig,
  deps?: {
    readonly sleep?: (ms: number) => Promise<void>;
    readonly random?: () => number;
    readonly fetch?: typeof fetch;
  }
): BenchSignalExtractor {
  const resolvedDeps = resolveGardenHttpExtractorDeps(deps);
  return {
    extract: async (input) => extractGardenHttpSignals(config, resolvedDeps, input)
  };
}

type GardenHttpExtractInput = Parameters<BenchSignalExtractor["extract"]>[0];
type GardenHttpExtractResult = Awaited<ReturnType<BenchSignalExtractor["extract"]>>;
type GardenHttpAttemptResponse = {
  readonly rawJson: string;
  readonly usage?: BenchProviderUsage;
  readonly responseMetadata: BenchProviderResponseMetadata;
};

type GardenHttpExtractorDeps = { readonly sleep: (ms: number) => Promise<void>; readonly random: () => number; readonly fetch: typeof fetch };

function resolveGardenHttpExtractorDeps(deps?: {
  readonly sleep?: (ms: number) => Promise<void>;
  readonly random?: () => number;
  readonly fetch?: typeof fetch;
}): GardenHttpExtractorDeps {
  return {
    sleep:
      deps?.sleep ??
      ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))),
    random: deps?.random ?? Math.random,
    fetch: deps?.fetch ?? fetch
  };
}

async function extractGardenHttpSignals(
  config: CompileSeedExtractionConfig,
  deps: GardenHttpExtractorDeps,
  input: GardenHttpExtractInput
): Promise<GardenHttpExtractResult> {
  const apiKey = config.apiKey;
  if (apiKey === null) throw new Error("garden API key is unavailable");
  return extractGardenHttpWithAssertionPartition(
    input,
    (request, allowOutputTokenEscalation) => extractGardenHttpRequest(
      config, apiKey, deps, request, allowOutputTokenEscalation
    )
  );
}

async function extractGardenHttpRequest(
  config: CompileSeedExtractionConfig, apiKey: string, deps: GardenHttpExtractorDeps,
  input: GardenHttpExtractInput,
  allowOutputTokenEscalation: boolean
): Promise<GardenHttpExtractResult> {
  let useOutputTokenCeiling = input.retryMode === "disabled";
  let responseSchemaRetryInstruction: string | null = null;
  const retry = await runGardenHttpRetryLoop({
    maxRetries: input.retryMode === "disabled" ? 0 : BENCH_HTTP_MAX_RETRIES,
    beforeAttempt: async () => {
      await input.onTransportAttempt?.(input.abortSignal);
      input.abortSignal?.throwIfAborted();
    },
    runAttempt: async (attempt) => {
      const response = await runGardenHttpAttempt(
        config,
        apiKey,
        deps,
        withAttemptOutputTokenLimit(
          withGardenResponseSchemaRepair(input, responseSchemaRetryInstruction),
          useOutputTokenCeiling
        ),
        attempt
      );
      validateGardenHttpRawJson(input, response.rawJson, response.usage);
      return response;
    },
    isRateLimited: (error) => readStatusFromBenchError(error) === 429,
    decideRetry: (error, attempt, counters, maxRetries) => {
      const shouldEscalateOutputTokens = allowOutputTokenEscalation &&
        isOutputTokenTruncation(error) &&
        !useOutputTokenCeiling;
      if (shouldEscalateOutputTokens) useOutputTokenCeiling = true;
      if (readGardenHttpFailureKind(error) === "response_schema_error") {
        responseSchemaRetryInstruction = resolveGardenSchemaRetryInstruction(input, error);
      }
      return decideGardenHttpRetry(
        input, error, attempt, counters, maxRetries, shouldEscalateOutputTokens
      );
    },
    waitForRetry: (attempt) => waitForGardenHttpRetry(deps, input, attempt),
    describeFailure: toBenchTransportFailureAttempt,
    wrapFailure: wrapGardenHttpTransportError
  });
  return buildGardenHttpSuccess(
    retry.response, retry.attempt, retry.rateLimitRetries, retry.transportFailures);
}

function validateGardenHttpRawJson(
  input: GardenHttpExtractInput,
  rawJson: string,
  usage: BenchProviderUsage | undefined
): void {
  try {
    input.validateRawJson?.(rawJson);
  } catch (error) {
    throw markGardenHttpFailure(error, {
      kind: "response_schema_error",
      phase: "response_schema",
      rawBody: rawJson,
      ...(usage === undefined ? {} : { usage })
    });
  }
}

function throwIfGardenHttpAborted(
  input: GardenHttpExtractInput
): void {
  if (input.abortSignal?.aborted !== true) return;
  const planTimedOut = isExtractionPlanDeadlineError(input.abortSignal.reason);
  throw markGardenHttpFailure(
    input.abortSignal.reason ?? new Error("garden extraction operator aborted"),
    { kind: planTimedOut ? "timeout" : "aborted", phase: "request" }
  );
}

async function waitForGardenHttpRetry(
  deps: GardenHttpExtractorDeps,
  input: GardenHttpExtractInput,
  attempt: number
): Promise<void> {
  const completed = await waitForRetryDelay(
    deps.sleep(computeGardenHttpJitterMs(attempt, deps.random)),
    input.abortSignal
  );
  if (!completed) throwIfGardenHttpAborted(input);
}

async function waitForRetryDelay(
  delay: Promise<void>,
  signal: AbortSignal | undefined
): Promise<boolean> {
  if (signal === undefined) {
    await delay;
    return true;
  }
  if (signal.aborted) return false;
  return new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const finish = (completed: boolean): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      resolve(completed);
    };
    const fail = (error: unknown): void => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      reject(error);
    };
    const onAbort = (): void => finish(false);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
    delay.then(() => finish(true), fail);
  });
}

async function runGardenHttpAttempt(
  config: CompileSeedExtractionConfig,
  apiKey: string,
  deps: GardenHttpExtractorDeps,
  input: GardenHttpExtractInput,
  attempt: number
): Promise<GardenHttpAttemptResponse> {
  const controller = new AbortController();
  const settlement = startGardenHttpAttemptSettlement({
    idleTimeoutMs: resolveAttemptIdleTimeoutMs(input),
    controller,
    ...(input.abortSignal === undefined ? {} : {
      operatorAbortSignal: input.abortSignal
    })
  });
  let attemptSettled = false;
  try {
    const transport = resolveExtractionTransportRoute(config);
    assertRequiredRequestProfile(config);
    const completePromise = fetchProviderChatCompletion({
      providerUrl: transport.providerUrl,
      apiKey,
      model: transport.model,
      systemPrompt: input.systemPrompt,
      userPrompt: input.userPrompt,
      mode: "sse",
      jsonObject: true,
      profile: config.requestProfile as ProviderRequestProfile,
      abortSignal: controller.signal,
      fetchImpl: deps.fetch,
      ...(input.maxOutputTokens === undefined ? {} : {
        maxOutputTokens: input.maxOutputTokens,
        outputTokenField: input.outputTokenField
      })
    });
    observeLateGardenHttpRejection(
      { attempt, controller, isAttemptSettled: () => attemptSettled },
      completePromise,
      "fetch"
    );
    const result = await Promise.race([completePromise, settlement.promise]);
    settlement.noteProgress();
    return buildGardenHttpAttemptResponse({
      content: result.text,
      finishReason: result.finishReason,
      ...(result.usage === undefined ? {} : { usage: result.usage })
    }, input.maxOutputTokens, input.validateRawJson === undefined
      ? "default_envelope"
      : "caller_owned");
  } catch (error) {
    throw settleGardenHttpFailure(mapProviderChatError(error), settlement, input);
  } finally {
    attemptSettled = true;
    settlement.dispose();
  }
}

function mapProviderChatError(error: unknown): unknown {
  if (!(error instanceof ProviderChatCompletionError)) return error;
  return markGardenHttpFailure(error, {
    kind: error.kind === "http_error" ? "http_error" : "network_error",
    phase: error.kind === "http_error" ? "response_status" : "request",
    ...(error.httpStatus === null ? {} : { httpStatus: error.httpStatus })
  });
}

function settleGardenHttpFailure(
  error: unknown,
  settlement: GardenHttpAttemptSettlement,
  input: GardenHttpExtractInput
): Error {
  const planTimedOut = isExtractionPlanDeadlineError(input.abortSignal?.reason);
  return settleGardenHttpAttemptFailure(
    error,
    settlement.hasTimedOut() || planTimedOut,
    input.abortSignal?.aborted === true && !planTimedOut
  );
}

function buildGardenHttpSuccess(
  response: Awaited<ReturnType<typeof runGardenHttpAttempt>>,
  attempt: number,
  rateLimitRetries: number,
  transportFailures: readonly BenchTransportFailureAttempt[]
): GardenHttpExtractResult {
  const aggregate = aggregateGardenHttpAttemptUsage(transportFailures, response.usage);
  return {
    rawJson: response.rawJson,
    ...(aggregate.usage === undefined ? {} : { usage: aggregate.usage }),
    responseMetadata: response.responseMetadata,
    extractorMeta: {
      recoveryKind: "none",
      retryCount: attempt,
      retryClassification: attempt === 0 ? "success_first_try" : "success_after_retry",
      rateLimitRetries,
      successfulRequestCount: 1,
      usageRequestCount: aggregate.usageRequestCount,
      transportFailures
    }
  };
}

function decideGardenHttpRetry(
  input: GardenHttpExtractInput,
  error: unknown,
  attempt: number,
  counters: GardenHttpRetryCounters,
  maxRetries: number,
  allowOutputTokenEscalation: boolean
): GardenHttpRetryDecision {
  if (isExtractionPlanDeadlineError(input.abortSignal?.reason)) {
    return { classification: "failure_timeout", retry: false, counters };
  }
  if (input.abortSignal?.aborted === true && !readGardenHttpAttemptTimedOut(error)) {
    return { classification: "failure_aborted", retry: false, counters };
  }
  if (readGardenHttpAttemptTimedOut(error)) {
    return decideGardenHttpTimeoutRetry(attempt, counters, maxRetries);
  }
  if (isOutputTokenTruncation(error)) {
    return {
      classification: "failure_max_retries",
      retry: allowOutputTokenEscalation && attempt < maxRetries,
      counters
    };
  }
  if (readGardenHttpFailureKind(error) === "response_schema_error") {
    const retry = attempt < maxRetries &&
      counters.responseSchemaRetries < BENCH_HTTP_MAX_RESPONSE_SCHEMA_RETRIES;
    return {
      classification: "failure_max_retries",
      retry,
      counters: retry
        ? { ...counters, responseSchemaRetries: counters.responseSchemaRetries + 1 }
        : counters
    };
  }
  const classified = classifyBenchHttpError(error, readStatusFromBenchError(error));
  if (!classified.retryable || attempt >= maxRetries) {
    return {
      classification: classified.retryable ? "failure_max_retries" : classified.classification,
      retry: false,
      counters
    };
  }
  return { classification: classified.classification, retry: true, counters };
}

function decideGardenHttpTimeoutRetry(
  attempt: number,
  counters: GardenHttpRetryCounters,
  maxRetries: number
): GardenHttpRetryDecision {
  if (counters.timeoutRetries >= BENCH_HTTP_MAX_TIMEOUT_RETRIES || attempt >= maxRetries) {
    return { classification: "failure_timeout", retry: false, counters };
  }
  return {
    classification: "failure_timeout",
    retry: true,
    counters: { ...counters, timeoutRetries: counters.timeoutRetries + 1 }
  };
}
