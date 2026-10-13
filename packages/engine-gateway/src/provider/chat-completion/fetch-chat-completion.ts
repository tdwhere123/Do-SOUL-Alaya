import { ProviderChatCompletionError } from "./errors.js";
import type { Dispatcher } from "undici";
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
import { createProviderTransport } from "./provider-transport.js";
import { CALLER_ABORT, createProviderChatDeadline, resolveProviderChatTimeoutMs } from "./request-deadline.js";
import {
  MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES,
  MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES,
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

export { DEFAULT_PROVIDER_CHAT_COMPLETION_TIMEOUT_MS } from "./request-deadline.js";

export async function fetchProviderChatCompletion(
  request: ProviderChatCompletionRequest
): Promise<ProviderChatCompletionResult> {
  const deadline = createProviderChatDeadline(request);
  let knownStatus: number | null = null;
  let responseSnapshot: (() => ProviderHttpResponseEvidence) | undefined;
  try {
    return await deadline.settle(
      runProviderChatRequest(request, deadline.signal,
        (status) => { knownStatus = status; },
        (snapshot) => { responseSnapshot = snapshot; })
    );
  } catch (error) {
    throw normalizeTransportError(error, request.abortSignal, deadline.signal,
      knownStatus, responseSnapshot?.());
  } finally {
    deadline.dispose();
  }
}

async function runProviderChatRequest(
  request: ProviderChatCompletionRequest,
  signal: AbortSignal,
  observeStatus: (status: number) => void,
  observeResponse: (snapshot: () => ProviderHttpResponseEvidence) => void
): Promise<ProviderChatCompletionResult> {
  const url = providerChatCompletionsUrl(request.providerUrl, request.env);
  const transport = await createProviderTransport(url, request, signal);
  let completed = false;
  try {
    const response = await postChatCompletion(request, signal, url, transport.dispatcher);
    const result = await readChatCompletionResponse(request, response, observeStatus, observeResponse);
    completed = true;
    return result;
  } finally {
    if (transport.owned) await (completed ? transport.dispatcher.close() : transport.dispatcher.destroy());
  }
}

async function readChatCompletionResponse(
  request: ProviderChatCompletionRequest,
  response: Response,
  observeStatus: (status: number) => void,
  observeResponse: (snapshot: () => ProviderHttpResponseEvidence) => void
): Promise<ProviderChatCompletionResult> {
  observeStatus(response.status);
  if (isChatSemanticRequestProfile(request.profile) || isInternProviderRequestProfile(request.profile)) {
    let bodyText: string;
    let evidence: ProviderHttpResponseEvidence;
    const boundedError = !response.ok;
    const intern = isInternProviderRequestProfile(request.profile);
    const failureCap = intern ? MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES : PROVIDER_FAILURE_BODY_DIGEST_BYTES;
    const cap = boundedError ? failureCap : MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES;
    ({ bodyText, evidence } = await readProviderResponseWithEvidence(
      response, observeResponse, cap, cap
    ));
    if (!response.ok) {
      throw new ProviderChatCompletionError(
        `provider chat completion failed: HTTP ${response.status} ${response.statusText}`,
        "http_error", response.status,
        { identity: providerFailureIdentityFromBody(bodyText), httpResponse: evidence }
      );
    }
    assertCompleteResponseEvidence(evidence, response.status);
    return inspectBody(
      request, bodyText, evidence.contentType, response.status,
      publishedSuccessEvidence(evidence, intern || request.retainHttpResponseEvidence === true)
    );
  }
  await throwIfHttpError(response);
  const { bodyText, evidence } = await readProviderResponseWithEvidence(
    response, observeResponse, MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES, MAX_COMPLETE_PROVIDER_HTTP_RESPONSE_BYTES
  );
  assertCompleteResponseEvidence(evidence, response.status);
  return inspectBody(
    request, bodyText, evidence.contentType, response.status,
    request.retainHttpResponseEvidence === true ? evidence : undefined
  );
}

function assertCompleteResponseEvidence(evidence: ProviderHttpResponseEvidence, httpStatus: number): void {
  if (!evidence.bodyComplete) {
    throw new ProviderChatCompletionError("provider response exceeds its finite read-byte limit",
      "response_parse_error", httpStatus, { inspectionReason: "schema", httpResponse: evidence });
  }
}

/** No-retain chat-semantic results still publish the 64KiB witness prefix after an 8MiB complete read. */
function publishedSuccessEvidence(
  evidence: ProviderHttpResponseEvidence,
  retainFull: boolean
): ProviderHttpResponseEvidence {
  if (retainFull) return evidence;
  const retained = Buffer.from(evidence.bodyBase64, "base64");
  if (retained.byteLength <= MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES) return evidence;
  return Object.freeze({
    contentType: evidence.contentType,
    bodyBase64: retained.subarray(0, MAX_RETAINED_PROVIDER_HTTP_RESPONSE_BYTES).toString("base64"),
    bodyByteLength: evidence.bodyByteLength,
    bodySha256: evidence.bodySha256,
    bodyTruncated: true,
    bodyComplete: evidence.bodyComplete
  });
}

async function postChatCompletion(
  request: ProviderChatCompletionRequest,
  signal: AbortSignal,
  url: string,
  baseDispatcher: Dispatcher
): Promise<Response> {
  const fetchImpl = request.fetchImpl ?? fetch;
  // Timeout composition owns no resources; its lifecycle follows the base owner.
  const timeoutMs = Math.ceil(resolveProviderChatTimeoutMs(request.timeoutMs));
  const dispatcher = (isInternProviderRequestProfile(request.profile) ||
    isChatSemanticRequestProfile(request.profile) && request.retainHttpResponseEvidence === true)
    ? baseDispatcher.compose(dispatch => (options, handler) => dispatch({
      ...options, headersTimeout: timeoutMs, bodyTimeout: timeoutMs
    }, handler)) : baseDispatcher;
  // RequestInit must not carry the caller abortSignal; timeout abort would then
  // be indistinguishable from an operator abort.
  return await fetchImpl(
    url,
    { ...buildProviderChatRequestInit(request), signal, redirect: "error",
      ...(dispatcher === undefined ? {} : { dispatcher }) }
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
