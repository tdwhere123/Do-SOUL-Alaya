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

export type JsonRecoveryKind =
  | "none"
  | "markdown_strip"
  | "trailing_strip"
  | "balanced_close";

export type SignalExtractorErrorKind = "timeout" | "transport_failure" | "invalid_json";

// invariant: a closed enum so the bench / dump consumers (compute-provider
// dumpInvalidResponseDiagnostic, compile-seed dumpSeedExtractionFailureDiagnostic,
// seed-extraction-blocker) can branch on the terminal outcome without
// re-deriving it from retryCount + kind.
// see also: apps/bench-runner/src/longmemeval/compile-seed.ts
//   createGardenHttpExtractor mirrors this classification for the bench HTTP
//   transport that does not go through this file.
export type RetryClassification =
  | "success_first_try"
  | "success_after_retry"
  | "failure_max_retries"
  | "failure_non_retryable_4xx"
  | "failure_timeout"
  | "failure_aborted";

export class SignalExtractorError extends Error {
  // invariant: retryCount on the thrown error reflects the attempt index at
  // the moment the failure escaped (0 = first attempt threw and was not
  // retried, e.g. a 4xx auth fail; N = first attempt failed, retried N
  // times, all attempts still failed). retryClassification labels which
  // branch of the retry policy terminated.
  public readonly retryCount: number;
  public readonly retryClassification: RetryClassification;
  public constructor(
    public readonly kind: SignalExtractorErrorKind,
    message: string,
    options?: {
      readonly cause?: unknown;
      readonly retryCount?: number;
      readonly retryClassification?: RetryClassification;
    }
  ) {
    super(message, options);
    this.name = "SignalExtractorError";
    this.retryCount = options?.retryCount ?? 0;
    this.retryClassification = options?.retryClassification ?? "failure_max_retries";
  }
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

type PiMonoComplete = (
  model: PiMonoModel,
  context: PiMonoContext,
  options?: PiMonoStreamOptions
) => Promise<PiMonoAssistantMessage>;

type PiMonoGetModel = (provider: "openai", modelId: string) => PiMonoModel | undefined;

const DEFAULT_MAX_RETRIES = 0;
const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 8_192;
const OPENAI_DEFAULT_BASE_URL = "https://api.openai.com/v1";
const MAX_RESPONSE_TEXT_CHARS = 256_000;
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
  const completeImpl = deps.complete ?? fetchComplete;
  // The default carries no provider catalog; selectModel falls through to the
  // OpenAI-compatible handle that pins the resolved baseUrl.
  const getModelImpl = deps.getModel ?? (() => undefined);
  const selectedModel = selectModel({
    modelId: deps.model,
    endpoint: deps.endpoint,
    getModel: getModelImpl
  });
  const sleepImpl = deps.sleep ?? defaultSleep;
  const randomImpl = deps.random ?? Math.random;

