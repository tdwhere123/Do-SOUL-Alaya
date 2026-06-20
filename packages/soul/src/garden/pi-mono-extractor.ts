import { SignalExtractorError, type RetryClassification } from "./pi-mono-errors.js";
import { parseOrRecoverJson, type JsonRecoveryKind } from "./pi-mono-json-recovery.js";
import { fetchComplete, readTextContent, requestJsonPayload, selectModel } from "./pi-mono-transport.js";

export { SignalExtractorError } from "./pi-mono-errors.js";
export type { RetryClassification, SignalExtractorErrorKind } from "./pi-mono-errors.js";
export type { JsonRecoveryKind } from "./pi-mono-json-recovery.js";

export interface SignalExtractor {
  extract(input: {
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly abortSignal?: AbortSignal;
    readonly timeoutMs?: number;
  }): Promise<{ readonly rawJson: string; readonly extractorMeta?: SignalExtractorMeta }>;
}

// invariant: per-extract-call observability surface for the diagnostic dump
// and the bench seed report. recoveryKind records which tryRecoverJson branch
// (markdown / trailing / balanced) salvaged the body, or "none" when the
// model returned strict JSON. retryCount is the number of additional attempts
// beyond the first (0 = first try succeeded, N = recovered after N retries).
// retryClassification labels the terminal outcome of the retry loop — the
// dump consumer correlates this with retryCount so a partial-recovery vs a
// chronic-failure pattern is unambiguous.
export interface SignalExtractorMeta {
  readonly recoveryKind: JsonRecoveryKind;
  readonly retryCount: number;
  readonly retryClassification: RetryClassification;
}

export interface PiMonoExtractorDependencies {
  readonly apiKey: string;
  readonly model: string;
  readonly endpoint?: string;
  readonly complete?: PiMonoComplete;
  readonly getModel?: PiMonoGetModel;
  // test seam for the jitter sleep so retry-with-jitter unit tests do not
  // have to wait wall-clock 250-750ms per retry. Defaults to setTimeout-backed
  // sleep in production.
  readonly sleep?: (ms: number) => Promise<void>;
  // test seam for the jitter RNG so retries are deterministic in unit tests.
  // Defaults to Math.random in production.
  readonly random?: () => number;
}

// Local seam types for the LLM transport. Shape is preserved (model handle +
// context + options -> assistant message) so injected test transports keep
// working; the production default is fetch-based.
export interface PiMonoModel {
  readonly id: string;
  readonly name: string;
  readonly api: string;
  readonly provider: string;
  readonly baseUrl: string;
  readonly reasoning: boolean;
  readonly input: readonly string[];
  readonly cost: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
  };
  readonly contextWindow: number;
  readonly maxTokens: number;
}

export interface PiMonoContext {
  readonly systemPrompt: string;
  readonly messages: readonly {
    readonly role: string;
    readonly content: string;
    readonly timestamp: number;
  }[];
}

export interface PiMonoStreamOptions {
  readonly apiKey?: string;
  readonly signal?: AbortSignal;
  readonly timeoutMs?: number;
  readonly maxRetries?: number;
  readonly temperature?: number;
  readonly onPayload?: (payload: unknown, model: PiMonoModel) => unknown;
}

export interface PiMonoAssistantMessage {
  readonly content: readonly { readonly type: string; readonly text?: string }[];
}

export type PiMonoComplete = (
  model: PiMonoModel,
  context: PiMonoContext,
  options?: PiMonoStreamOptions
) => Promise<PiMonoAssistantMessage>;

export type PiMonoGetModel = (provider: "openai", modelId: string) => PiMonoModel | undefined;

const DEFAULT_MAX_RETRIES = 0;
// invariant: up to 3 retries with exponential jittered backoff on recoverable
// failure modes (empty body / parse error / 5xx / 429 / unknown transport).
// Bench evidence (35-question LongMemEval shard, 11/35 fallbacks under the
// 1-retry policy) showed yunwu.ai-routed gpt-4.1-mini empty-text storms
// outlasting a single retry, silently degrading the archive to the full-turn
// fallback path; raise the budget to 3 with bounded backoff (250-1500ms) so
// the transient empty/5xx burst recovers without doubling-doubling quota
// burn. Timeouts retry exactly ONCE (see retryBudgetForError) so a chronic
// slow path cannot 4x the bench's wall time.
const MAX_EXTRACTOR_RETRIES = 3;
const MAX_EXTRACTOR_TIMEOUT_RETRIES = 1;
// Jittered exponential backoff: attempt 1 sleeps 250-500ms, attempt 2 sleeps
// 500-1000ms, attempt 3 sleeps 1000-1500ms. The window is intentionally
// short — the bench is the hot path, and the operator already chose the
// per-request timeout budget.
const RETRY_JITTER_BASE_MS = 250;
const RETRY_JITTER_MAX_MS = 1500;

export function createPiMonoExtractor(deps: PiMonoExtractorDependencies): SignalExtractor {
  const runtime = createExtractorRuntime(deps);
  return {
    extract: async (input) => runExtractionLoop(runtime, input)
  };
}

