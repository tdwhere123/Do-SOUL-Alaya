import {
  buildProviderChatRequestBody, executeProviderChatCompletion, providerChatCompletionsUrl,
  ProviderChatCompletionError, type ProviderChatCompletionRequest,
  type ProviderHttpResponseEvidence
} from "@do-soul/alaya-engine-gateway";
import { isStepSemanticRequestProfile, AlayaError } from "@do-soul/alaya-protocol";
import type { BenchSignalExtractor, CompileSeedExtractionConfig } from "../compile-seed-types.js";
import { assertRequiredRequestProfile, resolveExtractionTransportRoute } from "../../extraction/transport-route.js";
import { prepareGeminiRequest, createGeminiHttpExtractor, GEMINI_INTERACTIVE_TIMEOUT_FLOOR_MS } from "./gemini-http.js";
import { isNativeGeminiRequestProfile } from "../../extraction/request-profile.js";
import { resolveExtractionRequestTimeoutMs } from "./output-token-retry.js";
import { mapGardenHttpAttemptFailure, toBenchTransportFailureAttempt } from "./garden-http-failure-attempt.js";
import { wrapGardenHttpTransportError } from "./garden-http-terminal-error.js";

type ExtractInput = Parameters<BenchSignalExtractor["extract"]>[0];

/** Preparation and dispatch use the same provider-owned request encoder. */
export function prepareSemanticProviderRequest(
  config: CompileSeedExtractionConfig,
  input: ExtractInput,
  schemaName: string
): Readonly<{ url: URL; body: string; timeoutMs: number; gatewayRequest?: ProviderChatCompletionRequest }> {
  assertRequiredRequestProfile(config);
  if (input.retryMode !== "disabled" || input.maxOutputTokens === undefined) {
    throw new AlayaError("VALIDATION", "semantic provider request requires a finite output cap and disabled retries");
  }
  if (isNativeGeminiRequestProfile(config.requestProfile)) {
    return prepareGeminiRequest(config, input);
  }
  if (!isStepSemanticRequestProfile(config.requestProfile) ||
      input.outputTokenField !== "max_tokens" || input.responseJsonSchema === undefined) {
    throw new AlayaError("VALIDATION", "semantic provider request requires its explicit Step profile and response schema");
  }
  const timeoutCeilingMs = Math.max(resolveExtractionRequestTimeoutMs(input.maxOutputTokens),
    GEMINI_INTERACTIVE_TIMEOUT_FLOOR_MS);
  const timeoutMs = input.timeoutMs ?? timeoutCeilingMs;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > timeoutCeilingMs) {
    throw new AlayaError("VALIDATION", "invalid semantic Step timeout");
  }
  const route = resolveExtractionTransportRoute(config);
  const gatewayRequest: ProviderChatCompletionRequest = {
    providerUrl: route.providerUrl, apiKey: "",
    model: route.model, profile: config.requestProfile,
    systemPrompt: input.systemPrompt, userPrompt: input.userPrompt,
    jsonSchema: { name: schemaName, schema: input.responseJsonSchema as Record<string, unknown> },
    maxOutputTokens: input.maxOutputTokens, outputTokenField: "max_tokens",
    mode: "sse", sseCompletionPolicy: "require_witness", timeoutMs,
    ...(input.abortSignal === undefined ? {} : { abortSignal: input.abortSignal }),
    ...(input.retainHttpResponseEvidence === true ? { retainHttpResponseEvidence: true as const } : {}),
    env: process.env
  };
  const url = new URL(providerChatCompletionsUrl(route.providerUrl, process.env));
  return { url, body: JSON.stringify(buildProviderChatRequestBody(gatewayRequest)), timeoutMs, gatewayRequest };
}

export function createSemanticProviderHttpExtractor(
  config: CompileSeedExtractionConfig,
  schemaName: string,
  fetchImpl?: typeof fetch
): BenchSignalExtractor {
  if (isNativeGeminiRequestProfile(config.requestProfile)) return createGeminiHttpExtractor(config, fetchImpl);
  if (!isStepSemanticRequestProfile(config.requestProfile)) {
    throw new AlayaError("VALIDATION", "semantic provider request profile is unsupported");
  }
  return { extract: async (input) => {
    const prepared = prepareSemanticProviderRequest(config, input, schemaName);
    const request = prepared.gatewayRequest!;
    if (config.apiKey === null || config.apiKey.trim().length === 0) {
      throw new AlayaError("UNAVAILABLE", "garden API key is unavailable");
    }
    await input.onTransportAttempt?.(input.abortSignal);
    try {
      const execution = await executeProviderChatCompletion({ ...request, apiKey: config.apiKey,
        ...(fetchImpl === undefined ? {} : { fetchImpl }) }, { maxRetries: 0, retryDelaysMs: [] });
      const response = execution.result;
      return {
        rawJson: response.text,
        responseMetadata: { finishReason: response.finishReason,
          ...(response.finishReason === null ? {} : {
            completionContractVersion: 1 as const, completionWitness: "finish_reason" as const
          }) },
        ...(response.usage === undefined ? {} : { usage: response.usage }),
        ...(response.httpResponse === undefined ? {} : { httpResponse: response.httpResponse }),
        extractorMeta: { recoveryKind: "none", retryCount: 0, retryClassification: "success_first_try",
          rateLimitRetries: 0, successfulRequestCount: 1,
          usageRequestCount: response.usage === undefined ? 0 : 1, transportFailures: [] }
      };
    } catch (cause) {
      const error = mapGardenHttpAttemptFailure(cause,
        cause instanceof ProviderChatCompletionError ? cause.httpStatus : null,
        { timedOut: cause instanceof ProviderChatCompletionError && cause.kind === "timeout",
          aborted: cause instanceof ProviderChatCompletionError && cause.kind === "aborted" });
      const failure = toBenchTransportFailureAttempt(error, 0);
      const wrapped = wrapGardenHttpTransportError(error,
        cause instanceof ProviderChatCompletionError && cause.kind === "timeout" ? "failure_timeout" :
          cause instanceof ProviderChatCompletionError && cause.kind === "aborted" ? "failure_aborted" :
            cause instanceof ProviderChatCompletionError && cause.kind === "http_error" &&
              cause.httpStatus !== null && cause.httpStatus >= 400 && cause.httpStatus < 500
              ? "failure_non_retryable_4xx" : "failure_non_retryable_response",
        0, 0, failure === undefined ? [] : [failure]);
      if (cause instanceof ProviderChatCompletionError && cause.httpResponse !== undefined) {
        stepResponseEvidence.set(wrapped, cause.httpResponse);
      }
      throw wrapped;
    }
  } };
}

const stepResponseEvidence = new WeakMap<object, ProviderHttpResponseEvidence>();
export function readStepFailureResponse(error: unknown): ProviderHttpResponseEvidence | undefined {
  return typeof error === "object" && error !== null ? stepResponseEvidence.get(error) : undefined;
}

export function isCompleteSemanticFinish(profile: string, finishReason: string | null | undefined): boolean {
  return isStepSemanticRequestProfile(profile) ? finishReason === "stop" : finishReason === "STOP";
}
