import type { EmbeddingProviderPort } from "./types.js";
import {
  DEFAULT_EMBEDDING_REQUEST_MAX_ATTEMPTS,
  DEFAULT_EMBEDDING_REQUEST_RETRY_DELAY_MS,
  EMBEDDING_TRANSPORT_BACKSTOP_MARGIN_MS,
  MAX_EMBEDDING_REQUEST_ATTEMPTS,
  MAX_EMBEDDING_REQUEST_RETRY_DELAY_MS,
  MAX_EMBEDDING_REQUEST_TOTAL_BACKOFF_MS,
  MAX_EMBEDDING_REQUEST_TOTAL_WALLCLOCK_MS
} from "./constants.js";

export interface EmbeddingRetryEvent {
  readonly host: string;
  readonly attempt: number;
  readonly maxAttempts: number;
  readonly delayMs: number;
  readonly reason: "transport_error" | "retryable_status";
  readonly status?: number;
  readonly errorMessage?: string;
}

export interface OpenAIEmbeddingClientOptions {
  readonly apiKey: string | null;
  readonly model?: string;
  readonly baseUrl?: string;
  readonly fetchImpl?: typeof fetch;
  readonly maxAttempts?: number;
  readonly retryDelayMs?: number;
  // invariant: backstop margin (ms) over the abort deadline; see
  // EMBEDDING_TRANSPORT_BACKSTOP_MARGIN_MS for the constant and rationale.
  readonly transportBackstopMarginMs?: number;
  // invariant: ceiling on summed backoff gaps per embedTexts call; see
  // MAX_EMBEDDING_REQUEST_TOTAL_BACKOFF_MS.
  readonly totalBackoffBudgetMs?: number;
  // invariant: hard wall-clock ceiling on the whole retry loop; see
  // MAX_EMBEDDING_REQUEST_TOTAL_WALLCLOCK_MS.
  readonly totalWallclockBudgetMs?: number;
  // Injectable monotonic clock (ms) for the wall-clock ceiling. Test determinism.
  readonly now?: () => number;
  // Injectable RNG for jitter (test determinism). Defaults to Math.random.
  readonly random?: () => number;
  // Diagnostics sink for retry activity. When unset, retries emit a structured
  // console.warn so flakiness is never fully silent.
  readonly onRetry?: (event: EmbeddingRetryEvent) => void;
}

function clampEmbeddingRequestAttempts(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return DEFAULT_EMBEDDING_REQUEST_MAX_ATTEMPTS;
  }
  return Math.min(MAX_EMBEDDING_REQUEST_ATTEMPTS, Math.max(1, Math.floor(value)));
}

function clampEmbeddingRequestRetryDelayMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value < 0) {
    return DEFAULT_EMBEDDING_REQUEST_RETRY_DELAY_MS;
  }
  return Math.min(MAX_EMBEDDING_REQUEST_RETRY_DELAY_MS, Math.floor(value));
}

function clampEmbeddingRequestTotalBackoffMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return MAX_EMBEDDING_REQUEST_TOTAL_BACKOFF_MS;
  }
  return Math.max(0, Math.floor(value));
}

function clampEmbeddingRequestTotalWallclockMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return MAX_EMBEDDING_REQUEST_TOTAL_WALLCLOCK_MS;
  }
  return Math.max(1, Math.floor(value));
}

// invariant: exponential backoff with full jitter. capped gap = min(maxGapMs,
// base * 2^attemptIndex); returned gap = capped + uniform jitter in [0, base).
// attemptIndex is 0 for the gap after the first attempt. random injectable so
// tests are deterministic.
// see also: packages/core/src/embedding-recall/constants.ts:MAX_EMBEDDING_REQUEST_TOTAL_BACKOFF_MS
// see also: packages/core/src/embedding-recall/openai-client.ts:OpenAIEmbeddingClient.fetchEmbeddingWithRetry
function computeEmbeddingBackoffMs(
  baseMs: number,
  attemptIndex: number,
  maxGapMs: number,
  random: () => number
): number {
  if (baseMs <= 0) {
    return 0;
  }
  const exponential = baseMs * 2 ** Math.max(0, attemptIndex);
  const capped = Math.min(maxGapMs, exponential);
  const jitter = Math.floor(random() * baseMs);
  return capped + jitter;
}

// invariant: margin floored at 1ms so the backstop is always strictly later
// than the abort deadline; default is EMBEDDING_TRANSPORT_BACKSTOP_MARGIN_MS.
function clampEmbeddingTransportBackstopMarginMs(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value) || value <= 0) {
    return EMBEDDING_TRANSPORT_BACKSTOP_MARGIN_MS;
  }
  return Math.max(1, Math.floor(value));
}

export class OpenAIEmbeddingClient implements EmbeddingProviderPort {
  public readonly providerKind = "openai";
  public readonly modelId: string;
  public readonly schemaVersion = 1;
  public readonly isAvailable: boolean;

