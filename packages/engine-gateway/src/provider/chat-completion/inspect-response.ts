import type {
  ProviderChatCompletionResult,
  ProviderSseCompletionPolicy,
  ProviderUsage
} from "./types.js";

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
  bodyText: string,
  contentType: string | null,
  httpStatus: number,
  options?: { readonly sseCompletionPolicy?: ProviderSseCompletionPolicy }
): ProviderChatCompletionResult {
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
  const content = readNestedString(choice, "message", "content");
  return {
    text: content ?? "",
    finishReason: stringOrNull(choice?.finish_reason),
    completion: { mode: "json", complete: true, witness: "message" },
    ...usageFields(usageFromUnknown(payload.usage))
  };
}

function inspectSse(
  bodyText: string,
  completionPolicy: ProviderSseCompletionPolicy
): Omit<ProviderChatCompletionResult, "httpStatus"> {
  let mode: "delta" | "message" | null = null;
  let text = "";
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
    usage = usageFromUnknown(chunk.usage) ?? usage;
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

function throwMixedStream(): never {
  throw new ProviderResponseInspectionError(MIXED_STREAM_MESSAGE, "schema");
}
