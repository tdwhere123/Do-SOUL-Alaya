import { assertAllowedProviderChatUrl } from "./provider-url-guard.js";
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

export function providerChatCompletionsUrl(providerUrl: string): string {
  const url = `${normalizeProviderBaseUrl(providerUrl)}/chat/completions`;
  assertAllowedProviderChatUrl(url);
  return url;
}

export function buildProviderChatRequestInit(
  request: ProviderChatCompletionRequest
): RequestInit {
  const stream = request.mode === "sse";
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${request.apiKey}`
    },
    body: JSON.stringify(buildProviderChatRequestBody(request, stream))
  };
}

function buildProviderChatRequestBody(
  request: ProviderChatCompletionRequest,
  stream: boolean
): Record<string, unknown> {
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
