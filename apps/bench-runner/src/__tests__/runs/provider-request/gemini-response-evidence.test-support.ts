/** Synthetic provider envelope for recovery tests whose subject is not the HTTP decoder. */
export function syntheticGeminiBody(
  rawJson: string,
  finishReason: string | null = "STOP",
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number }
): string {
  return JSON.stringify({
    candidates: [{ ...(finishReason === null ? {} : { finishReason }),
      content: { parts: [{ text: rawJson }] } }],
    ...(usage === undefined ? {} : { usageMetadata: {
      promptTokenCount: usage.inputTokens, candidatesTokenCount: usage.outputTokens,
      totalTokenCount: usage.totalTokens
    } })
  });
}
