import { z } from "zod";
import type { BenchProviderUsage } from "../compile-seed/compile-seed-types.js";

const ChatCompletionPayloadSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({ content: z.unknown().optional() }).loose().optional(),
    message: z.object({ content: z.unknown().optional() }).loose().optional()
  }).loose()).optional()
}).loose().readonly();

export function extractContentFromChatCompletionBody(
  bodyText: string,
  contentType: string | null
): string {
  return isSseChatCompletionBody(bodyText, contentType)
    ? extractContentFromSseChatCompletionBody(bodyText)
    : extractContentFromPlainChatCompletionBody(bodyText);
}

export function extractUsageFromChatCompletionBody(
  bodyText: string,
  contentType: string | null
): BenchProviderUsage | undefined {
  if (!isSseChatCompletionBody(bodyText, contentType)) return usageFromJson(bodyText);
  let usage: BenchProviderUsage | undefined;
  for (const rawLine of bodyText.split("\n")) {
    const chunkText = readSseDataLine(rawLine);
    if (chunkText === null || chunkText === "[DONE]") continue;
    usage = usageFromJson(chunkText) ?? usage;
  }
  return usage;
}

function isSseChatCompletionBody(
  bodyText: string,
  contentType: string | null
): boolean {
  const trimmedBody = bodyText.trim();
  return (contentType?.toLowerCase().includes("text/event-stream") ?? false) ||
    trimmedBody.startsWith("data:");
}

function extractContentFromPlainChatCompletionBody(bodyText: string): string {
  const payload = parseChatCompletionPayload(bodyText);
  const content = payload.choices?.[0]?.message?.content;
  return typeof content === "string" ? content : "";
}

function extractContentFromSseChatCompletionBody(bodyText: string): string {
  let accumulated = "";
  for (const rawLine of bodyText.split("\n")) {
    const chunkText = readSseDataLine(rawLine);
    if (chunkText === null) continue;
    if (chunkText === "[DONE]") break;
    accumulated += extractContentFromSseChunk(chunkText);
  }
  return accumulated;
}

function readSseDataLine(rawLine: string): string | null {
  const line = rawLine.trim();
  if (line.length === 0 || line.startsWith(":") || !line.startsWith("data:")) {
    return null;
  }
  return line.slice("data:".length).trim();
}

function extractContentFromSseChunk(chunkText: string): string {
  const chunk = tryParseChatCompletionSseChunk(chunkText);
  const choice = chunk.choices?.[0];
  const deltaContent = choice?.delta?.content;
  if (typeof deltaContent === "string") return deltaContent;
  const messageContent = choice?.message?.content;
  return typeof messageContent === "string" ? messageContent : "";
}

function parseChatCompletionPayload(
  bodyText: string
): z.infer<typeof ChatCompletionPayloadSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bodyText);
  } catch (error) {
    throw new Error("garden extraction chat completion payload is not valid JSON", {
      cause: error
    });
  }
  const result = ChatCompletionPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `garden extraction chat completion payload failed schema validation: ${result.error.message}`
    );
  }
  return result.data;
}

function tryParseChatCompletionSseChunk(
  chunkText: string
): z.infer<typeof ChatCompletionPayloadSchema> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(chunkText);
  } catch (error) {
    throw new Error("garden extraction chat completion chunk is not valid JSON", {
      cause: error
    });
  }
  const result = ChatCompletionPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `garden extraction chat completion chunk failed schema validation: ${result.error.message}`
    );
  }
  return result.data;
}

function usageFromJson(text: string): BenchProviderUsage | undefined {
  try {
    const parsed = JSON.parse(text) as { readonly usage?: unknown };
    return toUsage(parsed.usage);
  } catch {
    return undefined;
  }
}

function toUsage(value: unknown): BenchProviderUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly total_tokens?: unknown;
  };
  if (!isTokenCount(usage.prompt_tokens) || !isTokenCount(usage.completion_tokens) ||
      !isTokenCount(usage.total_tokens)) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens
  };
}

function isTokenCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
