import { AlayaError } from "@do-soul/alaya-protocol";
import http from "node:http";
import https from "node:https";
import { Readable } from "node:stream";
import { normalizeGeminiEndpoint } from "../../provider/gemini-endpoint.js";
import { isNativeGeminiRequestProfile } from "../../extraction/request-profile.js";
import type {
  BenchProviderUsage,
  BenchSignalExtractor,
  BenchTransportFailureKind,
  BenchTransportFailurePhase,
  CompileSeedExtractionConfig
} from "../compile-seed-types.js";
import {
  decodeGeminiGenerateContent,
  encodeGeminiGenerateContent,
  GeminiProviderEnvelopeError,
  geminiUsage,
  parseGeminiGenerateContentBody,
  record
} from "../../extraction/fill/batch/native-codec.js";
import { readBoundedResponse } from "../../extraction/fill/batch/http.js";
import { assertRequiredRequestProfile, resolveExtractionTransportRoute } from
  "../../extraction/transport-route.js";
import { markGardenHttpFailure, toBenchTransportFailureAttempt } from
  "./garden-http-failure-attempt.js";
import { wrapGardenHttpTransportError } from "./garden-http-terminal-error.js";
import { extractValidGardenHttpContent } from "./garden-http-response-validation.js";
import { resolveExtractionRequestTimeoutMs } from "./output-token-retry.js";

const MAX_GEMINI_RESPONSE_BYTES = 32 * 1024 * 1024;
/** Complete-source TTFB can exceed the output-token quantum; thinking SSE keeps the socket alive. */
export const GEMINI_INTERACTIVE_TIMEOUT_FLOOR_MS = 15 * 60_000;
const defaultFetch = globalThis.fetch;
const responseEvidence = new WeakMap<object, Readonly<{ rawBody: string; finishReason: string | null }>>();
export function readGeminiFailureResponse(error: unknown) {
  return typeof error === "object" && error !== null ? responseEvidence.get(error) : undefined;
}
type ExtractInput = Parameters<BenchSignalExtractor["extract"]>[0];

/** Interactive work is one explicitly bounded attempt; retries belong to its caller. */
export function createGeminiHttpExtractor(
  config: CompileSeedExtractionConfig,
  fetchImpl: typeof fetch = fetch
): BenchSignalExtractor {
  return { extract: (input) => extractGeminiOnce(config, fetchImpl, input) };
}

async function extractGeminiOnce(
  config: CompileSeedExtractionConfig,
  fetchImpl: typeof fetch,
  input: ExtractInput
): ReturnType<BenchSignalExtractor["extract"]> {
  const { url, body, timeoutMs } = prepareGeminiRequest(config, input);
  if (config.apiKey === null || config.apiKey.trim().length === 0) {
    throw new Error("garden API key is unavailable");
  }
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = input.abortSignal === undefined ? timeout : AbortSignal.any([input.abortSignal, timeout]);
  signal.throwIfAborted();
  await input.onTransportAttempt?.(signal);
  signal.throwIfAborted();
  const attempt: GeminiAttempt = { phase: "request", kind: "network_error", status: null };
  try {
    const response = await dispatchGeminiHttp(fetchImpl, url, {
      method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", "x-goog-api-key": config.apiKey }, body
    });
    attempt.status = response.status;
    if (!response.ok) {
      attempt.phase = "response_status";
      attempt.kind = "http_error";
      attempt.rawBody = await readBoundedResponse(response, MAX_GEMINI_RESPONSE_BYTES);
      try { attempt.usage = geminiUsage(record(JSON.parse(attempt.rawBody))); } catch { /* HTTP status remains authoritative. */ }
      throw new Error(`Gemini HTTP ${response.status}`);
    }
    const decoded = await decodeGeminiResponse(response, input, attempt);
    return { ...decoded, extractorMeta: {
      recoveryKind: "none", retryCount: 0, retryClassification: "success_first_try",
      rateLimitRetries: 0, successfulRequestCount: 1,
      usageRequestCount: decoded.usage === undefined ? 0 : 1, transportFailures: []
    } };
  } catch (cause) {
    if (cause instanceof GeminiProviderEnvelopeError) {
      attempt.phase = "response_parse";
      attempt.kind = "provider_error";
      // A rejection envelope can still contain provider-reported token usage.
      try { attempt.usage = geminiUsage(record(cause.response)); } catch { /* Preserve the original provider error. */ }
    }
    const failure = geminiAttemptFailure(cause, attempt, input.abortSignal?.aborted === true, timeout.aborted);
    if (attempt.rawBody !== undefined) responseEvidence.set(failure, {
      rawBody: attempt.rawBody, finishReason: attempt.finishReason ?? null
    });
    throw failure;
  }
}