interface ExtractorRuntime {
  readonly apiKey: string;
  readonly complete: PiMonoComplete;
  readonly model: PiMonoModel;
  readonly sleep: (ms: number) => Promise<void>;
  readonly random: () => number;
}

interface RetryState {
  attempt: number;
  timeoutRetries: number;
  lastError: unknown;
}

type ExtractInput = Parameters<SignalExtractor["extract"]>[0];

function createExtractorRuntime(
  deps: PiMonoExtractorDependencies
): ExtractorRuntime {
  const completeImpl = deps.complete ?? fetchComplete;
  // The default carries no provider catalog; selectModel falls through to the
  // OpenAI-compatible handle that pins the resolved baseUrl.
  const getModelImpl = deps.getModel ?? (() => undefined);
  return {
    apiKey: deps.apiKey,
    complete: completeImpl,
    model: selectModel({
      modelId: deps.model,
      endpoint: deps.endpoint,
      getModel: getModelImpl
    }),
    sleep: deps.sleep ?? defaultSleep,
    random: deps.random ?? Math.random
  };
}

async function runExtractionLoop(
  runtime: ExtractorRuntime,
  input: ExtractInput
): Promise<{ readonly rawJson: string; readonly extractorMeta?: SignalExtractorMeta }> {
  const state: RetryState = { attempt: 0, timeoutRetries: 0, lastError: null };
  // Bounded loop: at most MAX_EXTRACTOR_RETRIES + 1 attempts (default 4).
  // Timeout failures consume a SEPARATE smaller budget so a chronic slow path
  // cannot 4x the bench wall time.
  while (state.attempt <= MAX_EXTRACTOR_RETRIES) {
    try {
      return await runExtractionAttempt(runtime, input, state.attempt);
    } catch (error) {
      await handleExtractionFailure(runtime, input, state, error);
    }
  }
  throw buildExhaustedRetriesError(input, state);
}

async function runExtractionAttempt(
  runtime: ExtractorRuntime,
  input: ExtractInput,
  attempt: number
): Promise<{ readonly rawJson: string; readonly extractorMeta?: SignalExtractorMeta }> {
  const message = await runtime.complete(
    runtime.model,
    buildPiMonoContext(input),
    {
      apiKey: runtime.apiKey,
      signal: input.abortSignal,
      timeoutMs: input.timeoutMs,
      maxRetries: DEFAULT_MAX_RETRIES,
      temperature: 0,
      onPayload: requestJsonPayload
    }
  );
  const recovered = recoverAttemptJson(message, attempt);
  return {
    rawJson: recovered.rawJson,
    extractorMeta: {
      recoveryKind: recovered.recoveryKind,
      retryCount: attempt,
      retryClassification: attempt === 0 ? "success_first_try" : "success_after_retry"
    }
  };
}

function buildPiMonoContext(input: ExtractInput): PiMonoContext {
  return {
    systemPrompt: input.systemPrompt,
    messages: [
      {
        role: "user",
        content: input.userPrompt,
        timestamp: Date.now()
      }
    ]
  };
}

function recoverAttemptJson(
  message: PiMonoAssistantMessage,
  attempt: number
): { readonly rawJson: string; readonly recoveryKind: JsonRecoveryKind } {
  // readTextContent throws SignalExtractorError("invalid_json") on empty /
  // oversized text. That failure stays in the retry loop instead of leaking a
  // half-parsed transport boundary to callers.
  const rawText = readTextContent(message);
  const recovered = parseOrRecoverJson(rawText);
  if (recovered !== null) {
    return recovered;
  }
  throw new SignalExtractorError(
    "invalid_json",
    "Signal extractor returned invalid JSON.",
    { retryCount: attempt }
  );
}

async function handleExtractionFailure(
  runtime: ExtractorRuntime,
  input: ExtractInput,
  state: RetryState,
  error: unknown
): Promise<void> {
  state.lastError = error;
  const mapped = mapExtractorTransportError(
    error,
    input.abortSignal,
    input.timeoutMs,
    state.attempt
  );
  if (input.abortSignal?.aborted === true) {
    throw withClassification(mapped, "failure_aborted");
  }
  if (mapped.kind === "timeout") {
    await retryTimeoutFailure(runtime, state, mapped);
    return;
  }
  if (!isRetryableExtractorError(mapped, error)) {
    throw withClassification(mapped, "failure_non_retryable_4xx");
  }
  await retryAfterBackoff(runtime, state, mapped);
}

async function retryTimeoutFailure(
  runtime: ExtractorRuntime,
  state: RetryState,
  error: SignalExtractorError
): Promise<void> {
  if (state.timeoutRetries >= MAX_EXTRACTOR_TIMEOUT_RETRIES) {
    throw withClassification(error, "failure_timeout");
  }
  state.timeoutRetries += 1;
  await retryAfterBackoff(runtime, state, error);
}

