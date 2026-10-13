import type {
  ProviderChatCompletionResult,
  ProviderSseCompletionPolicy,
  ProviderUsage
} from "./types.js";
import { decodeProviderResponseBytes } from "./response-evidence.js";

export type ProviderResponseInspectionReason = "parse" | "schema" | "incomplete_stream";

export class ProviderResponseInspectionError extends Error {
  public readonly reason: ProviderResponseInspectionReason;

  public constructor(
    message: string,
    reason: ProviderResponseInspectionReason,
    options?: { readonly cause?: unknown }
  ) {
    super(message, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "ProviderResponseInspectionError";
    this.reason = reason;
  }
}

const MIXED_STREAM_MESSAGE =
  "garden extraction chat completion stream mixes delta and message content";

export function inspectProviderChatCompletionResponse(
  body: string | Uint8Array,
  contentType: string | null,
  httpStatus: number,
  options?: { readonly sseCompletionPolicy?: ProviderSseCompletionPolicy }
): ProviderChatCompletionResult {
  const bodyText = typeof body === "string" ? body : decodeProviderResponseBytes(body);
  const inspection = isSseBody(bodyText, contentType)
    ? inspectSse(bodyText, options?.sseCompletionPolicy ?? "require_witness")
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
  if (choice === undefined || typeof choice.message !== "object" || choice.message === null ||
      Array.isArray(choice.message)) {
    throw new ProviderResponseInspectionError("provider payload is missing a message completion", "schema");
  }
  const content = readNestedString(choice, "message", "content");
  return {
    text: content ?? "",
    ...reasoningFields(readNestedString(choice, "message", "reasoning_content") ??
      readNestedString(choice, "message", "reasoning")),
    finishReason: stringOrNull(choice?.finish_reason),
    completion: { mode: "json", complete: true, witness: "message" },
    ...usageFields(normalizeProviderUsage(payload.usage))
  };
}

function inspectSse(
  bodyText: string,
  completionPolicy: ProviderSseCompletionPolicy
): Omit<ProviderChatCompletionResult, "httpStatus"> {
  let mode: "delta" | "message" | null = null;
  let text = "";
  let reasoningText = "";
  let sawReasoning = false;
  let finishReason: string | null = null;
  let usage: ProviderUsage | undefined;
  let sawDone = false;
  for (const rawLine of bodyText.split("\n")) {
    const data = readSseData(rawLine);
    if (data === null) continue;
    if (data === "[DONE]") {
      sawDone = true;
      break;
    }
    const chunk = parseObject(data, "chunk");
    const choice = firstChoice(chunk);
    const delta = readNestedString(choice, "delta", "content");
    const message = readNestedString(choice, "message", "content");
    const deltaReasoning = readNestedString(choice, "delta", "reasoning_content") ??
      readNestedString(choice, "delta", "reasoning");
    const messageReasoning = readNestedString(choice, "message", "reasoning_content") ??
      readNestedString(choice, "message", "reasoning");
    if (deltaReasoning !== undefined) {
      sawReasoning = true;
      reasoningText += deltaReasoning;
    } else if (messageReasoning !== undefined) {
      sawReasoning = true;
      reasoningText = messageReasoning;
    }
    if (delta !== undefined && message !== undefined && (delta !== message || mode === "delta")) {
      throwMixedStream();
    }
    if (delta !== undefined) {
      if (mode === "message") throwMixedStream();
      mode = "delta";
      text += delta;
    } else if (message !== undefined) {
      if (mode === "delta") throwMixedStream();
      mode = "message";
      text = message;
    }
    finishReason = stringOrNull(choice?.finish_reason) ?? finishReason;
    usage = normalizeProviderUsage(chunk.usage) ?? usage;
  }
  const witness = sawDone
    ? "done_sentinel"
    : finishReason !== null
      ? "finish_reason"
      : completionPolicy === "allow_clean_eof_v1"
        ? "profile_clean_eof"
        : null;
  if (witness === null) {
    throw new ProviderResponseInspectionError(
      "provider chat completion stream ended without a completion witness",
      "incomplete_stream"
    );
  }
  return {
    text,
    ...(sawReasoning ? { reasoningText } : {}),
    finishReason,
    ...usageFields(usage),
    completion: { mode: "sse", complete: true, witness }
  };
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
    throw new ProviderResponseInspectionError(
      `garden extraction chat completion ${label} is not valid JSON`,
      "parse",
      { cause: error }
    );
  }
  // Arrays are typeof object; a JSON array is a schema miss, not an empty completion.
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new ProviderResponseInspectionError(`provider ${label} is not an object`, "schema");
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

function normalizeProviderUsage(value: unknown): ProviderUsage | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const usage = value as {
    readonly prompt_tokens?: unknown;
    readonly completion_tokens?: unknown;
    readonly total_tokens?: unknown;
    readonly prompt_tokens_details?: unknown;
    readonly completion_tokens_details?: unknown;
  };
  if (!isCount(usage.prompt_tokens) || !isCount(usage.completion_tokens) ||
      !isCount(usage.total_tokens)) return undefined;
  return {
    inputTokens: usage.prompt_tokens,
    outputTokens: usage.completion_tokens,
    totalTokens: usage.total_tokens,
    ...optionalCount(usage.prompt_tokens_details, "cached_tokens", "cachedInputTokens"),
    ...optionalCount(usage.completion_tokens_details, "reasoning_tokens", "reasoningOutputTokens")
  };
}

function optionalCount(
  details: unknown,
  field: string,
  output: "cachedInputTokens" | "reasoningOutputTokens"
): Partial<ProviderUsage> {
  if (typeof details !== "object" || details === null) return {};
  const value = (details as Record<string, unknown>)[field];
  return isCount(value) ? { [output]: value } : {};
}

function reasoningFields(reasoningText: string | undefined): { readonly reasoningText?: string } {
  return reasoningText === undefined ? {} : { reasoningText };
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

function throwMixedStream(): never {
  throw new ProviderResponseInspectionError(MIXED_STREAM_MESSAGE, "schema");
}
