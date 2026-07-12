import type { CompileSeedExtractionConfig } from "../compile-seed-types.js";

export function buildGardenHttpRequestInit(
  config: CompileSeedExtractionConfig,
  apiKey: string,
  input: { readonly systemPrompt: string; readonly userPrompt: string },
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
      response_format: { type: "json_object" },
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
