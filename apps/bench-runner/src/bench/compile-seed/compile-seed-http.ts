import type {
  BenchSignalExtractor,
  BenchTransportFailureAttempt,
  BenchProviderUsage,
  BenchProviderResponseMetadata,
  CompileSeedExtractionConfig
} from "./compile-seed-types.js";
import {
  executeProviderChatCompletion,
  providerExecutionFailureOf,
  type ProviderAttemptFailure,
  type ProviderChatCompletionRequest,
  type ProviderChatCompletionResult,
  type ProviderExecutionObserver,
  type ProviderExecutionPolicy,
  type ProviderOperationRetryDecision,
  type ProviderRequestProfile
} from "@do-soul/alaya-engine-gateway";
import { extractGardenHttpWithAssertionPartition } from "./http/garden-http-assertion-partition.js";
import { wrapGardenHttpTransportError } from "./http/garden-http-terminal-error.js";
import {
  EXTRACTION_REQUEST_TIMEOUT_MS,
  isOutputTokenTruncation,
  resolveAttemptIdleTimeoutMs,
  withAttemptOutputTokenLimit
} from "./http/output-token-retry.js";
import {
  BENCH_HTTP_MAX_RESPONSE_SCHEMA_RETRIES,
  BENCH_HTTP_MAX_RETRIES,
  BENCH_HTTP_MAX_TIMEOUT_RETRIES,
  EXTRACTION_HTTP_MAX_RETRY_JITTER_MS
} from "./http/garden-http-retry-policy.js";
import {
  aggregateGardenHttpAttemptUsage,
  mapGardenHttpAttemptFailure,
  markGardenHttpFailure,
  readGardenHttpFailureKind,
  toBenchTransportFailureAttempt
} from "./http/garden-http-failure-attempt.js";
import { buildGardenHttpAttemptResponse } from "./http/garden-http-response-validation.js";
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
export { EXTRACTION_REQUEST_TIMEOUT_MS };

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

interface GardenHttpAttemptState {
  useOutputTokenCeiling: boolean;
  responseSchemaRetryInstruction: string | null;
  responseSchemaRetries: number;
  acceptedResponse?: GardenHttpAttemptResponse;
  rateLimitRetries: number;
  readonly failures: BenchTransportFailureAttempt[];
}

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
  const state: GardenHttpAttemptState = {
    useOutputTokenCeiling: input.retryMode === "disabled",
    responseSchemaRetryInstruction: null,
    responseSchemaRetries: 0,
    rateLimitRetries: 0,
    failures: []
  };
  const maxRetries = input.retryMode === "disabled" ? 0 : BENCH_HTTP_MAX_RETRIES;
  const request = buildGardenHttpRequest(config, apiKey, deps, input);
  try {
    const execution = await executeProviderChatCompletion(
      request,
      createGardenExecutionPolicy(
        input, deps, state, maxRetries, allowOutputTokenEscalation
      ),
      createGardenExecutionObserver(config, apiKey, deps, input, state)
    );
    if (state.acceptedResponse === undefined) throw new Error("provider result was not validated");
    return buildGardenHttpSuccess(
      state.acceptedResponse, execution.retryCount, state.rateLimitRetries, state.failures);
  } catch (error) {
    throwGardenExecutionFailure(input, state, error);
  }
}

function createGardenExecutionPolicy(
  input: GardenHttpExtractInput,
  deps: GardenHttpExtractorDeps,
  state: GardenHttpAttemptState,
  maxRetries: number,
  allowOutputTokenEscalation: boolean
): ProviderExecutionPolicy {
  return {
    maxRetries,
    retryDelaysMs: [],
    maxTimeoutRetries: BENCH_HTTP_MAX_TIMEOUT_RETRIES,
    retryNetworkErrors: true,
    retryBodyReadErrors: true,
    retryJitter: { baseMs: 250, maxMs: 1_500, random: deps.random },
    decideOperationFailure: (error, attempt) => updateGardenOperationPolicy(
      input, state, error, attempt, maxRetries, allowOutputTokenEscalation
    )
  };
}

function updateGardenOperationPolicy(
  input: GardenHttpExtractInput,
  state: GardenHttpAttemptState,
  error: unknown,
  attempt: number,
  maxRetries: number,
  allowOutputTokenEscalation: boolean
): ProviderOperationRetryDecision {
  if (readGardenHttpFailureKind(error) === "response_schema_error") {
    state.responseSchemaRetryInstruction = resolveGardenSchemaRetryInstruction(input, error);
  }
  const decision = decideGardenOperationRetry(
    error, attempt, state.responseSchemaRetries, maxRetries, allowOutputTokenEscalation,
    state.useOutputTokenCeiling
  );
  if (decision.escalateOutputTokens) state.useOutputTokenCeiling = true;
  if (decision.retrySchema) state.responseSchemaRetries += 1;
  return decision.retry;
}

