import {
  parseOfficialApiSignals
} from "@do-soul/alaya-soul";
import type {
  BenchRetryClassification,
  BenchSignalExtractor,
  CompileSeedExtractionConfig
} from "./compile-seed-types.js";

export const EXTRACTION_REQUEST_TIMEOUT_MS = 60_000;

// invariant: wall-clock tick guards against host suspend freezing the monotonic
// setTimeout. setInterval also rides the monotonic clock, but libuv catches up
// suppressed intervals on resume, so the wall-clock check fires within one
// tick after wake.
// see also: packages/soul/src/garden/wall-clock-timeout.ts WALL_CLOCK_TICK_MS
const EXTRACTION_WALL_CLOCK_TICK_MS = 5_000;

// invariant: bench retry policy is parity with pi-mono-extractor.ts. Both
// transports must spend up to 3 retries with jittered exponential backoff on
// recoverable failure modes (5xx / 429 / empty body / unknown transport) so a
// transient yunwu.ai burst does not silently demote the archive to the
// no-credentials fallback path. Timeouts retry exactly once. 4xx-non-429 and
// aborts never retry.
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

interface BenchHttpError {
  readonly classification: BenchRetryClassification;
  readonly retryable: boolean;
  readonly isTimeout: boolean;
  readonly cause: unknown;
}

function classifyBenchHttpError(
  error: unknown,
  status: number | null
): BenchHttpError {
  if (error instanceof Error && /abort/iu.test(error.name + error.message)) {
    // AbortController fired — could be operator abort or our own timeout
    // controller; the caller disambiguates via the timer flag.
    return {
      classification: "failure_aborted",
      retryable: false,
      isTimeout: false,
      cause: error
    };
  }
  if (status !== null) {
    if (status === 429 || (status >= 500 && status < 600)) {
      return {
        classification: "failure_max_retries",
        retryable: true,
        isTimeout: false,
        cause: error
      };
    }
    if (status >= 400 && status < 500) {
      return {
        classification: "failure_non_retryable_4xx",
        retryable: false,
        isTimeout: false,
        cause: error
      };
    }
  }
  // Unknown transport (DNS, connection reset, empty body): retry — the
  // dominant unobserved failure here resolves on the next request.
  return {
    classification: "failure_max_retries",
    retryable: true,
    isTimeout: false,
    cause: error
  };
}

/**
 * Live garden LLM delegate: OpenAI-compatible POST /chat/completions with a
 * JSON-object response format, temperature 0. Wraps the raw fetch in the same
 * retry-with-jitter loop as `createPiMonoExtractor` (3 retries on recoverable
 * failures, 1 retry on timeout, no retry on 4xx-non-429 / abort) so the
 * bench transport does not silently degrade to the fallback path on a
 * transient burst the production transport would have recovered from.
 *
 * `extractorMeta.retryCount` + `extractorMeta.retryClassification` surface
 * on success; on failure the thrown Error carries the same classification
 * in its `.cause` chain so dumpSeedExtractionFailureDiagnostic records the
 * terminal outcome.
 *
 * `deps.sleep` / `deps.random` are test seams so unit tests can drive the
 * jittered backoff without wall-clock sleeps.
 */
