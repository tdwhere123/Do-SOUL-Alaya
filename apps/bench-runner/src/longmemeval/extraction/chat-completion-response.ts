import { z } from "zod";
import type { BenchProviderUsage } from "../compile-seed/compile-seed-types.js";

const ChatCompletionPayloadSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({ content: z.unknown().optional() }).loose().optional(),
    message: z.object({ content: z.unknown().optional() }).loose().optional(),
    finish_reason: z.unknown().optional()
  }).loose()).optional()
}).loose().readonly();

export interface ChatCompletionResponseInspection {
  readonly content: string;
  readonly finishReason: string | null;
  readonly usage?: BenchProviderUsage;
}

export function inspectChatCompletionResponse(
  bodyText: string,
  contentType: string | null
): ChatCompletionResponseInspection {
  return isSseChatCompletionBody(bodyText, contentType)
    ? inspectSseChatCompletionBody(bodyText)
    : inspectPlainChatCompletionBody(bodyText);
}

export function extractContentFromChatCompletionBody(
  bodyText: string,
  contentType: string | null
): string {
  return inspectChatCompletionResponse(bodyText, contentType).content;
}

export function extractUsageFromChatCompletionBody(
  bodyText: string,
  contentType: string | null
): BenchProviderUsage | undefined {
  return inspectChatCompletionResponse(bodyText, contentType).usage;
}

function isSseChatCompletionBody(
  bodyText: string,
  contentType: string | null
): boolean {
  const trimmedBody = bodyText.trim();
  return (contentType?.toLowerCase().includes("text/event-stream") ?? false) ||
    trimmedBody.startsWith("data:");
}

function inspectPlainChatCompletionBody(
  bodyText: string
): ChatCompletionResponseInspection {
  const payload = parseChatCompletionPayload(bodyText);
  const choice = payload.choices?.[0];
  const content = choice?.message?.content;
  const usage = usageFromJson(bodyText);
  return {
    content: typeof content === "string" ? content : "",
    finishReason: normalizeFinishReason(choice?.finish_reason),
    ...(usage === undefined ? {} : { usage })
  };
}

function inspectSseChatCompletionBody(
  bodyText: string
): ChatCompletionResponseInspection {
  let accumulated = "";
  let finishReason: string | null = null;
  let usage: BenchProviderUsage | undefined;
  for (const rawLine of bodyText.split("\n")) {
    const chunkText = readSseDataLine(rawLine);
    if (chunkText === null) continue;
    if (chunkText === "[DONE]") break;
    const chunk = tryParseChatCompletionSseChunk(chunkText);
    accumulated += extractContentFromChunk(chunk);
    finishReason = normalizeFinishReason(chunk.choices?.[0]?.finish_reason) ?? finishReason;
    usage = usageFromParsedPayload(chunk) ?? usage;
  }
  return {
    content: accumulated,
    finishReason,
    ...(usage === undefined ? {} : { usage })
  };
}

function readSseDataLine(rawLine: string): string | null {
  const line = rawLine.trim();
  if (line.length === 0 || line.startsWith(":") || !line.startsWith("data:")) {
    return null;
  }
  return line.slice("data:".length).trim();
}

function extractContentFromChunk(
  chunk: z.infer<typeof ChatCompletionPayloadSchema>
): string {
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
    return usageFromParsedPayload(JSON.parse(text));
  } catch {
    return undefined;
  }
}

function usageFromParsedPayload(value: unknown): BenchProviderUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  return toUsage((value as { readonly usage?: unknown }).usage);
}

function normalizeFinishReason(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
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
