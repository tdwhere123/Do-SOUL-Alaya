import { streamText, type ToolCallPart } from "ai";
import {
  EngineError,
  EngineErrorKind,
  EngineProvider,
  type ConversationRequest,
  type MessageDeltaEvent,
  type ToolUseBlock
} from "@do-what/protocol";
import {
  normalizeEngineError,
  normalizeUsage,
  readMaxOutputTokens
} from "./ai-sdk-non-streaming.js";
import {
  buildMessages,
  getNonStreamingTools,
  mapFinishReason,
} from "./internal/ai-sdk-helpers.js";
import { isRecord } from "./internal/record-guards.js";
import { readApiKey, resolveLanguageModel } from "./provider-registry.js";
import type { ProviderStreamEvent } from "./provider-types.js";
import type { AiSdkToolDef } from "./ai-sdk-tools.js";

export interface StreamingOptions {
  readonly getEnv?: (key: string) => string | undefined;
  readonly abortSignal?: AbortSignal;
  readonly apiKey?: string;
  readonly conversationToolDefs?: readonly AiSdkToolDef[];
}

export async function* streamViaAiSdk(
  request: ConversationRequest,
  options: StreamingOptions = {}
): AsyncGenerator<ProviderStreamEvent, void, unknown> {
  const apiKey = options.apiKey ?? readApiKey(request.binding, options.getEnv);
  const toolUses: ToolUseBlock[] = [];
  let assistantText = "";
  /** Provider-local delta sequence for events emitted directly from streamViaAiSdk. */
  let providerDeltaIndex = 0;
  let sawTerminalEvent = false;

  try {
    const maxOutputTokens = readMaxOutputTokens(request.binding);
    const fullStream = streamText({
      model: resolveLanguageModel(request.binding, options.getEnv, apiKey),
      maxRetries: 0,
      messages: buildMessages(request),
      ...(request.systemPrompt.length > 0 ? { system: request.systemPrompt } : {}),
      ...(request.binding.enable_tools === false
        ? {}
        : { tools: getNonStreamingTools({ conversationToolDefs: options.conversationToolDefs }) }),
      ...(maxOutputTokens === undefined ? {} : { maxOutputTokens }),
      ...(options.abortSignal ? { abortSignal: options.abortSignal } : {})
    }).fullStream;

    try {
      for await (const event of fullStream) {
        switch (event.type) {
          case "text-delta": {
            const deltaEvent = createDeltaEvent(request, event.text, providerDeltaIndex);
            assistantText += deltaEvent.delta;
            yield deltaEvent;
            providerDeltaIndex += 1;
            break;
          }
          case "tool-call":
            toolUses.push(normalizeToolCall(event));
            break;
          case "finish": {
            sawTerminalEvent = true;
            const finishReason = mapFinishReason(event.finishReason);
            const usage = normalizeUsage(event.totalUsage);

            if (toolUses.length > 0) {
              yield {
                type: "provider.tool_uses",
                result: {
                  message: {
                    role: "assistant",
                    content: assistantText,
                    message_id: createToolUseMessageId(request.binding.provider)
                  },
                  finish_reason: finishReason,
                  ...(usage ? { usage } : {}),
                  tool_uses: toolUses
                }
              };
              return;
            }

            if (providerDeltaIndex === 0) {
              throw new EngineError(
                "The model provider returned no streamed assistant text response.",
                EngineErrorKind.MODEL_ERROR
              );
            }

            if (finishReason !== "stop") {
              yield createDeltaEvent(request, "", providerDeltaIndex, finishReason);
            }

            return;
          }
          case "error":
            throw event.error;
          default:
            break;
        }
      }

      throw new EngineError(
        "The model provider terminated the stream before a finish event.",
        EngineErrorKind.MODEL_ERROR
      );
    } finally {
      if (!sawTerminalEvent) {
        await fullStream.cancel?.();
      }
    }
  } catch (error) {
    throw normalizeEngineError(error, apiKey);
  }
}

function createDeltaEvent(
  request: ConversationRequest,
  delta: string,
  index: number,
  finishReason?: MessageDeltaEvent["finishReason"]
): MessageDeltaEvent {
  return {
    type: "message.delta",
    runId: request.runtime_context?.run_id ?? "_",
    messageId: request.runtime_context?.assistant_message_id ?? "_",
    delta,
    index,
    ...(finishReason === undefined ? {} : { finishReason }),
    timestamp: new Date().toISOString()
  };
}

function normalizeToolCall(
  toolCall: ToolCallPart
): ToolUseBlock {
  if (!isRecord(toolCall.input)) {
    throw new EngineError(
      `The model provider returned an invalid tool call payload for ${toolCall.toolName}.`,
      EngineErrorKind.MODEL_ERROR
    );
  }

  return {
    type: "tool_use",
    id: toolCall.toolCallId,
    name: toolCall.toolName,
    input: toolCall.input
  };
}

function createToolUseMessageId(provider: EngineProvider): string {
  switch (provider) {
    case EngineProvider.OPENAI:
      return "openai-stream-tool-use";
    case EngineProvider.ANTHROPIC:
      return "anthropic-stream-tool-use";
    default:
      return `${provider}-stream-tool-use`;
  }
}