export function createGardenHttpExtractor(
  config: CompileSeedExtractionConfig,
  deps?: {
    readonly sleep?: (ms: number) => Promise<void>;
    readonly random?: () => number;
    readonly fetch?: typeof fetch;
  }
): BenchSignalExtractor {
  const sleepImpl =
    deps?.sleep ??
    ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const randomImpl = deps?.random ?? Math.random;
  const fetchImpl = deps?.fetch ?? fetch;
  return {
    async extract(input) {
      if (config.apiKey === null) {
        throw new Error("garden API key is unavailable");
      }
      let attempt = 0;
      let timeoutRetries = 0;
      let lastError: unknown = null;
      let lastClassification: BenchRetryClassification = "failure_max_retries";
      while (attempt <= BENCH_HTTP_MAX_RETRIES) {
        const controller = new AbortController();
        let timedOut = false;
        const budgetMs = input.timeoutMs ?? EXTRACTION_REQUEST_TIMEOUT_MS;
        const startedAt = Date.now();
        // invariant: abort alone is NOT enough. On Node 24 a stalled undici
        // socket does NOT honor controller.abort(): the timer fires, abort() is
        // called, but `await fetchImpl(...)` never settles and the worker hangs
        // forever (the repeated 500q extraction-fill wedge). `rejectOnTimeout`
        // lets the timers REJECT a settlement promise that we race against the
        // fetch, so the attempt settles within budget even when the fetch
        // ignores the abort. abort() is still called so abort-aware fetches
        // cancel cleanly and free the socket. The rejection carries `timedOut`
        // so it routes through the existing failure_timeout classification
        // below exactly as a real timer-driven abort would.
        // cross-file: this MUST stay behaviorally identical in timeout
        // *semantics* to packages/soul/src/garden/wall-clock-timeout.ts
        // withWallClockTimeout (the two transports diverged once and that
        // divergence caused this hang); the bench surfaces an untyped Error
        // since classification keys on the `timedOut` flag, not the error type.
        let rejectSettlement: ((error: Error) => void) | null = null;
        const timeoutSettlement = new Promise<never>((_resolve, reject) => {
          rejectSettlement = reject;
        });
        const fireTimeout = (): void => {
          if (timedOut) {
            return;
          }
          timedOut = true;
          controller.abort();
          rejectSettlement?.(
            new Error(
              `garden extraction transport stalled past ${budgetMs}ms budget`
            )
          );
        };
        // invariant: .unref?.() so a live backstop timer does not pin the
        // event loop / block process exit mid-extract; finally-clear + the
        // awaiting caller make it redundant on the happy path.
        // see also: packages/core/src/embedding-recall/openai-client.ts:OpenAIEmbeddingClient.fetchEmbeddingWithRetry
        const timer = setTimeout(fireTimeout, budgetMs);
        timer.unref?.();
        // invariant: wall-clock fallback. setTimeout is paused during host
        // suspend; setInterval catches up on resume and the elapsed check
        // detects budget overrun within one tick.
        const wallClockTimer = setInterval(() => {
          if (Date.now() - startedAt >= budgetMs) {
            fireTimeout();
          }
        }, EXTRACTION_WALL_CLOCK_TICK_MS);
        wallClockTimer.unref?.();
        // invariant: an operator abort MUST settle the race too — abort() alone
        // does not settle for an abort-ignoring stalled socket, so without this
        // the attempt would wait the full budget and then misclassify as
        // failure_timeout. We do NOT set `timedOut`, so the catch routes this
        // through the failure_aborted branch (never retried), surfacing the
        // cancel intent promptly. cross-file: withWallClockTimeout
        // settleOperatorAbort.
        const onOperatorAbort = (): void => {
          controller.abort();
          rejectSettlement?.(new Error("garden extraction operator aborted"));
        };
        if (input.abortSignal !== undefined) {
          if (input.abortSignal.aborted) {
            onOperatorAbort();
          } else {
            input.abortSignal.addEventListener("abort", onOperatorAbort);
          }
        }
        let attemptSettled = false;
        try {
          const fetchPromise = fetchImpl(`${config.providerUrl}/chat/completions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              authorization: `Bearer ${config.apiKey}`
            },
            body: JSON.stringify({
              model: config.model,
              temperature: 0,
              // invariant: stream:true is REQUIRED, not an optimization. yunwu.ai
              // + gpt-5.4-mini returns chat/completions content ONLY as an SSE
              // delta stream when stream:true; a non-stream request answers with
              // an EMPTY SSE body (`data: [DONE]\n\n` only), which permanently
              // wedged the 500q extraction-fill. We parse the SSE body below.
              // see: .do-it/findings/garden-sse-streaming-rootcause.md
              stream: true,
              response_format: { type: "json_object" },
              messages: [
                { role: "system", content: input.systemPrompt },
                { role: "user", content: input.userPrompt }
              ]
            }),
            signal: controller.signal
          });
          // invariant: timeout/operator-abort may settle the outer attempt
          // before the abandoned fetch rejects. That late rejection must not
          // surface as an unhandledRejection. If a rejection appears only
          // after the attempt settled WITHOUT an abort, keep it visible because
          // it is unexpected.
          void fetchPromise.catch((error: unknown) => {
            if (!attemptSettled || controller.signal.aborted) {
              return;
            }
            console.warn(
              "bench-runner/garden-http-extractor: fetch rejected after outer settlement",
              {
                attempt,
                error
              }
            );
          });
          const response = await Promise.race([fetchPromise, timeoutSettlement]);
          if (!response.ok) {
            const err = new Error(
              `garden extraction HTTP ${response.status} ${response.statusText}`
            );
            (err as { status?: number }).status = response.status;
            throw err;
          }
          // invariant: the body read MUST stay under the SAME wall-clock
          // backstop as the fetch. `response.text()` on a mid-stream STALLED
          // socket can hang exactly like the original abort-ignoring fetch
          // hang (commits a2d3047 + 34645f1); racing it against
          // timeoutSettlement keeps the attempt inside budget. The abandoned
          // body-read promise must not surface as an unhandledRejection after
          // the outer attempt already settled; timeout/operator-abort paths
          // intentionally abandon it, while other post-settlement rejections
          // remain visible as unexpected.
          const bodyTextPromise = response.text();
          void bodyTextPromise.catch((error: unknown) => {
            if (!attemptSettled || controller.signal.aborted) {
              return;
            }
            console.warn(
              "bench-runner/garden-http-extractor: body read rejected after outer settlement",
              {
                attempt,
                error
              }
            );
          });
          const bodyText = await Promise.race([
            bodyTextPromise,
            timeoutSettlement
          ]);
          const content = extractContentFromChatCompletionBody(
            bodyText,
            response.headers.get("content-type")
          );
          if (typeof content !== "string" || content.trim().length === 0) {
            throw new Error("garden extraction returned no content");
          }
          // invariant: a NON-EMPTY but unparseable body must fail loud, NEVER
          // cache. A provider/proxy that delivers a PARTIAL SSE body then
          // cleanly closes the socket makes `response.text()` RESOLVE with the
          // partial bytes (no stall -> the wall-clock backstop does not fire);
          // the SSE parser keeps the valid early deltas and silently skips the
          // truncated final frame, yielding non-empty-but-invalid content like
          // `{\"signals\":[{\"a\"`. The empty-content guard passes (non-empty), so
          // without this gate the poison body returns success and
          // createCachingSignalExtractor writes it to a git-tracked cache shard
          // as a permanent 0-seed "success". We validate through the SAME
          // downstream consumer the seed path uses (parseOfficialApiSignals,
          // which strict-parses then element-wise salvages a recoverable
          // envelope and THROWS only on a genuinely unparseable one) so a
          // merely-recoverable body is not spuriously rejected and validity
          // stays consistent across paths. This mirrors production
          // pi-mono-extractor's parseOrRecoverJson -> invalid_json throw. The
          // throw routes through the catch below: no HTTP status -> unknown
          // transport -> classifyBenchHttpError marks it retryable, so it
          // retries then fails loud (never cached).
          // see: .do-it/findings/garden-sse-streaming-rootcause.md
          try {
            parseOfficialApiSignals(content);
          } catch (parseError) {
            throw new Error(
              `garden extraction returned unparseable content: ${
                parseError instanceof Error
                  ? parseError.message
                  : String(parseError)
              }`
            );
          }
          return {
            rawJson: content,
            extractorMeta: {
              recoveryKind: "none",
              retryCount: attempt,
              retryClassification:
                attempt === 0 ? "success_first_try" : "success_after_retry"
            }
          };
        } catch (error) {
          attemptSettled = true;
          lastError = error;
          const status = readStatusFromBenchError(error);
          // Operator abort: never retry.
          if (input.abortSignal?.aborted === true && !timedOut) {
            lastClassification = "failure_aborted";
            throw wrapBenchTransportError(error, lastClassification, attempt);
          }
          if (timedOut) {
            // Timer-driven abort = timeout. Bounded retry — at most once.
            lastClassification = "failure_timeout";
            if (timeoutRetries >= BENCH_HTTP_MAX_TIMEOUT_RETRIES) {
              throw wrapBenchTransportError(error, lastClassification, attempt);
            }
            timeoutRetries += 1;
            if (attempt >= BENCH_HTTP_MAX_RETRIES) {
              lastClassification = "failure_max_retries";
              throw wrapBenchTransportError(error, lastClassification, attempt);
            }
            const jitterMs = computeBenchJitterMs(attempt, randomImpl);
            attempt += 1;
            await sleepImpl(jitterMs);
            continue;
          }
          const classified = classifyBenchHttpError(error, status);
          if (!classified.retryable) {
            lastClassification = classified.classification;
            throw wrapBenchTransportError(error, lastClassification, attempt);
          }
          if (attempt >= BENCH_HTTP_MAX_RETRIES) {
            lastClassification = "failure_max_retries";
            throw wrapBenchTransportError(error, lastClassification, attempt);
          }
          const jitterMs = computeBenchJitterMs(attempt, randomImpl);
          attempt += 1;
          await sleepImpl(jitterMs);
        } finally {
          attemptSettled = true;
          clearTimeout(timer);
          clearInterval(wallClockTimer);
          if (input.abortSignal !== undefined) {
            input.abortSignal.removeEventListener("abort", onOperatorAbort);
          }
        }
      }
      // Defensive — loop always returns or throws.
      throw wrapBenchTransportError(lastError, lastClassification, attempt);
    }
  };
}

// invariant: OpenAI-compatible chat/completions body parser shared by the
// stream and back-compat non-stream shapes. Pure (no fetch) so it is unit
// testable. yunwu.ai + gpt-5.4-mini now answers ONLY with SSE delta chunks
// (`data: {...delta...}\n\n ... data: [DONE]\n\n`); a compliant provider may
// still answer with plain JSON (`choices[0].message.content`). We accept
// both. A blank line or SSE comment (`:`) is ignored; a chunk that fails
// JSON.parse is skipped defensively (partial keep-alive noise) rather than
// thrown — the empty-content guard in the caller still classifies a
// content-free stream as a failure, so silent corruption cannot pass.
// see: .do-it/findings/garden-sse-streaming-rootcause.md
export function extractContentFromChatCompletionBody(
  bodyText: string,
  contentType: string | null
): string {
  const trimmedBody = bodyText.trim();
  const isSse =
    (contentType !== null &&
      contentType.toLowerCase().includes("text/event-stream")) ||
    trimmedBody.startsWith("data:");
  if (!isSse) {
    // Back-compat: a compliant provider returns plain JSON.
    const payload = JSON.parse(bodyText) as {
      readonly choices?: readonly {
        readonly message?: { readonly content?: unknown };
      }[];
    };
    const content = payload.choices?.[0]?.message?.content;
    return typeof content === "string" ? content : "";
  }
  let accumulated = "";
  for (const rawLine of bodyText.split("\n")) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith(":")) {
      // Blank line (SSE event boundary) or comment / keep-alive ping.
      continue;
    }
    if (!line.startsWith("data:")) {
      continue;
    }
    const chunkText = line.slice("data:".length).trim();
    if (chunkText === "[DONE]") {
      break;
    }
    let chunk: {
      readonly choices?: readonly {
        readonly delta?: { readonly content?: unknown };
        readonly message?: { readonly content?: unknown };
      }[];
    };
    try {
      chunk = JSON.parse(chunkText) as typeof chunk;
    } catch {
      // Partial / non-JSON keep-alive noise — skip defensively. The caller's
      // empty-content guard is the real failure gate.
      continue;
    }
    const choice = chunk.choices?.[0];
    const deltaContent = choice?.delta?.content;
    const messageContent = choice?.message?.content;
    if (typeof deltaContent === "string") {
      accumulated += deltaContent;
    } else if (typeof messageContent === "string") {
      // Tolerate a chunk carrying a full message.content (some providers emit
      // the whole assistant message in a single SSE frame instead of deltas).
      // Prefer delta when both are present in one frame so a provider that
      // echoes the running message alongside each delta is not double-counted.
      accumulated += messageContent;
    }
  }
  return accumulated;
}

// invariant: surface retry_classification + retry_count via the .cause chain
// so dumpSeedExtractionFailureDiagnostic can pluck them without re-deriving
// from the message. Tests assert on `.benchRetry` for the dump shape.
function wrapBenchTransportError(
  cause: unknown,
  classification: BenchRetryClassification,
  retryCount: number
): Error {
  const message =
    cause instanceof Error
      ? cause.message
      : `garden extraction failed: ${String(cause)}`;
  const wrapped = new Error(message);
  (wrapped as { cause?: unknown }).cause = cause;
  (wrapped as { benchRetry?: unknown }).benchRetry = {
    retryCount,
    retryClassification: classification
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
