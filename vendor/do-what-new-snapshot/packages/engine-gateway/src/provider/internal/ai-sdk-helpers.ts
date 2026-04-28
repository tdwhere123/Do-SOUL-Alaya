import type { FinishReason, JSONValue, ModelMessage, ToolResultPart, ToolSet } from "ai";
import {
  EngineError,
  EngineErrorKind,
  type ConversationRequest,
  type EngineFinishReason,
  type EnginePortMessage,
  type ToolUseBlock
} from "@do-what/protocol";
import type { McpToolResultBlock } from "../../mcp-bridge.js";
import { buildAiSdkTools } from "../ai-sdk-tools.js";
import type { AiSdkToolDef } from "../ai-sdk-tools.js";
import { soulToolDefs } from "../soul-tool-specs.js";
import type { NonStreamingOptions } from "../ai-sdk-non-streaming.js";
import { isRecord } from "./record-guards.js";

export function getNonStreamingTools(input?: {
  readonly conversationToolDefs?: readonly AiSdkToolDef[];
}): ToolSet {
  return buildAiSdkTools([
    ...soulToolDefs,
    ...(input?.conversationToolDefs ?? [])
  ]);
}

export function buildMessages(
  request: ConversationRequest,
  continuation?: NonStreamingOptions["continuation"]
): ModelMessage[] {
  const messages = request.messages.map(buildMessage);

  if (continuation === undefined) {
    return messages;
  }

  const assistantContent: Array<
    { type: "text"; text: string } |
    { type: "tool-call"; toolCallId: string; toolName: string; input: Readonly<Record<string, unknown>> }
  > = [];

  if (continuation.response.message.content.length > 0) {
    assistantContent.push({ type: "text" as const, text: continuation.response.message.content });
  }

  for (const toolUse of continuation.response.tool_uses ?? []) {
    assistantContent.push({
      type: "tool-call" as const,
      toolCallId: toolUse.id,
      toolName: toolUse.name,
      input: toolUse.input
    });
  }

  if (assistantContent.length > 0) {
    messages.push({ role: "assistant", content: assistantContent });
  }

  if (continuation.toolResults.length > 0) {
    messages.push({
      role: "tool",
      content: continuation.toolResults.map((result) =>
        buildToolResultPart(result, continuation.response.tool_uses)
      )
    });
  }

  return messages;
}

export function mapFinishReason(finishReason: FinishReason): EngineFinishReason {
  return finishReason === "length"
    ? "length"
    : finishReason === "content-filter" || finishReason === "error"
      ? "error"
      : "stop";
}

export function normalizeToolUses(
  toolCalls: Array<{ toolCallId: string; toolName: string; input: unknown }>
): readonly ToolUseBlock[] | undefined {
  const toolUses = toolCalls.map((toolCall) => {
    if (!isRecord(toolCall.input)) {
      throw new EngineError(
        `The model provider returned an invalid tool call payload for ${toolCall.toolName}.`,
        EngineErrorKind.MODEL_ERROR
      );
    }

    return {
      type: "tool_use" as const,
      id: toolCall.toolCallId,
      name: toolCall.toolName,
      input: toolCall.input
    };
  });

  return toolUses.length > 0 ? toolUses : undefined;
}

function buildMessage(message: EnginePortMessage): ModelMessage {
  if (message.role !== "user") {
    return { role: message.role, content: message.content };
  }

  const attachments = message.attachments ?? [];

  if (attachments.length === 0) {
    return { role: "user", content: message.content };
  }

  const content: Array<
    { type: "text"; text: string } |
    { type: "image"; image: string; mediaType: string }
  > = message.content.length > 0 ? [{ type: "text", text: message.content }] : [];

  for (const attachment of attachments) {
    if (attachment.type === "image") {
      content.push({ type: "image", image: attachment.data, mediaType: attachment.mime_type });
    } else if (attachment.type === "text_file") {
      content.push({ type: "text", text: attachment.content });
    }
  }

  return { role: "user", content };
}

function buildToolResultPart(
  result: McpToolResultBlock,
  toolUses: readonly ToolUseBlock[] | undefined
): ToolResultPart {
  const toolName = toolUses?.find((toolUse) => toolUse.id === result.tool_use_id)?.name ?? "unknown.tool";
  const parsed = parseJson(result.content);

  return {
    type: "tool-result",
    toolCallId: result.tool_use_id,
    toolName,
    output: result.is_error
      ? parsed === undefined
        ? { type: "error-text", value: result.content }
        : { type: "error-json", value: parsed }
      : parsed === undefined
        ? { type: "text", value: result.content }
        : { type: "json", value: parsed }
  };
}

function parseJson(value: string): JSONValue | undefined {
  try {
    return JSON.parse(value) as JSONValue;
  } catch {
    return undefined;
  }
}
