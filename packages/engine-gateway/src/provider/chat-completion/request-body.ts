import type { ProviderChatCompletionRequest } from "./types.js";

export function normalizeProviderBaseUrl(endpoint: string): string {
  const withoutSlash = endpoint.trim().replace(/\/+$/u, "");
  return withoutSlash.endsWith("/chat/completions")
    ? withoutSlash.slice(0, -"/chat/completions".length)
    : withoutSlash;
}

export function providerChatCompletionsUrl(providerUrl: string): string {
  return `${normalizeProviderBaseUrl(providerUrl)}/chat/completions`;
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
    body: JSON.stringify(buildProviderChatRequestBody(request, stream)),
    ...(request.abortSignal === undefined ? {} : { signal: request.abortSignal })
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
    ...(request.profile === "deepseek-v4-nonthinking-v1"
      ? {
        reasoning_effort: "none",
        enable_thinking: false,
        thinking: { type: "disabled" }
      }
      : {}),
    messages: [
      { role: "system", content: request.systemPrompt },
      { role: "user", content: request.userPrompt }
    ]
  };
}