async function retryAfterBackoff(
  runtime: ExtractorRuntime,
  state: RetryState,
  error: SignalExtractorError
): Promise<void> {
  if (state.attempt >= MAX_EXTRACTOR_RETRIES) {
    throw withClassification(error, "failure_max_retries");
  }
  const jitterMs = computeJitterMs(state.attempt, runtime.random);
  state.attempt += 1;
  await runtime.sleep(jitterMs);
}

function buildExhaustedRetriesError(
  input: ExtractInput,
  state: RetryState
): SignalExtractorError {
  // Defensive: the loop always returns or throws. Surface the last mapped
  // error in the impossible-path case so a future edit cannot fall through to
  // an undefined return.
  const fallback = mapExtractorTransportError(
    state.lastError,
    input.abortSignal,
    input.timeoutMs,
    state.attempt
  );
  return withClassification(fallback, "failure_max_retries");
}

function withClassification(
  error: SignalExtractorError,
  classification: RetryClassification
): SignalExtractorError {
  if (error.retryClassification === classification) {
    return error;
  }
  return new SignalExtractorError(error.kind, error.message, {
    cause: (error as { readonly cause?: unknown }).cause,
    retryCount: error.retryCount,
    retryClassification: classification
  });
}

function mapExtractorTransportError(
  error: unknown,
  abortSignal: AbortSignal | undefined,
  timeoutMs: number | undefined,
  retryCount: number
): SignalExtractorError {
  if (error instanceof SignalExtractorError) {
    // invariant: SignalExtractorError.retryCount must reflect the attempt
    // index at the moment it escapes the extractor loop. readTextContent
    // throws without retryCount set; rewrap so the diagnostic dump in
    // compute-provider.ts records the true attempt count. retryClassification
    // is intentionally NOT set here — withClassification at the throw site
    // assigns the terminal label.
    if (error.retryCount === retryCount) {
      return error;
    }
    return new SignalExtractorError(error.kind, error.message, {
      cause: (error as { readonly cause?: unknown }).cause,
      retryCount,
      retryClassification: error.retryClassification
    });
  }

  if (abortSignal?.aborted === true || isTimeoutLike(error)) {
    return new SignalExtractorError(
      "timeout",
      timeoutMs === undefined
        ? "Signal extractor request timed out."
        : `Signal extractor request timed out after ${timeoutMs}ms.`,
      { cause: error, retryCount }
    );
  }

  return new SignalExtractorError("transport_failure", "Signal extractor request failed.", {
    cause: error,
    retryCount
  });
}

// Decide whether to spend the single retry budget on this failure.
// RETRYABLE: empty/invalid JSON body (the dominant yunwu.ai
// failure mode), transport failure with an HTTP 5xx or 429 status surfaced
// in the cause chain or message. NOT RETRYABLE: timeout (caller already
// chose the budget), auth/4xx other than 429 (will fail identically), or a
// client-side abort (operator stopped the run).
function isRetryableExtractorError(
  mapped: SignalExtractorError,
  raw: unknown
): boolean {
  if (mapped.kind === "timeout") {
    return false;
  }
  if (mapped.kind === "invalid_json") {
    return true;
  }
  // transport_failure: only retry on 5xx / 429.
  const status = extractStatusFromError(raw);
  if (status === null) {
    // Unknown transport — retry once, since the dominant unobserved
    // failure here is a connection reset / DNS hiccup that resolves on
    // the next request.
    return true;
  }
  if (status === 429 || (status >= 500 && status < 600)) {
    return true;
  }
  return false;
}

function extractStatusFromError(error: unknown): number | null {
  let current: unknown = error;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current === null || current === undefined) {
      return null;
    }
    if (typeof current === "object") {
      const status = (current as { readonly status?: unknown }).status;
      if (typeof status === "number" && Number.isFinite(status)) {
        return status;
      }
      if (current instanceof Error) {
        const match = /\bHTTP\s+(\d{3})\b/u.exec(current.message);
        if (match !== null) {
          const parsed = Number.parseInt(match[1]!, 10);
          if (Number.isFinite(parsed)) {
            return parsed;
          }
        }
      }
      current = (current as { readonly cause?: unknown }).cause;
      continue;
    }
    return null;
  }
  return null;
}

// Jittered exponential backoff: attempt 0 (first retry) sleeps 250-500ms,
// attempt 1 sleeps 500-1000ms, attempt 2+ sleeps 1000-1500ms. Capped at
// RETRY_JITTER_MAX_MS so a deep retry chain cannot stall the bench past the
// per-question budget. `attempt` is the index of the FAILED attempt (0-based)
// whose retry we are about to delay.
function computeJitterMs(attempt: number, random: () => number): number {
  const baseMs = Math.min(
    RETRY_JITTER_BASE_MS * Math.max(1, 2 ** Math.max(0, attempt)),
    RETRY_JITTER_MAX_MS
  );
  const upper = Math.min(baseMs * 2, RETRY_JITTER_MAX_MS);
  const span = upper - baseMs;
  return baseMs + Math.floor(random() * (span + 1));
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isTimeoutLike(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  return /timeout|timed out|abort/u.test(`${error.name} ${error.message}`.toLowerCase());
}
