import type { CompileSeedExtractionConfig } from "../compile-seed-types.js";

export function buildGardenHttpRequestInit(
  config: CompileSeedExtractionConfig,
  apiKey: string,
  input: {
    readonly systemPrompt: string;
    readonly userPrompt: string;
    readonly maxOutputTokens?: number;
    readonly outputTokenField?: "max_tokens" | "max_completion_tokens";
  },
  signal: AbortSignal
): RequestInit {
  return {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      stream: true,
      stream_options: { include_usage: true },
      response_format: { type: "json_object" },
      ...(input.maxOutputTokens === undefined ? {} : {
        [input.outputTokenField ?? "max_tokens"]: input.maxOutputTokens
      }),
      ...(config.requestProfile === "deepseek-v4-nonthinking-v1"
        ? { thinking: { type: "disabled" } }
        : {}),
      messages: [
        { role: "system", content: input.systemPrompt },
        { role: "user", content: input.userPrompt }
      ]
    }),
    signal
  };
}
