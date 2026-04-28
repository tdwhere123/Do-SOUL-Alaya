/**
 * BOUNDARY CONTRACT — AI SDK Core (A2a)
 *
 * AI SDK Core/provider types (LanguageModel, generateText/streamText result types, etc.)
 * are ONLY allowed inside packages/engine-gateway/src/.
 * They MUST be normalized to do-what protocol types before leaving this package:
 *   - EngineResult       (non-streaming response)
 *   - MessageDeltaEvent  (streaming text delta)
 *   - ToolUseBlock       (tool-call payload)
 *   - EngineError        (all provider errors)
 *
 * See task-a2a-1-ai-sdk-core-boundary-freeze.md for normalization mapping tables.
 */
import type { ConversationRequest, EngineResult, MessageDeltaEvent } from "@do-what/protocol";
import type { McpToolResultBlock } from "../mcp-bridge.js";

export interface ProviderToolUseStreamEvent {
  readonly type: "provider.tool_uses";
  readonly result: EngineResult;
}

export type ProviderStreamEvent = MessageDeltaEvent | ProviderToolUseStreamEvent;

export interface ContinueWithToolResultsInput {
  readonly apiKey: string;
  readonly baseUrl: string | null;
  readonly request: ConversationRequest;
  readonly response: EngineResult;
  readonly toolResults: readonly McpToolResultBlock[];
}

// Internal provider interface. Do NOT use AI SDK types in the return/param positions below.
export interface ConversationProvider {
  send(request: ConversationRequest, apiKey: string, baseUrl: string | null): Promise<EngineResult>;
  continueWithToolResults?(input: ContinueWithToolResultsInput): Promise<EngineResult>;
}
