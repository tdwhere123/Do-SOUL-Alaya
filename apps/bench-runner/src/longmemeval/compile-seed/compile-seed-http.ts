import { parseOfficialApiSignals } from "@do-soul/alaya-soul";
import type {
  BenchRetryClassification,
  BenchSignalExtractor,
  BenchProviderUsage,
  CompileSeedExtractionConfig
} from "./compile-seed-types.js";
import { buildGardenHttpRequestInit } from "../extraction/http-request.js";
import { extractContentFromChatCompletionBody } from "../extraction/chat-completion-response.js";
import { extractUsageFromChatCompletionBody } from "../extraction/chat-completion-response.js";
import {
  runGardenHttpRetryLoop,
  type GardenHttpRetryDecision
} from "./http/garden-http-retry-loop.js";
export { extractContentFromChatCompletionBody } from "../extraction/chat-completion-response.js";

export const EXTRACTION_REQUEST_TIMEOUT_MS = 60_000;

const EXTRACTION_WALL_CLOCK_TICK_MS = 5_000;

// Keep bench retry parity with pi-mono-extractor.ts.
const BENCH_HTTP_MAX_RETRIES = 3;
const BENCH_HTTP_MAX_TIMEOUT_RETRIES = 1;
const BENCH_HTTP_JITTER_BASE_MS = 250;
const BENCH_HTTP_JITTER_MAX_MS = 1500;

function computeBenchJitterMs(attempt: number, random: () => number): number {
  const baseMs = Math.min(
    BENCH_HTTP_JITTER_BASE_MS * Math.max(1, 2 ** Math.max(0, attempt)),
    BENCH_HTTP_JITTER_MAX_MS
  );
  const upper = Math.min(baseMs * 2, BENCH_HTTP_JITTER_MAX_MS);
  const span = upper - baseMs;
  return baseMs + Math.floor(random() * (span + 1));
}

type BenchHttpError = { readonly classification: BenchRetryClassification; readonly retryable: boolean };

function classifyBenchHttpError(
  error: unknown,
  status: number | null
): BenchHttpError {
  if (error instanceof Error && /abort/iu.test(error.name + error.message)) {
    return {
      classification: "failure_aborted",
      retryable: false
    };
  }
  if (status !== null) {
    if (status === 429 || (status >= 500 && status < 600)) {
      return {
        classification: "failure_max_retries",
        retryable: true
      };
    }
    if (status >= 400 && status < 500) {
      return {
        classification: "failure_non_retryable_4xx",
        retryable: false
      };
    }
  }
  return {
    classification: "failure_max_retries",
    retryable: true
  };
}

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

type GardenHttpExtractorDeps = { readonly sleep: (ms: number) => Promise<void>; readonly random: () => number; readonly fetch: typeof fetch };

type GardenHttpAttemptSettlement = { readonly promise: Promise<never>; readonly hasTimedOut: () => boolean; readonly dispose: () => void };

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
  const apiKey = requireGardenApiKey(config);
  const retry = await runGardenHttpRetryLoop({
    maxRetries: input.retryMode === "disabled" ? 0 : BENCH_HTTP_MAX_RETRIES,
    runAttempt: (attempt) => runGardenHttpAttempt(config, apiKey, deps, input, attempt),
    throwIfAborted: (attempt, rateLimitRetries) =>
      throwIfGardenHttpAborted(input, attempt, rateLimitRetries),
    isRateLimited: (error) => readStatusFromBenchError(error) === 429,
    decideRetry: (error, attempt, timeoutRetries, maxRetries) =>
      decideGardenHttpRetry(input, error, attempt, timeoutRetries, maxRetries),
    waitForRetry: (attempt, rateLimitRetries) =>
      waitForGardenHttpRetry(deps, input, attempt, rateLimitRetries),
    wrapFailure: wrapBenchTransportError
  });
  return buildGardenHttpSuccess(retry.response, retry.attempt, retry.rateLimitRetries);
}

function requireGardenApiKey(config: CompileSeedExtractionConfig): string {
  if (config.apiKey === null) throw new Error("garden API key is unavailable");
  return config.apiKey;
}

function throwIfGardenHttpAborted(
  input: GardenHttpExtractInput,
  attempt: number,
  rateLimitRetries: number
): void {
  if (input.abortSignal?.aborted !== true) return;
  throw wrapBenchTransportError(
    input.abortSignal.reason ?? new Error("garden extraction operator aborted"),
    "failure_aborted",
    attempt,
    rateLimitRetries
  );
}

