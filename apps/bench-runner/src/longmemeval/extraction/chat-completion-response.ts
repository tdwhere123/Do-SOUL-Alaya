import { z } from "zod";

const ChatCompletionPayloadSchema = z.object({
  choices: z.array(z.object({
    delta: z.object({ content: z.unknown() }).loose().optional(),
    message: z.object({ content: z.unknown() }).loose().optional()
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
  if (chunk === null) return "";
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
): z.infer<typeof ChatCompletionPayloadSchema> | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(chunkText);
  } catch {
    return null;
  }
  const result = ChatCompletionPayloadSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `garden extraction chat completion chunk failed schema validation: ${result.error.message}`
    );
  }
  return result.data;
}
