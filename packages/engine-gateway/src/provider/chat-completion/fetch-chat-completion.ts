import { ProviderChatCompletionError } from "./errors.js";
import { inspectProviderChatCompletionResponse } from "./inspect-response.js";
import {
  buildProviderChatRequestInit,
  providerChatCompletionsUrl
} from "./request-body.js";
import type {
  ProviderChatCompletionRequest,
  ProviderChatCompletionResult
} from "./types.js";

export async function fetchProviderChatCompletion(
  request: ProviderChatCompletionRequest
): Promise<ProviderChatCompletionResult> {
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  bindAbort(request.abortSignal, onAbort, controller);
  const timer = startTimeout(request.timeoutMs, controller);
  try {
    const response = await postChatCompletion(request, controller.signal);
    const bodyText = await readBody(response);
    if (!response.ok) {
      throw new ProviderChatCompletionError(
        `provider chat completion failed: HTTP ${response.status} ${response.statusText}`,
        "http_error",
        response.status
      );
    }
    return inspectProviderChatCompletionResponse(
      bodyText,
      response.headers.get("content-type"),
      response.status
    );
  } catch (error) {
    throw normalizeTransportError(error, request.abortSignal);
  } finally {
    if (timer !== null) clearTimeout(timer);
    request.abortSignal?.removeEventListener("abort", onAbort);
  }
}

async function postChatCompletion(
  request: ProviderChatCompletionRequest,
  signal: AbortSignal
): Promise<Response> {
  const fetchImpl = request.fetchImpl ?? fetch;
  return await fetchImpl(
    providerChatCompletionsUrl(request.providerUrl),
    { ...buildProviderChatRequestInit(request), signal }
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

function bindAbort(
  signal: AbortSignal | undefined,
  onAbort: () => void,
  controller: AbortController
): void {
  if (signal === undefined) return;
  if (signal.aborted) controller.abort();
  else signal.addEventListener("abort", onAbort);
}

function startTimeout(
  timeoutMs: number | undefined,
  controller: AbortController
): ReturnType<typeof setTimeout> | null {
  if (timeoutMs === undefined) return null;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  timer.unref?.();
  return timer;
}

function normalizeTransportError(
  error: unknown,
  abortSignal: AbortSignal | undefined
): Error {
  if (error instanceof ProviderChatCompletionError) return error;
  if (abortSignal?.aborted === true) {
    return new ProviderChatCompletionError("provider chat completion aborted", "aborted", null, {
      cause: error
    });
  }
  if (error instanceof Error && !isLikelyFetchFailure(error)) return error;
  return new ProviderChatCompletionError(
    "provider chat completion transport failed",
    "network_error",
    null,
    { cause: error }
  );
}

function isLikelyFetchFailure(error: Error): boolean {
  return error.name === "TypeError" || error.name === "AbortError";
}
