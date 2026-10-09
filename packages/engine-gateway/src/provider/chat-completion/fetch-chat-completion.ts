import { ProviderChatCompletionError } from "./errors.js";
import { getGlobalDispatcher } from "undici";
import { AlayaError, isChatSemanticRequestProfile, isInternProviderRequestProfile } from "@do-soul/alaya-protocol";
import {
  PROVIDER_FAILURE_BODY_DIGEST_BYTES,
  providerFailureIdentityFromBody,
  readOptionalProviderFailureIdentity
} from "./failure-identity.js";
import {
  inspectProviderChatCompletionResponse,
  ProviderResponseInspectionError,
  type ProviderResponseInspectionReason
} from "./inspect-response.js";
import { assertAllowedProviderChatUrlResolved } from "./provider-url-guard.js";
import {
  MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES,
  readProviderResponseWithEvidence
} from "./response-evidence.js";
import {
  buildProviderChatRequestInit,
  providerChatCompletionsUrl
} from "./request-body.js";
import type {
  ProviderChatCompletionRequest,
  ProviderChatCompletionResult,
  ProviderHttpResponseEvidence
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
  let responseSnapshot: (() => ProviderHttpResponseEvidence) | undefined;
  try {
    return await settleUnlessAborted(
      runProviderChatRequest(request, controller.signal,
        (status) => { knownStatus = status; },
        (snapshot) => { responseSnapshot = snapshot; }),
      controller.signal
    );
  } catch (error) {
    throw normalizeTransportError(error, request.abortSignal, controller.signal,
      knownStatus, responseSnapshot?.());
  } finally {
    if (timer !== null) clearTimeout(timer);
    request.abortSignal?.removeEventListener("abort", onAbort);
  }
}

async function runProviderChatRequest(
  request: ProviderChatCompletionRequest,
  signal: AbortSignal,
  observeStatus: (status: number) => void,
  observeResponse: (snapshot: () => ProviderHttpResponseEvidence) => void
): Promise<ProviderChatCompletionResult> {
  const response = await postChatCompletion(request, signal);
  observeStatus(response.status);
  if (isChatSemanticRequestProfile(request.profile) || isInternProviderRequestProfile(request.profile)) {
    let bodyText: string;
    let evidence: ProviderHttpResponseEvidence;
    const boundedError = !response.ok;
    const intern = isInternProviderRequestProfile(request.profile);
    const failureCap = intern ? MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES : PROVIDER_FAILURE_BODY_DIGEST_BYTES;
    ({ bodyText, evidence } = await readProviderResponseWithEvidence(
      response, observeResponse,
      boundedError ? failureCap
        : intern || request.retainHttpResponseEvidence === true ? MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES : undefined,
      // Cancellation threshold only. Received bytes beyond the retained prefix stay in the digest.
      boundedError ? failureCap : intern || request.retainHttpResponseEvidence === true
        ? MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES : undefined
    ));
    if (!response.ok) {
      throw new ProviderChatCompletionError(
        `provider chat completion failed: HTTP ${response.status} ${response.statusText}`,
        "http_error", response.status,
        { identity: providerFailureIdentityFromBody(bodyText), httpResponse: evidence }
      );
    }
    assertCompleteResponseEvidence(evidence, response.status);
    return inspectBody(request, bodyText, evidence.contentType, response.status, evidence);
  }
  await throwIfHttpError(response);
  if (request.retainHttpResponseEvidence === true) {
    const { bodyText, evidence } = await readProviderResponseWithEvidence(
      response, observeResponse, MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES, MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES
    );
    assertCompleteResponseEvidence(evidence, response.status);
    return inspectBody(request, bodyText, evidence.contentType, response.status, evidence);
  }
  const bodyText = await readBody(response);
  return inspectBody(request, bodyText, response.headers.get("content-type"), response.status);
}

function assertCompleteResponseEvidence(evidence: ProviderHttpResponseEvidence, httpStatus: number): void {
  if (!evidence.bodyComplete) {
    throw new ProviderChatCompletionError("provider response exceeds its finite read-byte limit",
      "response_parse_error", httpStatus, { inspectionReason: "schema", httpResponse: evidence });
  }
}

async function postChatCompletion(
  request: ProviderChatCompletionRequest,
  signal: AbortSignal
): Promise<Response> {
  const url = providerChatCompletionsUrl(request.providerUrl, request.env);
  await assertAllowedProviderChatUrlResolved(url, request.env);
  const fetchImpl = request.fetchImpl ?? fetch;
  // The runtime owns the underlying dispatcher and its proxy policy/pools. This
  // request-local composition owns no clients and must never close that dispatcher.
  const timeoutMs = Math.ceil(resolveProviderChatTimeoutMs(request.timeoutMs));
  const dispatcher = (isInternProviderRequestProfile(request.profile) ||
    isChatSemanticRequestProfile(request.profile) && request.retainHttpResponseEvidence === true)
    ? getGlobalDispatcher().compose(dispatch => (options, handler) => dispatch({
      ...options, headersTimeout: timeoutMs, bodyTimeout: timeoutMs
    }, handler)) : undefined;
  // RequestInit must not carry the caller abortSignal; timeout abort would then
  // be indistinguishable from an operator abort.
  return await fetchImpl(
    url,
    { ...buildProviderChatRequestInit(request), signal, redirect: "error",
      // Node's older undici-types compose overload differs from the supported
      // runtime Dispatcher contract shared by Node and this direct dependency.
      ...(dispatcher === undefined ? {} : { dispatcher: dispatcher as unknown as RequestInit["dispatcher"] }) }
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
  httpStatus: number,
  evidence?: ProviderHttpResponseEvidence
): ProviderChatCompletionResult {
  try {
    const result = inspectProviderChatCompletionResponse(bodyText, contentType, httpStatus, {
      sseCompletionPolicy: request.sseCompletionPolicy
    });
    if (isInternProviderRequestProfile(request.profile) && result.completion?.mode !== "json") {
      throw new ProviderResponseInspectionError("Intern JSON profile received unexpected streaming framing", "schema");
    }
    return evidence === undefined ? result : { ...result, httpResponse: evidence };
  } catch (error) {
    throw new ProviderChatCompletionError(
      error instanceof Error ? error.message : "provider chat completion response inspect failed",
      "response_parse_error",
      httpStatus,
      {
        cause: error,
        identity: providerFailureIdentityFromBody(bodyText),
        inspectionReason: inspectionReasonOf(error),
        httpResponse: evidence
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
  knownStatus: number | null,
  knownResponse: ProviderHttpResponseEvidence | undefined
): Error {
  if (callerSignal?.aborted === true || requestSignal.aborted) {
    return toCancellationError(error, callerSignal, requestSignal, knownStatus, knownResponse);
  }
  if (error instanceof ProviderChatCompletionError || error instanceof AlayaError) return error;
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
  knownStatus: number | null,
  knownResponse: ProviderHttpResponseEvidence | undefined
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
    { cause, httpResponse: knownResponse ?? (cause instanceof ProviderChatCompletionError
      ? cause.httpResponse : undefined) }
  );
}

function inspectionReasonOf(error: unknown): ProviderResponseInspectionReason {
  return error instanceof ProviderResponseInspectionError ? error.reason : "parse";
}
