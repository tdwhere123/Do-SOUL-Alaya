import { ProviderChatCompletionError } from "./errors.js";
import { fetchProviderChatCompletion } from "./fetch-chat-completion.js";
import type {
  ProviderChatCompletionRequest,
  ProviderChatCompletionResult
} from "./types.js";

export type ProviderRetryClassification =
  | "success_first_try"
  | "success_after_retry"
  | "failure_max_retries"
  | "failure_non_retryable_4xx"
  | "failure_non_retryable_response"
  | "failure_timeout"
  | "failure_aborted";

export type ProviderAttemptFailure = Readonly<{
  readonly attempt: number;
  readonly kind: ProviderChatCompletionError["kind"] | "operation_error";
  readonly httpStatus: number | null;
  readonly inspectionReason: ProviderChatCompletionError["inspectionReason"];
}>;

export type ProviderExecutionPolicy = Readonly<{
  readonly maxRetries: number;
  readonly retryDelaysMs: readonly number[];
  readonly maxTimeoutRetries?: number;
  readonly retryHttpStatuses?: readonly number[];
  readonly retryNetworkErrors?: boolean;
  readonly retryBodyReadErrors?: boolean;
  readonly retryJitter?: Readonly<{
    readonly baseMs: number;
    readonly maxMs: number;
    readonly random: () => number;
  }>;
  readonly decideOperationFailure?: (
    error: unknown,
    attempt: number
  ) => ProviderOperationRetryDecision;
}>;

export type ProviderOperationRetryDecision = Readonly<{
  readonly retry: boolean;
  readonly classification: ProviderExecutionFailure["retryClassification"];
}>;

export type ProviderExecutionObserver = Readonly<{
  readonly beforeAttempt?: (attempt: number) => void | Promise<void>;
  readonly requestForAttempt?: (
    request: ProviderChatCompletionRequest,
    attempt: number
  ) => ProviderChatCompletionRequest;
  readonly validateResult?: (
    result: ProviderChatCompletionResult,
    attempt: number
  ) => void | Promise<void>;
  readonly onAttemptFailure?: (
    failure: ProviderAttemptFailure,
    cause: unknown
  ) => void | Promise<void>;
  readonly waitForRetry?: (attempt: number, delayMs: number) => void | Promise<void>;
}>;

export type ProviderExecutionResult = Readonly<{
  readonly result: ProviderChatCompletionResult;
  readonly retryClassification: "success_first_try" | "success_after_retry";
  readonly retryCount: number;
  readonly failures: readonly ProviderAttemptFailure[];
}>;

export type ProviderExecutionFailure = Readonly<{
  readonly retryClassification: Exclude<ProviderRetryClassification,
    "success_first_try" | "success_after_retry">;
  readonly retryCount: number;
  readonly failures: readonly ProviderAttemptFailure[];
}>;

const EXECUTION_FAILURES = new WeakMap<object, ProviderExecutionFailure>();

export type ProviderChatExecutionPort = (
  request: ProviderChatCompletionRequest,
  policy: ProviderExecutionPolicy,
  observer?: ProviderExecutionObserver
) => Promise<ProviderExecutionResult>;

export const executeProviderChatCompletion: ProviderChatExecutionPort = async (
  request,
  policy,
  observer
) => {
  const failures: ProviderAttemptFailure[] = [];
  let timeoutRetries = 0;
  let pendingClassification: ProviderExecutionFailure["retryClassification"] =
    "failure_max_retries";
  for (let attempt = 0; attempt <= policy.maxRetries; attempt += 1) {
    await beforeProviderAttempt(observer, attempt, pendingClassification, failures);
    try {
      const attemptRequest = observer?.requestForAttempt?.(request, attempt) ?? request;
      const result = await fetchProviderChatCompletion(attemptRequest);
      await observer?.validateResult?.(result, attempt);
      return {
        result,
        retryClassification: attempt === 0 ? "success_first_try" : "success_after_retry",
        retryCount: attempt,
        failures: Object.freeze([...failures])
      };
    } catch (error) {
      const failure = normalizeAttemptFailure(error, attempt);
      failures.push(failure);
      await observer?.onAttemptFailure?.(failure, error);
      if (failure.kind === "timeout") timeoutRetries += 1;
      const decision = decideRetry(error, failure, attempt, timeoutRetries, policy);
      if (!decision.retry) {
        recordExecutionFailure(error, attempt, decision.classification, failures);
        throw error;
      }
      pendingClassification = decision.classification;
      await waitForProviderRetry(request, policy, observer, attempt, failures);
    }
  }
  throw new Error("provider execution exhausted without a terminal result");
};

async function beforeProviderAttempt(
  observer: ProviderExecutionObserver | undefined,
  attempt: number,
  classification: ProviderExecutionFailure["retryClassification"],
  failures: readonly ProviderAttemptFailure[]
): Promise<void> {
  try {
    await observer?.beforeAttempt?.(attempt);
  } catch (error) {
    if (attempt === 0) throw error;
    recordExecutionFailure(error, attempt - 1, classification, failures);
    throw error;
  }
}

