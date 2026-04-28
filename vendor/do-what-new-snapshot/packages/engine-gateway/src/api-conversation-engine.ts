import {
  EngineError,
  EngineErrorKind,
  EngineProvider,
  type ConversationEnginePort,
  type ConversationRequest,
  type EngineBinding,
  type EngineBindingSummary,
  type EngineBindingTestPort,
  type EngineResult,
  type MessageDeltaEvent
} from "@do-what/protocol";
import type { McpBridge, McpToolResultBlock } from "./mcp-bridge.js";
import type { AiSdkToolDef } from "./provider/ai-sdk-tools.js";
import {
  continueViaAiSdk,
  normalizeEngineError,
  sendViaAiSdk
} from "./provider/ai-sdk-non-streaming.js";
import { streamViaAiSdk } from "./provider/ai-sdk-streaming.js";
import { readApiKey } from "./provider/provider-registry.js";
import type { ConversationProvider, ProviderStreamEvent } from "./provider/provider-types.js";

export interface APIConversationEngineDependencies {
  readonly anthropicProvider?: ConversationProvider;
  readonly getEnv?: (name: string) => string | undefined;
  readonly getAbortSignal?: (request: ConversationRequest) => AbortSignal | undefined;
  readonly getConversationToolDefs?: () => readonly AiSdkToolDef[];
  readonly mcpBridge?: Pick<McpBridge, "executeToolUses">;
  readonly openaiProvider?: ConversationProvider;
  readonly customProvider?: ConversationProvider;
}

export class APIConversationEngine implements ConversationEnginePort, EngineBindingTestPort {
  readonly #anthropicProvider?: ConversationProvider;
  readonly #getAbortSignal?: (request: ConversationRequest) => AbortSignal | undefined;
  readonly #getConversationToolDefs?: () => readonly AiSdkToolDef[];
  readonly #getEnv: (name: string) => string | undefined;
  readonly #mcpBridge?: Pick<McpBridge, "executeToolUses">;
  readonly #openaiProvider?: ConversationProvider;
  readonly #customProvider?: ConversationProvider;

  constructor(dependencies: APIConversationEngineDependencies = {}) {
    this.#getAbortSignal = dependencies.getAbortSignal;
    this.#getConversationToolDefs = dependencies.getConversationToolDefs;
    this.#getEnv = dependencies.getEnv ?? ((name) => process.env[name]);
    this.#mcpBridge = dependencies.mcpBridge;
    this.#anthropicProvider = dependencies.anthropicProvider;
    this.#openaiProvider = dependencies.openaiProvider;
    this.#customProvider = dependencies.customProvider;
  }