  return {
    extract: async (input) => {
      let attempt = 0;
      let timeoutRetries = 0;
      let lastError: unknown = null;
      // Bounded loop: at most MAX_EXTRACTOR_RETRIES + 1 attempts (default 4).
      // Timeout failures consume a SEPARATE smaller budget so a chronic slow
      // path cannot 4x the bench wall time. We surface the SignalExtractorError
      // of the FINAL attempt so the diagnostic dump records the failure that
      // actually escaped, with retryCount + retryClassification making the
      // retry path observable.
      while (attempt <= MAX_EXTRACTOR_RETRIES) {
        try {
          const message = await completeImpl(
            selectedModel,
            {
              systemPrompt: input.systemPrompt,
              messages: [
                {
                  role: "user",
                  content: input.userPrompt,
                  timestamp: Date.now()
                }
              ]
            },
            {
              apiKey: deps.apiKey,
              signal: input.abortSignal,
              timeoutMs: input.timeoutMs,
              maxRetries: DEFAULT_MAX_RETRIES,
              temperature: 0,
              onPayload: requestJsonPayload
            }
          );
          // readTextContent throws SignalExtractorError("invalid_json") on
          // empty / oversized text — handled by the catch below so it can
          // be retried (this is the dominant failure mode observed in
          // yunwu.ai seed-extraction-failures dumps).
          const rawText = readTextContent(message);
          const recovered = parseOrRecoverJson(rawText);
          if (recovered === null) {
            throw new SignalExtractorError(
              "invalid_json",
              "Signal extractor returned invalid JSON.",
              { retryCount: attempt }
            );
          }
          return {
            rawJson: recovered.rawJson,
            extractorMeta: {
              recoveryKind: recovered.recoveryKind,
              retryCount: attempt,
              retryClassification:
                attempt === 0 ? "success_first_try" : "success_after_retry"
            }
          };
        } catch (error) {
          lastError = error;
          const mapped = mapExtractorTransportError(
            error,
            input.abortSignal,
            input.timeoutMs,
            attempt
          );
          // Client-side abort: never retry — the operator stopped the run.
          if (input.abortSignal?.aborted === true) {
            throw withClassification(mapped, "failure_aborted");
          }
          // Timeouts: bounded retry (smaller budget). Checked BEFORE
          // isRetryableExtractorError because timeouts are a distinct
          // failure family — the retry-on-timeout policy is independent
          // from the recoverable-vs-non-retryable transport split.
          if (mapped.kind === "timeout") {
            if (timeoutRetries >= MAX_EXTRACTOR_TIMEOUT_RETRIES) {
              throw withClassification(mapped, "failure_timeout");
            }
            if (attempt >= MAX_EXTRACTOR_RETRIES) {
              throw withClassification(mapped, "failure_max_retries");
            }
            timeoutRetries += 1;
            const jitterMs = computeJitterMs(attempt, randomImpl);
            attempt += 1;
            await sleepImpl(jitterMs);
            continue;
          }
          // Auth / 4xx-non-429 failures are deterministic; retrying spends
          // quota with no chance of success.
          if (!isRetryableExtractorError(mapped, error)) {
            throw withClassification(mapped, "failure_non_retryable_4xx");
          }
          if (attempt >= MAX_EXTRACTOR_RETRIES) {
            throw withClassification(mapped, "failure_max_retries");
          }
          const jitterMs = computeJitterMs(attempt, randomImpl);
          attempt += 1;
          await sleepImpl(jitterMs);
        }
      }
      // Defensive: the loop always returns or throws. Surface the last
      // mapped error in the impossible-path case so a future loop edit
      // does not silently fall through to an undefined return.
      const fallback = mapExtractorTransportError(
        lastError,
        input.abortSignal,
        input.timeoutMs,
        attempt
      );
      throw withClassification(fallback, "failure_max_retries");
    }
  };
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

function selectModel(input: {
  readonly modelId: string;
  readonly endpoint?: string;
  readonly getModel: PiMonoGetModel;
}): PiMonoModel {
  const baseModel = input.getModel("openai", input.modelId) ?? createOpenAiCompatibleModel(input.modelId);
  if (input.endpoint === undefined) {
    return baseModel;
  }

  return {
    ...baseModel,
    api: "openai-completions",
    baseUrl: normalizeOpenAiBaseUrl(input.endpoint)
  };
}

function createOpenAiCompatibleModel(modelId: string): PiMonoModel {
  return {
    id: modelId,
    name: modelId,
    api: "openai-completions",
    provider: "openai",
    baseUrl: OPENAI_DEFAULT_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: DEFAULT_CONTEXT_WINDOW,
    maxTokens: DEFAULT_MAX_TOKENS
  };
}

// OpenAI-compatible POST to {baseUrl}/chat/completions. Non-ok throws an Error
// carrying .status so the retry loop classifies 4xx vs 5xx/429.
async function fetchComplete(
  model: PiMonoModel,
  context: PiMonoContext,
  options?: PiMonoStreamOptions
): Promise<PiMonoAssistantMessage> {
  const baseUrl = model.baseUrl.replace(/\/+$/u, "");
  const body: Record<string, unknown> = {
    model: model.id,
    temperature: options?.temperature ?? 0,
    messages: [
      { role: "system", content: context.systemPrompt },
      ...context.messages.map((message) => ({
        role: message.role,
        content: message.content
      }))
    ]
  };
  const shaped = options?.onPayload?.(body, model) ?? body;
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  if (options?.signal !== undefined) {
    if (options.signal.aborted) {
      controller.abort();
    } else {
      options.signal.addEventListener("abort", onAbort);
    }
  }
  const timer =
    options?.timeoutMs === undefined
      ? null
      : setTimeout(() => controller.abort(), options.timeoutMs);
  timer?.unref?.();
  try {
    const response = await fetch(`${baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(options?.apiKey === undefined
          ? {}
          : { authorization: `Bearer ${options.apiKey}` })
      },
      body: JSON.stringify(shaped),
      signal: controller.signal
    });
    if (!response.ok) {
      const error = new Error(
        `Signal extractor request failed: HTTP ${response.status} ${response.statusText}`
      );
      (error as { status?: number }).status = response.status;
      throw error;
    }
    const payload = (await response.json()) as {
      readonly choices?: readonly {
        readonly message?: { readonly content?: unknown };
      }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    return {
      content: [
        { type: "text", text: typeof content === "string" ? content : "" }
      ]
    };
  } finally {
    if (timer !== null) {
      clearTimeout(timer);
    }
    if (options?.signal !== undefined) {
      options.signal.removeEventListener("abort", onAbort);
    }
  }
}

function requestJsonPayload(payload: unknown): unknown {
  if (!isRecord(payload)) {
    return payload;
  }

  if ("messages" in payload) {
    return {
      ...payload,
      temperature: 0,
      response_format: { type: "json_object" }
    };
  }

  if ("input" in payload) {
    const existingText = isRecord(payload.text) ? payload.text : {};
    return {
      ...payload,
      temperature: 0,
      text: {
        ...existingText,
        format: { type: "json_object" }
      }
    };
  }

  return payload;
}

function readTextContent(message: PiMonoAssistantMessage): string {
  const text = message.content
    .filter(
      (block): block is { readonly type: "text"; readonly text: string } =>
        block.type === "text" && typeof block.text === "string"
    )
    .map((block) => block.text)
    .join("");

  if (text.trim().length === 0) {
    throw new SignalExtractorError("invalid_json", "Signal extractor returned no text content.");
  }

  if (text.length > MAX_RESPONSE_TEXT_CHARS) {
    throw new SignalExtractorError("invalid_json", "Signal extractor response exceeded the size limit.");
  }

  return text;
}

// Try strict parse first; on failure walk the recovery ladder (markdown wrap
// strip → trailing-text strip → balanced-brace close).
// Returns the recovered text + which strategy ran, or null when every
// strategy fails — caller throws SignalExtractorError so the blocker still
// trips on genuinely unrecoverable bodies. NEVER fabricates content: every
// recovery branch is a textual repair of what the model emitted.
function parseOrRecoverJson(rawText: string): {
  readonly rawJson: string;
  readonly recoveryKind: JsonRecoveryKind;
} | null {
  if (isParsableJsonObject(rawText)) {
    return { rawJson: rawText, recoveryKind: "none" };
  }

  // Strategy 1: strip a leading ```json (or any language tag) fence and a
  // trailing ``` fence. Some providers (yunwu.ai-routed gpt-4.1-mini observed)
  // wrap JSON in a markdown code block even with response_format=json_object.
  const markdownStripped = stripMarkdownFence(rawText);
  if (markdownStripped !== null && isParsableJsonObject(markdownStripped)) {
    return { rawJson: markdownStripped, recoveryKind: "markdown_strip" };
  }

  // Strategy 2: strip any text after the first balanced top-level JSON
  // object. Some models append "Note: ..." or a natural-language epilogue
  // after the JSON, which json_object response_format does not always
  // suppress on third-party gateways.
  const trailingStripped = stripTrailingText(
    markdownStripped ?? rawText
  );
  if (trailingStripped !== null && isParsableJsonObject(trailingStripped)) {
    return { rawJson: trailingStripped, recoveryKind: "trailing_strip" };
  }

  // Strategy 3: close unbalanced brackets at the END of the buffer. A
  // max_tokens-truncated response loses its closing `]` or `}`. We close
  // them in the order they were opened so the resulting body is parseable.
  // Only runs after the above strategies fail, so a malformed-but-complete
  // body never gets a fake close appended.
  const balancedClosed = closeUnbalancedBrackets(
    markdownStripped ?? rawText
  );
  if (balancedClosed !== null && isParsableJsonObject(balancedClosed)) {
    return { rawJson: balancedClosed, recoveryKind: "balanced_close" };
  }

  return null;
}

function isParsableJsonObject(rawText: string): boolean {
  try {
    const parsed: unknown = JSON.parse(rawText);
    return typeof parsed === "object" && parsed !== null;
  } catch {
    return false;
  }
}

// Strip an optional ``` or ```<lang> fence at the start and a ``` fence at
// the end. Returns null when there is no fence to strip (caller falls
// through to other recovery strategies on the original text).
function stripMarkdownFence(rawText: string): string | null {
  const trimmed = rawText.trim();
  const fenceStart = /^```[a-zA-Z0-9_-]*\s*\n?/u;
  const fenceEnd = /\n?```\s*$/u;
  const startMatch = fenceStart.exec(trimmed);
  const endMatch = fenceEnd.exec(trimmed);
  if (startMatch === null && endMatch === null) {
    return null;
  }
  let inner = trimmed;
  if (startMatch !== null) {
    inner = inner.slice(startMatch[0].length);
  }
  if (endMatch !== null) {
    inner = inner.slice(0, inner.length - endMatch[0].length);
  }
  const result = inner.trim();
  return result.length === 0 ? null : result;
}

// Find the FIRST `{` and walk balanced braces (respecting JSON strings and
// escapes) to find the matching `}`; return everything inclusive. Returns
// null when no balanced top-level object exists.
function stripTrailingText(rawText: string): string | null {
  const trimmed = rawText.trim();
  const start = trimmed.indexOf("{");
  if (start < 0) {
    return null;
  }
  let depth = 0;
  let inString = false;
  let escape = false;
  for (let i = start; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        const candidate = trimmed.slice(start, i + 1);
        // Only useful when we actually stripped a tail — otherwise this is
        // a strict-parsable body and step 1 already accepted it.
        if (candidate.length === trimmed.length) {
          return null;
        }
        return candidate;
      }
    }
  }
  return null;
}

// Append missing `}` / `]` in the order they were opened so a truncated
// JSON tail becomes parseable. Respects strings and escapes so brackets
// inside string literals are not mis-counted. Returns null when the body
// has no brackets to close (no `{` or `[` seen).
function closeUnbalancedBrackets(rawText: string): string | null {
  const trimmed = rawText.trim();
  if (trimmed.length === 0) {
    return null;
  }
  const stack: Array<"{" | "["> = [];
  let inString = false;
  let escape = false;
  let truncatedString = false;
  for (let i = 0; i < trimmed.length; i += 1) {
    const ch = trimmed[i];
    if (escape) {
      escape = false;
      continue;
    }
    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }
    if (ch === '"') {
      inString = !inString;
      continue;
    }
    if (inString) {
      continue;
    }
    if (ch === "{") {
      stack.push("{");
    } else if (ch === "[") {
      stack.push("[");
    } else if (ch === "}" || ch === "]") {
      stack.pop();
    }
  }
  if (inString) {
    // A response truncated mid-string would need a closing quote before the
    // bracket close to be parseable. Add it so the recovery is honest about
    // what happened (the partial string remains, just terminated).
    truncatedString = true;
  }
  if (stack.length === 0 && !truncatedString) {
    return null;
  }
  let repaired = trimmed;
  if (truncatedString) {
    repaired = `${repaired}"`;
  }
  // Strip a dangling `,` before closing so `{"a":1,` becomes `{"a":1}` not
  // `{"a":1,}` (the latter is invalid JSON).
  repaired = repaired.replace(/,\s*$/u, "");
  for (let i = stack.length - 1; i >= 0; i -= 1) {
    repaired += stack[i] === "{" ? "}" : "]";
  }
  return repaired;
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

function normalizeOpenAiBaseUrl(endpoint: string): string {
  const withoutTrailingSlash = endpoint.trim().replace(/\/+$/u, "");
  return withoutTrailingSlash.endsWith("/chat/completions")
    ? withoutTrailingSlash.slice(0, -"/chat/completions".length)
    : withoutTrailingSlash;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