async function waitForGardenHttpRetry(
  deps: GardenHttpExtractorDeps,
  input: GardenHttpExtractInput,
  attempt: number,
  rateLimitRetries: number
): Promise<void> {
  const completed = await waitForRetryDelay(
    deps.sleep(computeBenchJitterMs(attempt, deps.random)),
    input.abortSignal
  );
  if (!completed) throwIfGardenHttpAborted(input, attempt, rateLimitRetries);
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
): Promise<{ readonly rawJson: string; readonly usage?: BenchProviderUsage }> {
  const controller = new AbortController();
  const settlement = startGardenHttpAttemptSettlement(input, controller);
  let attemptSettled = false;
  try {
    const response = await fetchGardenHttpResponse({
      config,
      apiKey,
      deps,
      input,
      attempt,
      controller,
      settlement,
      isAttemptSettled: () => attemptSettled
    });
    const bodyText = await readGardenHttpBodyText(
      response,
      settlement,
      controller,
      () => attemptSettled,
      attempt
    );
    const contentType = response.headers.get("content-type");
    const usage = extractUsageFromChatCompletionBody(bodyText, contentType);
    return {
      rawJson: extractValidGardenHttpContent(bodyText, contentType),
      ...(usage === undefined ? {} : { usage })
    };
  } catch (error) {
    throw markGardenHttpAttemptTimeout(error, settlement.hasTimedOut());
  } finally {
    attemptSettled = true;
    settlement.dispose();
  }
}

function buildGardenHttpSuccess(
  response: Awaited<ReturnType<typeof runGardenHttpAttempt>>,
  attempt: number,
  rateLimitRetries: number
): GardenHttpExtractResult {
  return {
    rawJson: response.rawJson,
    ...(response.usage === undefined ? {} : { usage: response.usage }),
    extractorMeta: {
      recoveryKind: "none",
      retryCount: attempt,
      retryClassification: attempt === 0 ? "success_first_try" : "success_after_retry",
      rateLimitRetries
    }
  };
}

function decideGardenHttpRetry(
  input: GardenHttpExtractInput,
  error: unknown,
  attempt: number,
  timeoutRetries: number,
  maxRetries: number
): GardenHttpRetryDecision {
  if (input.abortSignal?.aborted === true && !readGardenHttpAttemptTimedOut(error)) {
    return { classification: "failure_aborted", retry: false, timeoutRetries };
  }
  if (readGardenHttpAttemptTimedOut(error)) {
    if (timeoutRetries >= BENCH_HTTP_MAX_TIMEOUT_RETRIES) {
      return { classification: "failure_timeout", retry: false, timeoutRetries };
    }
    if (attempt >= maxRetries) {
      return { classification: "failure_timeout", retry: false, timeoutRetries };
    }
    return {
      classification: "failure_timeout",
      retry: true,
      timeoutRetries: timeoutRetries + 1
    };
  }
  const classified = classifyBenchHttpError(error, readStatusFromBenchError(error));
  if (!classified.retryable || attempt >= maxRetries) {
    return {
      classification: classified.retryable ? "failure_max_retries" : classified.classification,
      retry: false,
      timeoutRetries
    };
  }
  return { classification: classified.classification, retry: true, timeoutRetries };
}

function startGardenHttpAttemptSettlement(
  input: GardenHttpExtractInput,
  controller: AbortController
): GardenHttpAttemptSettlement {
  let timedOut = false;
  let rejectSettlement: ((error: Error) => void) | null = null;
  const promise = new Promise<never>((_resolve, reject) => {
    rejectSettlement = reject;
  });
  const budgetMs = input.timeoutMs ?? EXTRACTION_REQUEST_TIMEOUT_MS;
  const fireTimeout = (): void => {
    if (timedOut) return;
    timedOut = true;
    controller.abort();
    rejectSettlement?.(
      new Error(`garden extraction transport stalled past ${budgetMs}ms budget`)
    );
  };
  const timer = setTimeout(fireTimeout, budgetMs);
  timer.unref?.();
  const startedAt = Date.now();
  const wallClockTimer = setInterval(() => {
    if (Date.now() - startedAt >= budgetMs) fireTimeout();
  }, EXTRACTION_WALL_CLOCK_TICK_MS);
  wallClockTimer.unref?.();
  const onOperatorAbort = (): void => {
    controller.abort();
    rejectSettlement?.(new Error("garden extraction operator aborted"));
  };
  addOperatorAbortListener(input.abortSignal, onOperatorAbort);
  return {
    promise,
    hasTimedOut: () => timedOut,
    dispose: () => {
      clearTimeout(timer);
      clearInterval(wallClockTimer);
      input.abortSignal?.removeEventListener("abort", onOperatorAbort);
    }
  };
}

