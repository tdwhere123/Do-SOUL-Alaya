import { ProviderChatCompletionError } from "./errors.js";
import {
  providerFailureIdentityFromBody,
  readOptionalProviderFailureIdentity
} from "./failure-identity.js";
import {
  inspectProviderChatCompletionResponse,
  ProviderResponseInspectionError,
  type ProviderResponseInspectionReason
} from "./inspect-response.js";
import { assertAllowedProviderChatUrl } from "./provider-url-guard.js";
import {
  buildProviderChatRequestInit,
  providerChatCompletionsUrl
} from "./request-body.js";
import type {
  ProviderChatCompletionRequest,
  ProviderChatCompletionResult
} from "./types.js";

export const DEFAULT_PROVIDER_CHAT_COMPLETION_TIMEOUT_MS = 10_000;

const INTERNAL_TIMEOUT = Object.freeze({ source: "timeout" as const });
const CALLER_ABORT = Object.freeze({ source: "caller" as const });

export async function fetchProviderChatCompletion(
  request: ProviderChatCompletionRequest
): Promise<ProviderChatCompletionResult> {
  const controller = new AbortController();
  const onAbort = (): void => {
    controller.abort(CALLER_ABORT);
  };
  bindAbort(request.abortSignal, onAbort);
  const timer = startTimeout(request.timeoutMs, controller);
  let knownStatus: number | null = null;
  try {
    return await settleUnlessAborted(
      runProviderChatRequest(request, controller.signal, (status) => {
        knownStatus = status;
      }),
      controller.signal
    );
  } catch (error) {
    throw normalizeTransportError(error, request.abortSignal, controller.signal, knownStatus);
  } finally {
    if (timer !== null) clearTimeout(timer);
    request.abortSignal?.removeEventListener("abort", onAbort);
  }
}

async function runProviderChatRequest(
  request: ProviderChatCompletionRequest,
  signal: AbortSignal,
  observeStatus: (status: number) => void
): Promise<ProviderChatCompletionResult> {
  const response = await postChatCompletion(request, signal);
  observeStatus(response.status);
  await throwIfHttpError(response);
  const bodyText = await readBody(response);
  return inspectBody(request, bodyText, response.headers.get("content-type"), response.status);
}

async function postChatCompletion(
  request: ProviderChatCompletionRequest,
  signal: AbortSignal
): Promise<Response> {
  const url = providerChatCompletionsUrl(request.providerUrl);
  assertAllowedProviderChatUrl(url);
  const fetchImpl = request.fetchImpl ?? fetch;
  // RequestInit must not carry the caller abortSignal; timeout abort would then
  // be indistinguishable from an operator abort.
  return await fetchImpl(
    url,
    { ...buildProviderChatRequestInit(request), signal }
  );
}

async function throwIfHttpError(response: Response): Promise<void> {
  if (response.ok) return;
  // Status is already known; diagnostic identity is optional and must not replace it.
  const identity = await readOptionalProviderFailureIdentity(response);
  throw new ProviderChatCompletionError(
    `provider chat completion failed: HTTP ${response.status} ${response.statusText}`,
    "http_error",
    response.status,
    identity === undefined ? undefined : { identity }
  );
}

async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch (error) {
    throw new ProviderChatCompletionError(
      "provider chat completion body read failed",
      "body_read_error",
      response.status,
      { cause: error }
    );
  }
}

function inspectBody(
  request: ProviderChatCompletionRequest,
  bodyText: string,
  contentType: string | null,
  httpStatus: number
): ProviderChatCompletionResult {
  try {
    return inspectProviderChatCompletionResponse(bodyText, contentType, httpStatus, {
      sseCompletionPolicy: request.sseCompletionPolicy
    });
  } catch (error) {
    throw new ProviderChatCompletionError(
      error instanceof Error ? error.message : "provider chat completion response inspect failed",
      "response_parse_error",
      httpStatus,
      {
        cause: error,
        identity: providerFailureIdentityFromBody(bodyText),
        inspectionReason: inspectionReasonOf(error)
      }
    );
  }
}

function bindAbort(
  signal: AbortSignal | undefined,
  onAbort: () => void
): void {
  if (signal === undefined) return;
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort);
}

function startTimeout(
  timeoutMs: number | undefined,
  controller: AbortController
): ReturnType<typeof setTimeout> | null {
  const resolvedMs = resolveProviderChatTimeoutMs(timeoutMs);
  const timer = setTimeout(() => controller.abort(INTERNAL_TIMEOUT), resolvedMs);
  timer.unref?.();
  return timer;
}

function resolveProviderChatTimeoutMs(timeoutMs: number | undefined): number {
  return timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0
    ? timeoutMs
    : DEFAULT_PROVIDER_CHAT_COMPLETION_TIMEOUT_MS;
}

async function settleUnlessAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) {
    void work.catch(() => undefined);
    throw abortCause(signal);
  }
  let onAbort: (() => void) | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_, reject) => {
        onAbort = () => reject(abortCause(signal));
        signal.addEventListener("abort", onAbort, { once: true });
      })
    ]);
  } catch (error) {
    if (signal.aborted) void work.catch(() => undefined);
    throw error;
  } finally {
    if (onAbort !== undefined) signal.removeEventListener("abort", onAbort);
  }
}

function abortCause(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("aborted");
  error.name = "AbortError";
  return error;
}

function normalizeTransportError(
  error: unknown,
  callerSignal: AbortSignal | undefined,
  requestSignal: AbortSignal,
  knownStatus: number | null
): Error {
  if (callerSignal?.aborted === true || requestSignal.aborted) {
    return toCancellationError(error, callerSignal, requestSignal, knownStatus);
  }
  if (error instanceof ProviderChatCompletionError) return error;
  return new ProviderChatCompletionError(
    "provider chat completion transport failed",
    "network_error",
    null,
    { cause: error }
  );
}

function toCancellationError(
  cause: unknown,
  callerSignal: AbortSignal | undefined,
  requestSignal: AbortSignal,
  knownStatus: number | null
): ProviderChatCompletionError {
  const kind = callerSignal?.aborted === true || requestSignal.reason === CALLER_ABORT
    ? "aborted"
    : "timeout";
  if (cause instanceof ProviderChatCompletionError && cause.kind === kind) {
    return cause;
  }
  return new ProviderChatCompletionError(
    kind === "timeout"
      ? "provider chat completion timed out"
      : "provider chat completion aborted",
    kind,
    cause instanceof ProviderChatCompletionError ? cause.httpStatus : knownStatus,
    { cause }
  );
}

function inspectionReasonOf(error: unknown): ProviderResponseInspectionReason {
  return error instanceof ProviderResponseInspectionError ? error.reason : "parse";
}