  async sendMessage(request: ConversationRequest): Promise<EngineResult> {
    const provider = this.resolveProviderOverride(request.binding);
    const redactionApiKey = readApiKey(request.binding, this.#getEnv);

    console.info("[engine] sendMessage", {
      provider: request.binding.provider,
      model: request.binding.model,
      enable_tools_override: request.binding.enable_tools ?? "default"
    });

    try {
      let result =
        provider === undefined
          ? await sendViaAiSdk(request, {
              getEnv: this.#getEnv,
              conversationToolDefs: this.#getConversationToolDefs?.()
            })
          : await provider.send(request, "", request.binding.base_url ?? null);
      let remainingLoops = 3;

      while ((result.tool_uses?.length ?? 0) > 0) {
        console.info("[engine:tool-loop] executing tool uses", {
          count: result.tool_uses!.length,
          names: result.tool_uses!.map((toolUse) => toolUse.name)
        });

        if (this.#mcpBridge === undefined) {
          throw new EngineError("MCP bridge is not configured for tool use handling.", EngineErrorKind.MODEL_ERROR);
        }

        const toolResults = await this.#mcpBridge.executeToolUses(result.tool_uses ?? [], request.runtime_context);

        console.info("[engine:tool-loop] tool results received", {
          count: toolResults.length,
          errors: toolResults.filter((result) => result.is_error).length
        });

        result = await this.continueAfterToolResults({
          apiKey: "",
          baseUrl: request.binding.base_url ?? null,
          provider,
          request,
          response: result,
          toolResults
        });

        remainingLoops -= 1;
        if (remainingLoops <= 0 && (result.tool_uses?.length ?? 0) > 0) {
          throw new EngineError("The model exceeded the maximum MCP tool loop depth.", EngineErrorKind.MODEL_ERROR);
        }
      }

      return result;
    } catch (error) {
      throw normalizeEngineError(error, redactionApiKey);
    }
  }

  async *streamMessage(request: ConversationRequest): AsyncGenerator<MessageDeltaEvent, void, unknown> {
    const apiKey = this.resolveApiKey(request.binding);
    const abortSignal = this.#getAbortSignal?.(request);

    try {
      /**
       * role: sequence for deltas yielded from APIConversationEngine.streamMessage.
       * This is intentionally separate from the provider-local index inside
       * streamViaAiSdk, because tool-loop continuations append new deltas after
       * provider streaming has already emitted its own indexes.
       */
      let streamOutputIndex = 0;

      for await (const event of streamViaAiSdk(request, {
        getEnv: this.#getEnv,
        apiKey,
        conversationToolDefs: this.#getConversationToolDefs?.(),
        ...(abortSignal ? { abortSignal } : {})
      })) {
        if (isProviderToolUseStreamEvent(event)) {
          const result = await this.runToolLoopForStreaming({
            apiKey,
            abortSignal,
            baseUrl: request.binding.base_url ?? null,
            request,
            result: event.result
          });

          if (result.message.content.length > 0) {
            yield {
              type: "message.delta",
              runId: request.runtime_context?.run_id ?? "_",
              messageId: request.runtime_context?.assistant_message_id ?? result.message.message_id,
              delta: result.message.content,
              index: streamOutputIndex,
              finishReason: result.finish_reason,
              timestamp: new Date().toISOString()
            };
            streamOutputIndex += 1;
          }
          continue;
        }

        yield event;
        streamOutputIndex = Math.max(streamOutputIndex, event.index + 1);
      }
    } catch (error) {
      throw normalizeEngineError(error, apiKey);
    }
  }

  private async runToolLoopForStreaming(input: {
    readonly apiKey: string;
    readonly abortSignal?: AbortSignal;
    readonly baseUrl: string | null;
    readonly request: ConversationRequest;
    readonly result: EngineResult;
  }): Promise<EngineResult> {
    let result = input.result;
    let remainingLoops = 3;

    while ((result.tool_uses?.length ?? 0) > 0) {
      console.info("[engine:tool-loop] executing streamed tool uses", {
        count: result.tool_uses!.length,
        names: result.tool_uses!.map((toolUse) => toolUse.name)
      });

      if (this.#mcpBridge === undefined) {
        throw new EngineError("MCP bridge is not configured for tool use handling.", EngineErrorKind.MODEL_ERROR);
      }

      const toolResults = await this.#mcpBridge.executeToolUses(result.tool_uses ?? [], input.request.runtime_context);

      result = await continueViaAiSdk({
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        request: input.request,
        response: result,
        toolResults
      }, {
        getEnv: this.#getEnv,
        conversationToolDefs: this.#getConversationToolDefs?.(),
        ...(input.abortSignal ? { abortSignal: input.abortSignal } : {})
      });

      remainingLoops -= 1;
      if (remainingLoops <= 0 && (result.tool_uses?.length ?? 0) > 0) {
        throw new EngineError("The model exceeded the maximum MCP tool loop depth.", EngineErrorKind.MODEL_ERROR);
      }
    }

    return result;
  }

  async testBinding(binding: EngineBinding): Promise<EngineBindingSummary & {
    readonly available_models: readonly string[];
  }> {
    await this.sendMessage({
      messages: [{ role: "user", content: "Reply with OK." }],
      systemPrompt: "Connection test.",
      contextLens: null,
      binding: {
        ...binding,
        enable_tools: false
      }
    });

    return {
      provider_type: binding.provider,
      base_url: binding.base_url ?? null,
      model: binding.model,
      available_models: []
    };
  }

  private resolveApiKey(binding: EngineBinding): string {
    const apiKey = readApiKey(binding, this.#getEnv);
    if (!apiKey) {
      throw new EngineError("Authentication with the model provider failed.", EngineErrorKind.AUTH);
    }
    return apiKey;
  }

  private async continueAfterToolResults(input: {
    readonly apiKey: string;
    readonly baseUrl: string | null;
    readonly provider?: ConversationProvider;
    readonly request: ConversationRequest;
    readonly response: EngineResult;
    readonly toolResults: readonly McpToolResultBlock[];
  }): Promise<EngineResult> {
    if (typeof input.provider?.continueWithToolResults === "function") {
      return input.provider.continueWithToolResults(input);
    }

    return continueViaAiSdk(
      {
        apiKey: input.apiKey,
        baseUrl: input.baseUrl,
        request: input.request,
        response: input.response,
        toolResults: input.toolResults
      },
      {
        getEnv: this.#getEnv,
        conversationToolDefs: this.#getConversationToolDefs?.()
      }
    );
  }

  private resolveProviderOverride(binding: EngineBinding): ConversationProvider | undefined {
    switch (binding.provider) {
      case EngineProvider.OPENAI:
        return this.#openaiProvider;
      case EngineProvider.CUSTOM:
        if ((binding.base_url ?? null) === null) {
          throw new EngineError("Custom providers require a base URL.", EngineErrorKind.MODEL_ERROR);
        }
        return this.#customProvider;
      case EngineProvider.ANTHROPIC:
        return this.#anthropicProvider;
      default:
        throw new EngineError(`Unsupported engine provider: ${binding.provider}`, EngineErrorKind.MODEL_ERROR);
    }
  }
}

function isProviderToolUseStreamEvent(
  event: ProviderStreamEvent
): event is Extract<ProviderStreamEvent, { type: "provider.tool_uses" }> {
  return event.type === "provider.tool_uses";
}