  private readonly apiKey: string | null;
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly maxAttempts: number;
  private readonly retryDelayMs: number;
  private readonly transportBackstopMarginMs: number;
  private readonly totalBackoffBudgetMs: number;
  private readonly totalWallclockBudgetMs: number;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly onRetry: (event: EmbeddingRetryEvent) => void;

  public constructor(options: OpenAIEmbeddingClientOptions) {
    this.apiKey = options.apiKey;
    this.modelId = options.model?.trim() || "text-embedding-3-small";
    this.baseUrl = normalizeBaseUrl(options.baseUrl ?? "https://api.openai.com/v1");
    this.fetchImpl = options.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.maxAttempts = clampEmbeddingRequestAttempts(options.maxAttempts);
    this.retryDelayMs = clampEmbeddingRequestRetryDelayMs(options.retryDelayMs);
    this.transportBackstopMarginMs = clampEmbeddingTransportBackstopMarginMs(
      options.transportBackstopMarginMs
    );
    this.totalBackoffBudgetMs = clampEmbeddingRequestTotalBackoffMs(
      options.totalBackoffBudgetMs
    );
    this.totalWallclockBudgetMs = clampEmbeddingRequestTotalWallclockMs(
      options.totalWallclockBudgetMs
    );
    this.now = options.now ?? (() => Date.now());
    this.random = options.random ?? Math.random;
    this.onRetry = options.onRetry ?? defaultEmbeddingRetrySink;
    this.isAvailable = typeof this.apiKey === "string" && this.apiKey.length > 0;
  }

  public async embedTexts(
    texts: readonly string[],
    options: {
      readonly timeoutMs: number;
    }
  ): Promise<readonly Float32Array[]> {
    if (!this.isAvailable) {
      throw new Error("OPENAI_API_KEY is not configured for embeddings.");
    }

    if (texts.length === 0) {
      return Object.freeze([]);
    }

    const response = await this.fetchEmbeddingWithRetry(texts, options.timeoutMs);

    if (!response.ok) {
      throw new Error(
        `Embedding request failed with status ${response.status} for host ${formatEmbeddingHost(this.baseUrl)}.`
      );
    }

    const payload = (await response.json()) as {
      readonly data?: ReadonlyArray<{
        readonly embedding?: readonly number[];
        readonly index?: number;
      }>;
    };
    const data = [...(payload.data ?? [])].sort(
      (left, right) => (left.index ?? 0) - (right.index ?? 0)
    );

    if (data.length !== texts.length) {
      throw new Error(`Embedding request returned ${data.length} vectors for ${texts.length} inputs.`);
    }

    return Object.freeze(
      data.map((entry, index) => {
        if (!Array.isArray(entry.embedding) || entry.embedding.length === 0) {
          throw new Error(`Embedding response ${index} did not include a valid vector.`);
        }

        return new Float32Array(entry.embedding);
      })
    );
  }