/** Pure request authority shared by preflight identity and the actual HTTP sender. */
export function prepareGeminiRequest(config: CompileSeedExtractionConfig, input: ExtractInput): {
  url: URL; body: string; timeoutMs: number;
} {
  assertRequiredRequestProfile(config);
  if (!isNativeGeminiRequestProfile(config.requestProfile) || input.retryMode !== "disabled") {
    throw new Error("Gemini interactive extraction requires its explicit native profile and disabled retries");
  }
  if (input.outputTokenField !== undefined && input.outputTokenField !== "maxOutputTokens") {
    throw new Error("Gemini output token field must be maxOutputTokens");
  }
  if (input.maxOutputTokens === undefined) throw new Error("Gemini output token cap must be explicit");
  const timeoutCeilingMs = Math.max(
    resolveExtractionRequestTimeoutMs(input.maxOutputTokens),
    GEMINI_INTERACTIVE_TIMEOUT_FLOOR_MS
  );
  const timeoutMs = input.timeoutMs ?? timeoutCeilingMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > timeoutCeilingMs) {
    throw new Error("invalid Gemini interactive timeout");
  }
  const route = resolveExtractionTransportRoute(config);
  const endpoint = normalizeGeminiEndpoint(route.providerUrl);
  const body = JSON.stringify(encodeGeminiGenerateContent(input, {
    model: route.model, requestProfile: config.requestProfile, maxOutputTokens: input.maxOutputTokens,
    includeThoughts: true,
    ...(input.responseJsonSchema === undefined ? {} : { responseJsonSchema: input.responseJsonSchema })
  }));
  return {
    url: new URL(`/v1beta/models/${route.model}:streamGenerateContent?alt=sse`, endpoint),
    body, timeoutMs
  };
}

async function dispatchGeminiHttp(
  fetchImpl: typeof fetch, url: URL, init: {
    readonly method: string; readonly redirect: "error"; readonly signal: AbortSignal;
    readonly headers: Record<string, string>; readonly body: string;
  }
): Promise<Response> {
  if (fetchImpl !== defaultFetch) return fetchImpl(url, init);
  return sendGeminiHttp(url, init);
}

function sendGeminiHttp(url: URL, init: {
  readonly method: string; readonly headers: Record<string, string>; readonly body: string; readonly signal: AbortSignal;
}): Promise<Response> {
  const headers = init.headers;
  const send = url.protocol === "http:" ? http.request : https.request;
  return new Promise((resolve, reject) => {
    const request = send(url, { method: init.method, headers, signal: init.signal }, (incoming) => {
      resolve(new Response(Readable.toWeb(incoming), {
        status: incoming.statusCode ?? 0,
        headers: incomingHttpHeaders(incoming.headers)
      }));
    });
    request.setSocketKeepAlive(true, 10_000);
    request.on("error", reject);
    request.end(init.body);
  });
}

function incomingHttpHeaders(headers: http.IncomingHttpHeaders): Headers {
  const result = new Headers();
  for (const [key, value] of Object.entries(headers)) {
    if (value === undefined) continue;
    for (const item of Array.isArray(value) ? value : [value]) result.append(key, String(item));
  }
  return result;
}

interface GeminiAttempt {
  phase: BenchTransportFailurePhase;
  kind: BenchTransportFailureKind;
  status: number | null;
  usage?: BenchProviderUsage;
  rawBody?: string;
  finishReason?: string | null;
}

async function decodeGeminiResponse(response: Response, input: ExtractInput, attempt: GeminiAttempt) {
  attempt.phase = "response_body";
  attempt.kind = "body_read_error";
  const raw = await readBoundedResponse(response, MAX_GEMINI_RESPONSE_BYTES);
  attempt.rawBody = raw;
  attempt.phase = "response_parse";
  attempt.kind = "response_parse_error";
  const value: unknown = parseGeminiGenerateContentBody(raw);
  attempt.usage = geminiUsage(record(value));
  const candidates = record(value).candidates;
  if (Array.isArray(candidates) && candidates.length === 1) {
    const finish = record(candidates[0]).finishReason;
    attempt.finishReason = typeof finish === "string" && finish.trim().length > 0 ? finish : null;
  }
  attempt.phase = "response_schema";
  attempt.kind = "response_schema_error";
  const decoded = decodeGeminiGenerateContent(value);
  const validation = input.validateRawJson === undefined ? "default_envelope" : "caller_owned";
  if (validation === "default_envelope") {
    extractValidGardenHttpContent({
      content: decoded.rawJson,
      finishReason: gardenFinishReason(decoded.responseMetadata.finishReason),
      ...(decoded.usage === undefined ? {} : { usage: decoded.usage })
    }, validation);
  }
  input.validateRawJson?.(decoded.rawJson);
  return { ...decoded, responseMetadata: {
    ...decoded.responseMetadata, maxOutputTokens: input.maxOutputTokens
  } };
}

function gardenFinishReason(finish: string | null): string {
  if (finish === "STOP") return "stop";
  if (finish === "MAX_TOKENS") return "length";
  throw new AlayaError("VALIDATION", "Gemini response finish reason is unknown or incomplete");
}

function geminiAttemptFailure(cause: unknown, attempt: GeminiAttempt, aborted: boolean, timedOut: boolean) {
  const kind = aborted ? "aborted" : timedOut ? "timeout" : attempt.kind;
  const marked = markGardenHttpFailure(cause, { kind, phase: attempt.phase,
    httpStatus: attempt.status,
    ...(attempt.rawBody === undefined ? {} : { rawBody: attempt.rawBody }),
    ...(attempt.usage === undefined ? {} : { usage: attempt.usage }) });
  const failure = toBenchTransportFailureAttempt(marked, 0);
  return wrapGardenHttpTransportError(marked,
    aborted ? "failure_aborted" : timedOut ? "failure_timeout" : "failure_non_retryable_response",
    0, 0, failure === undefined ? [] : [failure]);
}
