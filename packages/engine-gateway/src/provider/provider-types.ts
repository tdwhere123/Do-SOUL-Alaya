/**
 * BOUNDARY CONTRACT - AI SDK Core (A2a)
 *
 * AI SDK Core/provider types (LanguageModel, generateText/streamText result types, etc.)
 * are ONLY allowed inside packages/engine-gateway/src/.
 * They MUST be normalized to Alaya protocol types before leaving this package:
 *   - EngineResult       (non-streaming response)
 *   - MessageDeltaEvent  (streaming text delta)
 *   - ToolUseBlock       (tool-call payload)
 *   - EngineError        (all provider errors)
 *
 * Full provider adapters are deferred to #BL-008 for Alaya v0.1.
 */
import type { ConversationRequest, EngineResult, MessageDeltaEvent } from "@do-soul/alaya-protocol";
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

// Internal provider interface. Do not expose AI SDK types in return or parameter positions.
export interface ConversationProvider {
  send(request: ConversationRequest, apiKey: string, baseUrl: string | null): Promise<EngineResult>;
  continueWithToolResults?(input: ContinueWithToolResultsInput): Promise<EngineResult>;
}
