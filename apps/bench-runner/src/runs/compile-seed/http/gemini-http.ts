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
  geminiUsage,
  record
} from "../../extraction/fill/batch/native-codec.js";
import { readBoundedResponse } from "../../extraction/fill/batch/http.js";
import { assertRequiredRequestProfile, resolveExtractionTransportRoute } from
  "../../extraction/transport-route.js";
import { markGardenHttpFailure, toBenchTransportFailureAttempt } from
  "./garden-http-failure-attempt.js";
import { wrapGardenHttpTransportError } from "./garden-http-terminal-error.js";
import { extractValidGardenHttpContent } from "./garden-http-response-validation.js";
import { EXTRACTION_REQUEST_TIMEOUT_MS } from "./output-token-retry.js";

const MAX_GEMINI_RESPONSE_BYTES = 32 * 1024 * 1024;
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
    const response = await fetchImpl(url, { method: "POST", redirect: "error", signal,
      headers: { "content-type": "application/json", "x-goog-api-key": config.apiKey }, body });
    attempt.status = response.status;
    if (!response.ok) {
      attempt.phase = "response_status";
      attempt.kind = "http_error";
      await response.body?.cancel();
      throw new Error(`Gemini HTTP ${response.status}`);
    }
    const decoded = await decodeGeminiResponse(response, input, attempt);
    return { ...decoded, extractorMeta: {
      recoveryKind: "none", retryCount: 0, retryClassification: "success_first_try",
      rateLimitRetries: 0, successfulRequestCount: 1,
      usageRequestCount: decoded.usage === undefined ? 0 : 1, transportFailures: []
    } };
  } catch (cause) {
    throw geminiAttemptFailure(cause, attempt, input.abortSignal?.aborted === true, timeout.aborted);
  }
}

function prepareGeminiRequest(config: CompileSeedExtractionConfig, input: ExtractInput): {
  url: URL; body: string; timeoutMs: number;
} {
  assertRequiredRequestProfile(config);
  if (config.requestProfile !== "gemini-2.5-nonthinking-v1" || input.retryMode !== "disabled") {
    throw new Error("Gemini interactive extraction requires its nonthinking profile and disabled retries");
  }
  if (input.outputTokenField !== undefined && input.outputTokenField !== "maxOutputTokens") {
    throw new Error("Gemini output token field must be maxOutputTokens");
  }
  if (input.maxOutputTokens === undefined) throw new Error("Gemini output token cap must be explicit");
  const timeoutMs = input.timeoutMs ?? EXTRACTION_REQUEST_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > EXTRACTION_REQUEST_TIMEOUT_MS) {
    throw new Error("invalid Gemini interactive timeout");
  }
  const route = resolveExtractionTransportRoute(config);
  const endpoint = new URL(route.providerUrl);
  const loopback = ["localhost", "127.0.0.1", "[::1]"].includes(endpoint.hostname);
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash ||
      !["/", "/v1beta", "/v1beta/"].includes(endpoint.pathname) ||
      !(endpoint.protocol === "https:" || (endpoint.protocol === "http:" && loopback))) {
    throw new Error("Gemini interactive endpoint must be an HTTPS origin or native v1beta route");
  }
  const body = JSON.stringify(encodeGeminiGenerateContent(input, {
    model: route.model, requestProfile: config.requestProfile, maxOutputTokens: input.maxOutputTokens
  }));
  return { url: new URL(`/v1beta/models/${route.model}:generateContent`, endpoint), body, timeoutMs };
}

interface GeminiAttempt {
  phase: BenchTransportFailurePhase;
  kind: BenchTransportFailureKind;
  status: number | null;
  usage?: BenchProviderUsage;
}

async function decodeGeminiResponse(response: Response, input: ExtractInput, attempt: GeminiAttempt) {
  attempt.phase = "response_body";
  attempt.kind = "body_read_error";
  const raw = await readBoundedResponse(response, MAX_GEMINI_RESPONSE_BYTES);
  attempt.phase = "response_parse";
  attempt.kind = "response_parse_error";
  const value: unknown = JSON.parse(raw);
  attempt.usage = geminiUsage(record(value));
  attempt.phase = "response_schema";
  attempt.kind = "response_schema_error";
  const decoded = decodeGeminiGenerateContent(value);
  extractValidGardenHttpContent({ content: decoded.rawJson, finishReason: "STOP",
    ...(decoded.usage === undefined ? {} : { usage: decoded.usage }) },
  input.validateRawJson === undefined ? "default_envelope" : "caller_owned");
  input.validateRawJson?.(decoded.rawJson);
  return { ...decoded, responseMetadata: {
    ...decoded.responseMetadata, maxOutputTokens: input.maxOutputTokens
  } };
}

function geminiAttemptFailure(cause: unknown, attempt: GeminiAttempt, aborted: boolean, timedOut: boolean) {
  const kind = aborted ? "aborted" : timedOut ? "timeout" : attempt.kind;
  const marked = markGardenHttpFailure(cause, { kind, phase: attempt.phase,
    httpStatus: attempt.status, ...(attempt.usage === undefined ? {} : { usage: attempt.usage }) });
  const failure = toBenchTransportFailureAttempt(marked, 0);
  return wrapGardenHttpTransportError(marked,
    aborted ? "failure_aborted" : timedOut ? "failure_timeout" : "failure_non_retryable_response",
    0, 0, failure === undefined ? [] : [failure]);
}
