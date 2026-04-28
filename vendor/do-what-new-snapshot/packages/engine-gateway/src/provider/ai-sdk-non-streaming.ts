import { APICallError, generateText } from "ai";
import { EngineError, EngineErrorKind, type ConversationRequest, type EngineBinding, type EngineErrorKind as EngineErrorKindValue, type EngineResult } from "@do-what/protocol";
import { buildMessages, getNonStreamingTools, mapFinishReason, normalizeToolUses } from "./internal/ai-sdk-helpers.js";
import { readApiKey, resolveLanguageModel } from "./provider-registry.js";
import type { ContinueWithToolResultsInput } from "./provider-types.js";
import type { AiSdkToolDef } from "./ai-sdk-tools.js";

export interface NonStreamingOptions { readonly getEnv?: (key: string) => string | undefined; readonly abortSignal?: AbortSignal; readonly continuation?: Pick<ContinueWithToolResultsInput, "response" | "toolResults">; readonly conversationToolDefs?: readonly AiSdkToolDef[]; }

export async function sendViaAiSdk(
  request: ConversationRequest,
  options: NonStreamingOptions = {}
): Promise<EngineResult> {
  try {
    const maxOutputTokens = readMaxOutputTokens(request.binding);
    const result = await generateText({
      model: resolveLanguageModel(request.binding, options.getEnv),
      maxRetries: 0,
      messages: buildMessages(request, options.continuation),
      ...(request.systemPrompt.length > 0 ? { system: request.systemPrompt } : {}),
      ...(request.binding.enable_tools === false
        ? {}
        : { tools: getNonStreamingTools({ conversationToolDefs: options.conversationToolDefs }) }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {})
    });
    const usage = normalizeUsage(result.usage);
    const toolUses = normalizeToolUses(result.toolCalls);

    if (result.text.length === 0 && toolUses === undefined) {
      throw new EngineError("The model provider returned no assistant text response.", EngineErrorKind.MODEL_ERROR);
    }

    return {
      message: {
        role: "assistant",
        content: result.text,
        message_id: result.response.id ?? crypto.randomUUID()
      },
      finish_reason: mapFinishReason(result.finishReason),
      ...(toolUses ? { tool_uses: toolUses } : {}),
      ...(usage ? { usage } : {})
    };
  } catch (error) {
    throw normalizeEngineError(error, readApiKey(request.binding, options.getEnv));
  }
}

export function continueViaAiSdk(input: ContinueWithToolResultsInput, options: Omit<NonStreamingOptions, "continuation"> = {}): Promise<EngineResult> {
  return sendViaAiSdk(input.request, {
    ...options,
    continuation: { response: input.response, toolResults: input.toolResults }
  });
}

export function normalizeUsage(usage: { inputTokens: number | undefined; outputTokens: number | undefined }) {
  return typeof usage.inputTokens === "number" && typeof usage.outputTokens === "number"
    ? { prompt_tokens: usage.inputTokens, completion_tokens: usage.outputTokens }
    : undefined;
}

export function readMaxOutputTokens(binding: EngineBinding): number | undefined {
  const value = binding.config["max_tokens"];
  return Number.isInteger(value) && (value as number) > 0 ? (value as number) : undefined;
}

export function normalizeEngineError(error: unknown, apiKey?: string): EngineError {
  if (error instanceof EngineError) {
    return apiKey && containsSecret(error, apiKey)
      ? new EngineError(defaultMessageForKind(error.kind), error.kind)
      : error;
  }
  const status = readStatusCode(error);
  if (status === 401 || status === 403) {
    return new EngineError("Authentication with the model provider failed.", EngineErrorKind.AUTH);
  }
  if (status === 429) {
    return new EngineError("The model provider rate limit was exceeded.", EngineErrorKind.RATE_LIMIT);
  }
  if (isLikelyNetworkError(error)) {
    return new EngineError("Network request to the model provider failed.", EngineErrorKind.NETWORK);
  }
  return new EngineError("The model provider request failed.", EngineErrorKind.MODEL_ERROR);
}

function defaultMessageForKind(kind: EngineErrorKindValue): string {
  return kind === EngineErrorKind.AUTH ? "Authentication with the model provider failed." : kind === EngineErrorKind.NETWORK ? "Network request to the model provider failed." : kind === EngineErrorKind.RATE_LIMIT ? "The model provider rate limit was exceeded." : "The model provider request failed.";
}

function containsSecret(error: Error, apiKey: string, depth = 0): boolean {
  if (apiKey.length === 0 || depth > 3) {
    return false;
  }

  if (typeof error.message === "string" && error.message.includes(apiKey)) {
    return true;
  }

  if (typeof error.stack === "string" && error.stack.includes(apiKey)) {
    return true;
  }

  const cause = (error as Error & { cause?: unknown }).cause;
  return cause instanceof Error ? containsSecret(cause, apiKey, depth + 1) : false;
}

function isLikelyNetworkError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) {
    return false;
  }
  const name = typeof (error as { name?: unknown }).name === "string" ? (error as { name: string }).name : "";
  const code = typeof (error as { code?: unknown }).code === "string" ? (error as { code: string }).code : "";
  const message =
    typeof (error as { message?: unknown }).message === "string"
      ? (error as { message: string }).message.toLowerCase()
      : "";
  return (
    name === "AbortError" ||
    name === "APIConnectionError" ||
    name === "APIConnectionTimeoutError" ||
    name === "TimeoutError" ||
    code === "ECONNABORTED" ||
    code === "ECONNREFUSED" ||
    code === "ECONNRESET" ||
    code === "ENOTFOUND" ||
    code === "ETIMEDOUT" ||
    code === "UND_ERR_CONNECT_TIMEOUT" ||
    message.includes("network") ||
    message.includes("timed out") ||
    message.includes("timeout")
  );
}

function readStatusCode(error: unknown): number | null {
  if (APICallError.isInstance(error)) {
    return error.statusCode ?? null;
  }
  if (typeof error !== "object" || error === null) {
    return null;
  }
  const status = (error as { status?: unknown }).status;
  return typeof status === "number" ? status : null;
}
