import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";

export function createGenerateResult(options: {
  readonly text: string;
  readonly responseId?: string;
  readonly finishReason?: LanguageModelV3GenerateResult["finishReason"];
  readonly content?: LanguageModelV3GenerateResult["content"];
}): LanguageModelV3GenerateResult {
  return {
    content: options.content ?? (options.text.length > 0 ? [{ type: "text", text: options.text }] : []),
    finishReason: options.finishReason ?? { unified: "stop", raw: "stop" },
    usage: {
      inputTokens: { total: 11, noCache: 11, cacheRead: 0, cacheWrite: 0 },
      outputTokens: { total: 7, text: 7, reasoning: 0 }
    },
    warnings: [],
    response: {
      id: options.responseId,
      modelId: "mock-model",
      timestamp: new Date("2026-04-11T00:00:00.000Z")
    }
  };
}