async function waitForProviderRetry(
  request: ProviderChatCompletionRequest,
  policy: ProviderExecutionPolicy,
  observer: ProviderExecutionObserver | undefined,
  attempt: number,
  failures: readonly ProviderAttemptFailure[]
): Promise<void> {
  const delayMs = policy.retryJitter === undefined
    ? policy.retryDelaysMs[attempt] ?? 0
    : computeProviderRetryJitterMs(
      attempt, policy.retryJitter.baseMs, policy.retryJitter.maxMs, policy.retryJitter.random
    );
  try {
    if (observer?.waitForRetry !== undefined) await observer.waitForRetry(attempt, delayMs);
    else await sleep(delayMs);
  } catch (error) {
    const classification = request.abortSignal?.aborted === true
      ? "failure_aborted"
      : "failure_non_retryable_response";
    recordExecutionFailure(error, attempt, classification, failures);
    throw error;
  }
}

export function isRetryableProviderHttpStatus(status: number): boolean {
  return status === 429 || (status >= 500 && status < 600);
}

export function computeProviderRetryJitterMs(
  attempt: number,
  baseMs: number,
  maxMs: number,
  random: () => number
): number {
  const lower = Math.min(baseMs * Math.max(1, 2 ** Math.max(0, attempt)), maxMs);
  const upper = providerRetryJitterUpperBoundMs(attempt, baseMs, maxMs);
  return lower + Math.floor(random() * (upper - lower + 1));
}

export function providerRetryJitterUpperBoundMs(
  attempt: number,
  baseMs: number,
  maxMs: number
): number {
  return Math.min(baseMs * Math.max(1, 2 ** Math.max(0, attempt + 1)), maxMs);
}

export function providerExecutionFailureOf(error: unknown): ProviderExecutionFailure | undefined {
  return typeof error === "object" && error !== null ? EXECUTION_FAILURES.get(error) : undefined;
}

function recordExecutionFailure(
  error: unknown,
  retryCount: number,
  retryClassification: ProviderExecutionFailure["retryClassification"],
  failures: readonly ProviderAttemptFailure[]
): void {
  if (typeof error !== "object" || error === null) return;
  EXECUTION_FAILURES.set(error, Object.freeze({
    retryClassification,
    retryCount,
    failures: Object.freeze([...failures])
  }));
}

function normalizeAttemptFailure(error: unknown, attempt: number): ProviderAttemptFailure {
  if (error instanceof ProviderChatCompletionError) {
    return Object.freeze({
      attempt: attempt + 1,
      kind: error.kind,
      httpStatus: error.httpStatus,
      inspectionReason: error.inspectionReason
    });
  }
  return Object.freeze({
    attempt: attempt + 1,
    kind: "operation_error",
    httpStatus: null,
    inspectionReason: null
  });
}

function decideRetry(
  error: unknown,
  failure: ProviderAttemptFailure,
  attempt: number,
  timeoutRetries: number,
  policy: ProviderExecutionPolicy
): ProviderOperationRetryDecision {
  if (failure.kind === "operation_error") {
    const decision = policy.decideOperationFailure?.(error, attempt) ?? {
      retry: false,
      classification: "failure_non_retryable_response" as const
    };
    return attempt >= policy.maxRetries ? { ...decision, retry: false } : decision;
  }
  if (failure.kind === "aborted") return terminal("failure_aborted");
  if (failure.kind === "timeout") {
    return {
      retry: attempt < policy.maxRetries && timeoutRetries <= (policy.maxTimeoutRetries ?? 0),
      classification: "failure_timeout"
    };
  }
  if (failure.kind === "response_parse_error") {
    return terminal("failure_non_retryable_response");
  }
  if (failure.kind === "http_error") {
    const status = failure.httpStatus;
    const retryableStatus = status !== null && (
      policy.retryHttpStatuses?.includes(status) ?? isRetryableProviderHttpStatus(status)
    );
    if (!retryableStatus) {
      return terminal("failure_non_retryable_4xx");
    }
    return retryable(attempt, policy.maxRetries);
  }
  const enabled = failure.kind === "network_error"
    ? policy.retryNetworkErrors === true
    : policy.retryBodyReadErrors === true;
  return enabled
    ? retryable(attempt, policy.maxRetries)
    : terminal("failure_non_retryable_response");
}

function retryable(attempt: number, maxRetries: number): ProviderOperationRetryDecision {
  return { retry: attempt < maxRetries, classification: "failure_max_retries" };
}

function terminal(
  classification: ProviderExecutionFailure["retryClassification"]
): ProviderOperationRetryDecision {
  return { retry: false, classification };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    timer.unref?.();
  });
}