function createGardenExecutionObserver(
  config: CompileSeedExtractionConfig,
  apiKey: string,
  deps: GardenHttpExtractorDeps,
  input: GardenHttpExtractInput,
  state: GardenHttpAttemptState
): ProviderExecutionObserver {
  return {
    beforeAttempt: async () => input.onTransportAttempt?.(input.abortSignal),
    requestForAttempt: () => buildGardenHttpRequest(
      config, apiKey, deps,
      withAttemptOutputTokenLimit(
        withGardenResponseSchemaRepair(input, state.responseSchemaRetryInstruction),
        state.useOutputTokenCeiling
      )
    ),
    validateResult: (result) => acceptGardenHttpResult(input, state, result),
    onAttemptFailure: (failure, error) => {
      recordGardenHttpFailure(input, failure, error, state.failures);
      if (failure.kind === "http_error" && failure.httpStatus === 429) {
        state.rateLimitRetries += 1;
      }
    },
    waitForRetry: (_attempt, delayMs) => waitForGardenHttpRetry(deps, input, delayMs)
  };
}

function acceptGardenHttpResult(
  input: GardenHttpExtractInput,
  state: GardenHttpAttemptState,
  result: ProviderChatCompletionResult
): void {
  state.acceptedResponse = buildGardenHttpAttemptResponse({
    content: result.text,
    finishReason: result.finishReason,
    ...(result.usage === undefined ? {} : { usage: result.usage })
  }, input.maxOutputTokens, input.validateRawJson === undefined
    ? "default_envelope"
    : "caller_owned", result.completion);
  validateGardenHttpRawJson(
    input, state.acceptedResponse.rawJson, state.acceptedResponse.usage
  );
}

function throwGardenExecutionFailure(
  input: GardenHttpExtractInput,
  state: GardenHttpAttemptState,
  error: unknown
): never {
  const receipt = providerExecutionFailureOf(error);
  if (receipt === undefined) throw error;
  const classification = isExtractionPlanDeadlineError(input.abortSignal?.reason)
    ? "failure_timeout"
    : receipt.retryClassification;
  throw wrapGardenHttpTransportError(
    error, classification, receipt.retryCount, state.rateLimitRetries, state.failures
  );
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
  delayMs: number
): Promise<void> {
  const completed = await waitForRetryDelay(
    deps.sleep(delayMs),
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

function buildGardenHttpRequest(
  config: CompileSeedExtractionConfig,
  apiKey: string,
  deps: GardenHttpExtractorDeps,
  input: GardenHttpExtractInput
): ProviderChatCompletionRequest {
  const transport = resolveExtractionTransportRoute(config);
  assertRequiredRequestProfile(config);
  return {
    providerUrl: transport.providerUrl,
    apiKey,
    model: transport.model,
    systemPrompt: input.systemPrompt,
    userPrompt: input.userPrompt,
    mode: "sse",
    jsonObject: true,
    profile: config.requestProfile as ProviderRequestProfile,
    abortSignal: input.abortSignal,
    fetchImpl: deps.fetch,
    timeoutMs: resolveAttemptIdleTimeoutMs(input),
    ...(input.maxOutputTokens === undefined ? {} : {
      maxOutputTokens: input.maxOutputTokens,
      outputTokenField: input.outputTokenField
    })
  };
}

function buildGardenHttpSuccess(
  response: GardenHttpAttemptResponse,
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

type GardenOperationDecision = Readonly<{
  readonly retry: ProviderOperationRetryDecision;
  readonly escalateOutputTokens: boolean;
  readonly retrySchema: boolean;
}>;

function decideGardenOperationRetry(
  error: unknown,
  attempt: number,
  responseSchemaRetries: number,
  maxRetries: number,
  allowOutputTokenEscalation: boolean,
  useOutputTokenCeiling: boolean
): GardenOperationDecision {
  if (isOutputTokenTruncation(error)) {
    return {
      retry: {
        classification: "failure_max_retries",
        retry: allowOutputTokenEscalation && !useOutputTokenCeiling && attempt < maxRetries
      },
      escalateOutputTokens: allowOutputTokenEscalation && !useOutputTokenCeiling,
      retrySchema: false
    };
  }
  if (readGardenHttpFailureKind(error) === "response_schema_error") {
    const retry = attempt < maxRetries &&
      responseSchemaRetries < BENCH_HTTP_MAX_RESPONSE_SCHEMA_RETRIES;
    return {
      retry: { classification: "failure_max_retries", retry },
      escalateOutputTokens: false,
      retrySchema: retry
    };
  }
  return {
    retry: { classification: "failure_non_retryable_response", retry: false },
    escalateOutputTokens: false,
    retrySchema: false
  };
}

function recordGardenHttpFailure(
  input: GardenHttpExtractInput,
  failure: ProviderAttemptFailure,
  error: unknown,
  failures: BenchTransportFailureAttempt[]
): void {
  const planTimedOut = isExtractionPlanDeadlineError(input.abortSignal?.reason);
  const mapped = mapGardenHttpAttemptFailure(error, failure.httpStatus, {
    timedOut: failure.kind === "timeout" || planTimedOut,
    aborted: failure.kind === "aborted" && !planTimedOut
  });
  const described = toBenchTransportFailureAttempt(mapped, failure.attempt - 1);
  if (described !== undefined) failures.push(described);
}