  // invariant: each attempt gets a FRESH AbortController + backstop, so a single
  // attempt's transport timeout is a retryable transport error rather than a
  // signal that kills the whole retry budget. backstopMs > abortTimeoutMs (see
  // EMBEDDING_TRANSPORT_BACKSTOP_MARGIN_MS); abort stays primary, backstop is
  // strictly later. backoff gaps between attempts are exponential + jittered and
  // their sum is capped by totalBackoffBudgetMs.
  // see also: packages/core/src/embedding-recall/openai-client.ts:computeEmbeddingBackoffMs
  // see also: packages/core/src/embedding-recall/constants.ts:MAX_EMBEDDING_REQUEST_TOTAL_BACKOFF_MS
  private async fetchEmbeddingWithRetry(
    texts: readonly string[],
    abortTimeoutMs: number
  ): Promise<Response> {
    const backstopMs =
      (Number.isFinite(abortTimeoutMs) && abortTimeoutMs > 0 ? abortTimeoutMs : 0) +
      this.transportBackstopMarginMs;
    let remainingBackoffMs = this.totalBackoffBudgetMs;
    const startedAt = this.now();
    const deadline = startedAt + this.totalWallclockBudgetMs;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
      const attemptAbort = new AbortController();
      const attemptTimeout = setTimeout(
        () => attemptAbort.abort("embedding-timeout"),
        abortTimeoutMs
      );
      attemptTimeout.unref?.();
      try {
        const response = await this.raceFetchAgainstBackstop(
          this.fetchImpl(`${this.baseUrl}/embeddings`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${this.apiKey}`
            },
            body: JSON.stringify({
              model: this.modelId,
              input: texts
            }),
            signal: attemptAbort.signal
          }),
          backstopMs
        );
        if (attempt < this.maxAttempts && isRetryableEmbeddingStatus(response.status)) {
          if (this.now() >= deadline) {
            return response;
          }
          remainingBackoffMs = await this.backoffBeforeRetry(
            attempt,
            remainingBackoffMs,
            { reason: "retryable_status", status: response.status }
          );
          continue;
        }
        return response;
      } catch (error) {
        lastError = error;
        if (attempt >= this.maxAttempts || this.now() >= deadline) {
          throw new Error(formatEmbeddingTransportError(this.baseUrl, error));
        }
        remainingBackoffMs = await this.backoffBeforeRetry(attempt, remainingBackoffMs, {
          reason: "transport_error",
          errorMessage: error instanceof Error ? error.message : String(error)
        });
      } finally {
        clearTimeout(attemptTimeout);
      }
    }

    throw new Error(formatEmbeddingTransportError(this.baseUrl, lastError));
  }

  // invariant: returns the remaining total backoff budget after sleeping the
  // jittered exponential gap (clamped to what budget is left). emits onRetry so
  // transport flakiness is recorded, not silent.
  private async backoffBeforeRetry(
    attempt: number,
    remainingBackoffMs: number,
    detail: Pick<EmbeddingRetryEvent, "reason" | "status" | "errorMessage">
  ): Promise<number> {
    const requestedMs = computeEmbeddingBackoffMs(
      this.retryDelayMs,
      attempt - 1,
      MAX_EMBEDDING_REQUEST_RETRY_DELAY_MS,
      this.random
    );
    const delayMs = Math.max(0, Math.min(requestedMs, remainingBackoffMs));
    this.onRetry({
      host: formatEmbeddingHost(this.baseUrl),
      attempt,
      maxAttempts: this.maxAttempts,
      delayMs,
      ...detail
    });
    await sleepEmbeddingRetry(delayMs);
    return remainingBackoffMs - delayMs;
  }

  // invariant: this race is the wall-clock backstop. It does NOT replace the
  // AbortController (still the primary mechanism that aborts and frees the
  // socket); it guarantees the awaited fetch settles even when undici never
  // honors the abort on a stalled connection. The rejection is shaped so the
  // caller's catch turns it into the existing "transport failed" surface.
  // see also: packages/core/src/embedding-recall/constants.ts:EMBEDDING_TRANSPORT_BACKSTOP_MARGIN_MS
  private async raceFetchAgainstBackstop(
    fetchPromise: Promise<Response>,
    backstopMs: number
  ): Promise<Response> {
    let backstopHandle: ReturnType<typeof setTimeout> | null = null;
    const backstop = new Promise<never>((_resolve, reject) => {
      backstopHandle = setTimeout(() => {
        reject(new EmbeddingTransportBackstopError(this.baseUrl, backstopMs));
      }, backstopMs);
      backstopHandle.unref?.();
    });
    try {
      return await Promise.race([fetchPromise, backstop]);
    } finally {
      if (backstopHandle !== null) {
        clearTimeout(backstopHandle);
      }
    }
  }
}

class EmbeddingTransportBackstopError extends Error {
  public constructor(baseUrl: string, backstopMs: number) {
    super(
      `Embedding request transport stalled past ${backstopMs}ms backstop for host ${formatEmbeddingHost(baseUrl)}.`
    );
    this.name = "EmbeddingTransportBackstopError";
  }
}

function isRetryableEmbeddingStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

// invariant: the backoff gap is NOT tied to the per-attempt abort signal — a
// per-attempt timeout is exactly the transient blip the retry must ride through,
// so a fired attempt-signal must not zero the recovery gap. total backoff is
// bounded by the caller's remaining budget, not by the abort.
// see also: packages/core/src/embedding-recall/openai-client.ts:OpenAIEmbeddingClient.fetchEmbeddingWithRetry
// see also: packages/core/src/embedding-recall/constants.ts:MAX_EMBEDDING_REQUEST_TOTAL_BACKOFF_MS
async function sleepEmbeddingRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) {
    return;
  }
  await new Promise<void>((resolve) => {
    const timeout = setTimeout(resolve, delayMs);
    timeout.unref?.();
  });
}

function defaultEmbeddingRetrySink(event: EmbeddingRetryEvent): void {
  console.warn(
    `Embedding request retry for host ${event.host} attempt ${event.attempt}/${event.maxAttempts} ` +
      `reason=${event.reason}${event.status === undefined ? "" : ` status=${event.status}`} ` +
      `backoff=${event.delayMs}ms`
  );
}

function formatEmbeddingTransportError(baseUrl: string, error: unknown): string {
  const causeCode =
    typeof error === "object" &&
    error !== null &&
    "cause" in error &&
    typeof (error as { readonly cause?: { readonly code?: unknown } }).cause?.code === "string"
      ? ` cause=${(error as { readonly cause: { readonly code: string } }).cause.code}`
      : "";
  return `Embedding request transport failed for host ${formatEmbeddingHost(baseUrl)}.${causeCode}`;
}

function formatEmbeddingHost(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "unknown";
  }
}

function normalizeBaseUrl(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}