function addOperatorAbortListener(
  abortSignal: AbortSignal | undefined,
  onOperatorAbort: () => void
): void {
  if (abortSignal === undefined) return;
  if (abortSignal.aborted) {
    onOperatorAbort();
    return;
  }
  abortSignal.addEventListener("abort", onOperatorAbort);
}

type GardenHttpFetchInput = { readonly config: CompileSeedExtractionConfig; readonly apiKey: string; readonly deps: GardenHttpExtractorDeps; readonly input: GardenHttpExtractInput; readonly attempt: number; readonly controller: AbortController; readonly settlement: GardenHttpAttemptSettlement; readonly isAttemptSettled: () => boolean };

async function fetchGardenHttpResponse(
  input: GardenHttpFetchInput
): Promise<Response> {
  input.input.onTransportAttempt?.();
  const fetchPromise = input.deps.fetch(
    `${input.config.providerUrl}/chat/completions`,
    buildGardenHttpRequestInit(
      input.config,
      input.apiKey,
      input.input,
      input.controller.signal
    )
  );
  observeLateGardenHttpRejection(input, fetchPromise, "fetch");
  const response = await Promise.race([fetchPromise, input.settlement.promise]);
  if (!response.ok) {
    const err = new Error(
      `garden extraction HTTP ${response.status} ${response.statusText}`
    );
    (err as { status?: number }).status = response.status;
    throw err;
  }
  return response;
}

async function readGardenHttpBodyText(
  response: Response,
  settlement: GardenHttpAttemptSettlement,
  controller: AbortController,
  isAttemptSettled: () => boolean,
  attempt: number
): Promise<string> {
  const bodyTextPromise = response.text();
  observeLateGardenHttpRejection(
    { attempt, controller, isAttemptSettled },
    bodyTextPromise,
    "body read"
  );
  return await Promise.race([bodyTextPromise, settlement.promise]);
}

function observeLateGardenHttpRejection<T>(
  input: {
    readonly attempt: number;
    readonly controller: AbortController;
    readonly isAttemptSettled: () => boolean;
  },
  promise: Promise<T>,
  phase: "fetch" | "body read"
): void {
  void promise.catch((error: unknown) => {
    if (!input.isAttemptSettled() || input.controller.signal.aborted) {
      return;
    }
    console.warn(
      `bench-runner/garden-http-extractor: ${phase} rejected after outer settlement`,
      { attempt: input.attempt, error }
    );
  });
}

function extractValidGardenHttpContent(
  bodyText: string,
  contentType: string | null
): string {
  const content = extractContentFromChatCompletionBody(bodyText, contentType);
  if (content.trim().length === 0) {
    throw new Error("garden extraction returned no content");
  }
  try {
    parseOfficialApiSignals(content);
  } catch (parseError) {
    throw new Error(
      `garden extraction returned unparseable content: ${
        parseError instanceof Error ? parseError.message : String(parseError)
      }`
    );
  }
  return content;
}

function markGardenHttpAttemptTimeout(error: unknown, timedOut: boolean): Error {
  const wrapped = error instanceof Error ? error : new Error(String(error));
  (wrapped as { benchAttemptTimedOut?: boolean }).benchAttemptTimedOut = timedOut;
  return wrapped;
}

function readGardenHttpAttemptTimedOut(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { benchAttemptTimedOut?: unknown }).benchAttemptTimedOut === true
  );
}

function wrapBenchTransportError(
  cause: unknown,
  classification: BenchRetryClassification,
  retryCount: number,
  rateLimitRetries: number
): Error {
  const message =
    cause instanceof Error
      ? cause.message
      : `garden extraction failed: ${String(cause)}`;
  const wrapped = new Error(message);
  (wrapped as { cause?: unknown }).cause = cause;
  (wrapped as { benchRetry?: unknown }).benchRetry = {
    retryCount,
    retryClassification: classification,
    rateLimitRetries
  };
  return wrapped;
}

function readStatusFromBenchError(error: unknown): number | null {
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const status = (error as { readonly status?: unknown }).status;
  if (typeof status === "number" && Number.isFinite(status)) {
    return status;
  }
  if (error instanceof Error) {
    const match = /\bHTTP\s+(\d{3})\b/u.exec(error.message);
    if (match !== null) {
      const parsed = Number.parseInt(match[1]!, 10);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }
  }
  return null;
}
