import type { ProviderChatCompletionResult, ProviderUsage } from "./types.js";

export function inspectProviderChatCompletionResponse(
  bodyText: string,
  contentType: string | null,
  httpStatus: number
): ProviderChatCompletionResult {
  const inspection = isSseBody(bodyText, contentType)
    ? inspectSse(bodyText)
    : inspectJson(bodyText);
  return { ...inspection, httpStatus };
}

function isSseBody(bodyText: string, contentType: string | null): boolean {
  return (contentType?.toLowerCase().includes("text/event-stream") ?? false) ||
    bodyText.trim().startsWith("data:");
}

function inspectJson(bodyText: string): Omit<ProviderChatCompletionResult, "httpStatus"> {
  const payload = parseObject(bodyText, "payload");
  const choice = firstChoice(payload);
  const content = readNestedString(choice, "message", "content");
  return {
    text: content ?? "",
    finishReason: stringOrNull(choice?.finish_reason),
    ...usageFields(usageFromUnknown(payload.usage))
  };
}

function inspectSse(bodyText: string): Omit<ProviderChatCompletionResult, "httpStatus"> {
  let mode: "delta" | "message" | null = null;
  let text = "";
  let finishReason: string | null = null;
  let usage: ProviderUsage | undefined;
  for (const rawLine of bodyText.split("\n")) {
    const data = readSseData(rawLine);
    if (data === null) continue;
    if (data === "[DONE]") break;
    const chunk = parseObject(data, "chunk");
    const choice = firstChoice(chunk);
    const delta = readNestedString(choice, "delta", "content");
    const message = readNestedString(choice, "message", "content");
    if (delta !== undefined && message !== undefined && (delta !== message || mode === "delta")) {
      throw new Error("garden extraction chat completion stream mixes delta and message content");
    }
    if (delta !== undefined) {
      if (mode === "message") {
        throw new Error("garden extraction chat completion stream mixes delta and message content");
      }
      mode = "delta";
      text += delta;
    } else if (message !== undefined) {
      if (mode === "delta") {
        throw new Error("garden extraction chat completion stream mixes delta and message content");
      }
      mode = "message";
      text = message;
    }
    finishReason = stringOrNull(choice?.finish_reason) ?? finishReason;
    usage = usageFromUnknown(chunk.usage) ?? usage;
  }
  return { text, finishReason, ...usageFields(usage) };
}

function readSseData(rawLine: string): string | null {
  const line = rawLine.trim();
  if (line.length === 0 || line.startsWith(":") || !line.startsWith("data:")) return null;
  return line.slice("data:".length).trim();
}

function parseObject(text: string, label: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new Error(`garden extraction chat completion ${label} is not valid JSON`, { cause: error });
  }
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(`provider ${label} is not an object`);
  }
  return parsed as Record<string, unknown>;
}

function firstChoice(payload: Record<string, unknown>): Record<string, unknown> | undefined {
  const choices = payload.choices;
  if (!Array.isArray(choices) || choices[0] === undefined) return undefined;
  const choice = choices[0];
  return typeof choice === "object" && choice !== null
    ? choice as Record<string, unknown>
    : undefined;
}

function usageFromUnknown(value: unknown): ProviderUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly total_tokens?: unknown;
  };
  if (!isCount(usage.prompt_tokens) || !isCount(usage.completion_tokens) ||
      !isCount(usage.total_tokens)) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens
  };
}

function usageFields(usage: ProviderUsage | undefined): { readonly usage?: ProviderUsage } {
  return usage === undefined ? {} : { usage };
}

function readNestedString(
  record: Record<string, unknown> | undefined,
  outer: string,
  inner: string
): string | undefined {
  const nested = record?.[outer];
  if (typeof nested !== "object" || nested === null) return undefined;
  const value = (nested as Record<string, unknown>)[inner];
  return typeof value === "string" ? value : undefined;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
