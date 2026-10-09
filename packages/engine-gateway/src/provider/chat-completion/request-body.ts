import { assertAllowedProviderChatUrl } from "./provider-url-guard.js";
import { AlayaError, isInternSemanticRequestProfile, INTERN_SEMANTIC_REQUEST_MODEL,
  INTERN_SEMANTIC_PROVIDER_URL, isStepSemanticRequestProfile, stepSemanticReasoningEffort,
  stepSemanticRequestModel, stepSemanticResponseFormat, type EnvLookup } from "@do-soul/alaya-protocol";
import type {
  ProviderChatCompletionRequest,
  ProviderRequestProfile
} from "./types.js";

function nonthinkingProfileExtras(
  profile: ProviderRequestProfile | undefined
): Record<string, unknown> {
  if (profile !== "deepseek-v4-nonthinking-v1" && profile !== "mimo-v2.5-nonthinking-v1") {
    return {};
  }
  return {
    reasoning_effort: "none",
    enable_thinking: false,
    thinking: { type: "disabled" }
  };
}

export function normalizeProviderBaseUrl(endpoint: string): string {
  const withoutSlash = endpoint.trim().replace(/\/+$/u, "");
  return withoutSlash.endsWith("/chat/completions")
    ? withoutSlash.slice(0, -"/chat/completions".length)
    : withoutSlash;
}

export function providerChatCompletionsUrl(
  providerUrl: string,
  env: EnvLookup = {}
): string {
  const url = `${normalizeProviderBaseUrl(providerUrl)}/chat/completions`;
  assertAllowedProviderChatUrl(url, env);
  return url;
}

export function buildProviderChatRequestInit(
  request: ProviderChatCompletionRequest
): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${request.apiKey}`
    },
    body: JSON.stringify(buildProviderChatRequestBody(request))
  };
}

/** The credential-free body authority used by both dispatch and request identity. */
export function buildProviderChatRequestBody(
  request: ProviderChatCompletionRequest
): Record<string, unknown> {
  const stream = request.mode === "sse";
  if (isInternSemanticRequestProfile(request.profile)) {
    if (request.model !== INTERN_SEMANTIC_REQUEST_MODEL ||
        request.providerUrl !== INTERN_SEMANTIC_PROVIDER_URL || stream ||
        request.jsonSchema === undefined || request.jsonSchema.name.trim().length === 0 ||
        typeof request.jsonSchema.schema !== "object" || request.jsonSchema.schema === null ||
        Array.isArray(request.jsonSchema.schema) || request.jsonObject === true ||
        !Number.isSafeInteger(request.maxOutputTokens) || (request.maxOutputTokens ?? 0) <= 0 ||
        request.outputTokenField !== undefined && request.outputTokenField !== "max_tokens" ||
        request.sseCompletionPolicy === "allow_clean_eof_v1") {
      throw new AlayaError("VALIDATION", "Intern semantic profile requires its exact Discovery route/model, named schema, finite max_tokens and JSON completion");
    }
    return {
      model: request.model,
      max_tokens: request.maxOutputTokens,
      messages: [
        { role: "system", content: `${request.systemPrompt}\n\nSchema identifier (metadata): ${JSON.stringify(request.jsonSchema.name)}\nReturn only a JSON object conforming to this complete JSON Schema. Preserve every required field and constraint; the receiver validates the result.\n${JSON.stringify(request.jsonSchema.schema)}` },
        { role: "user", content: request.userPrompt }
      ]
    };
  }
  if (isStepSemanticRequestProfile(request.profile)) {
    if (request.model !== stepSemanticRequestModel(request.profile) ||
        request.jsonSchema === undefined || request.jsonSchema.name.trim().length === 0 ||
        typeof request.jsonSchema.schema !== "object" || request.jsonSchema.schema === null ||
        Array.isArray(request.jsonSchema.schema) || request.jsonObject === true ||
        !Number.isSafeInteger(request.maxOutputTokens) || (request.maxOutputTokens ?? 0) <= 0 ||
        request.outputTokenField !== undefined && request.outputTokenField !== "max_tokens" ||
        request.sseCompletionPolicy === "allow_clean_eof_v1") {
      throw new AlayaError("VALIDATION", "Step semantic profile requires its exact model, named JSON Schema, finite max_tokens, and witnessed completion");
    }
    const instructionSchema = stepSemanticResponseFormat(request.profile) === "json_object";
    return {
      model: request.model,
      ...(request.temperature === undefined ? {} : { temperature: request.temperature }),
      ...(stream ? { stream: true } : {}),
      response_format: instructionSchema ? { type: "json_object" } : {
        type: "json_schema",
        json_schema: { name: request.jsonSchema.name, strict: true, schema: request.jsonSchema.schema }
      },
      max_tokens: request.maxOutputTokens,
      reasoning_effort: stepSemanticReasoningEffort(request.profile),
      messages: [
        { role: "system", content: instructionSchema
          ? `${request.systemPrompt}\n\nReturn only a JSON object conforming to this complete JSON Schema. Preserve every required field and constraint; the receiver validates the result.\n${JSON.stringify(request.jsonSchema)}`
          : request.systemPrompt },
        { role: "user", content: request.userPrompt }
      ]
    };
  }
  if (request.jsonSchema !== undefined) {
    throw new AlayaError("VALIDATION", "JSON Schema requires a native chat semantic profile");
  }
  return {
    model: request.model,
    temperature: request.temperature ?? 0,
    ...(stream
      ? { stream: true, stream_options: { include_usage: true } }
      : {}),
    ...(request.jsonObject === false ? {} : { response_format: { type: "json_object" } }),
    ...(request.maxOutputTokens === undefined ? {} : {
      [request.outputTokenField ?? "max_tokens"]: request.maxOutputTokens
    }),
    ...nonthinkingProfileExtras(request.profile),
    messages: [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userPrompt }
    ]
  };
}
