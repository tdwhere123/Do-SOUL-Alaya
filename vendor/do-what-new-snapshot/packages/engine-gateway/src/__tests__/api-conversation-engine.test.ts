import type { LanguageModelV3GenerateResult } from "@ai-sdk/provider";
import { APICallError } from "ai";
import { MockLanguageModelV3 } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EngineError,
  EngineErrorKind,
  EngineProvider,
  type CandidateMemorySignalInput,
  type ConversationEnginePort,
  type ConversationRequest
} from "@do-what/protocol";
import { APIConversationEngine } from "../api-conversation-engine.js";
import { createGenerateResult } from "./ai-sdk-test-helpers.js";
import { continueViaAiSdk, sendViaAiSdk } from "../provider/ai-sdk-non-streaming.js";

const providerRegistryMock = vi.hoisted(() => ({
  resolveLanguageModel: vi.fn()
}));

vi.mock("../provider/provider-registry.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../provider/provider-registry.js")>();
  return {
    ...actual,
    resolveLanguageModel: providerRegistryMock.resolveLanguageModel
  };
});

const candidateSignalInput: CandidateMemorySignalInput = {
  workspace_id: "workspace-1",
  run_id: "run-1",
  surface_id: null,
  signal_kind: "potential_claim",
  object_kind: "constraint",
  scope_hint: null,
  domain_tags: ["security"],
  confidence: 0.5,
  evidence_refs: ["msg-1"],
  raw_payload: { excerpt: "Never print secrets." }
};

const openAIBinding = {
  binding_id: "binding-openai",
  provider: EngineProvider.OPENAI,
  base_url: null,
  model: "gpt-4o-mini",
  api_key_ref: "OPENAI_API_KEY",
  config: {}
} as const;

const anthropicBinding = {
  binding_id: "binding-anthropic",
  provider: EngineProvider.ANTHROPIC,
  base_url: null,
  model: "claude-sonnet-4-5",
  api_key_ref: "ANTHROPIC_API_KEY",
  config: { max_tokens: 2048 }
} as const;

function createRequest(binding: ConversationRequest["binding"]): ConversationRequest {
  return {
    messages: [
      { role: "system", content: "Nested system note." },
      { role: "user", content: "Hello" },
      { role: "assistant", content: "Previous reply" }
    ],
    systemPrompt: "You are helpful.",
    contextLens: null,
    binding
  };
}

function useMockModel(
  doGenerate: MockLanguageModelV3["doGenerate"] | LanguageModelV3GenerateResult
): MockLanguageModelV3 {
  const model = new MockLanguageModelV3({ doGenerate });
  providerRegistryMock.resolveLanguageModel.mockReturnValue(model);
  return model;
}

describe("AI SDK non-streaming adapter", () => {
  beforeEach(() => {
    providerRegistryMock.resolveLanguageModel.mockReset();
  });

  it("shapes messages, tools, and usage through MockLanguageModelV3", async () => {
    const model = useMockModel(
      createGenerateResult({
        text: "AI SDK says hi",
        responseId: "msg-ai-sdk-openai",
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        content: [
          { type: "text", text: "AI SDK says hi" },
          {
            type: "tool-call",
            toolCallId: "toolu_1",
            toolName: "soul.emit_candidate_signal",
            input: JSON.stringify(candidateSignalInput)
          }
        ]
      })
    );

    const result = await sendViaAiSdk(
      {
        ...createRequest({ ...openAIBinding, config: { max_tokens: 333 } }),
        messages: [
          { role: "system", content: "Nested system note." },
          {
            role: "user",
            content: "Hello",
            attachments: [
              { type: "image", mime_type: "image/png", data: "QUJD" },
              { type: "text_file", filename: "notes.txt", content: "Attachment text" },
              { type: "unsupported", filename: "archive.zip", mime_type: "application/zip" }
            ]
          },
          { role: "assistant", content: "Previous reply" }
        ]
      },
      { getEnv: () => "sk-openai" }
    );

    expect(model.doGenerateCalls[0]).toMatchObject({
      maxOutputTokens: 333,
      prompt: [
        { role: "system", content: "You are helpful." },
        { role: "system", content: "Nested system note." },
        {
          role: "user",
          content: [
            { type: "text", text: "Hello" },
            expect.objectContaining({ type: "file", mediaType: "image/png" }),
            { type: "text", text: "Attachment text" }
          ]
        },
        { role: "assistant", content: [{ type: "text", text: "Previous reply" }] }
      ]
    });
    expect((model.doGenerateCalls[0].tools ?? []).map((toolDef) => toolDef.name)).toEqual([
      "soul.emit_candidate_signal",
      "soul.apply_override",
      "soul.explore_graph"
    ]);
    expect(result).toEqual({
      message: { role: "assistant", content: "AI SDK says hi", message_id: "msg-ai-sdk-openai" },
      finish_reason: "stop",
      tool_uses: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "soul.emit_candidate_signal",
          input: candidateSignalInput
        }
      ],
      usage: { prompt_tokens: 11, completion_tokens: 7 }
    });
  });

  it("omits tools when the binding disables them", async () => {
    const model = useMockModel(createGenerateResult({ text: "No tool support", responseId: "msg-no-tools" }));

    await sendViaAiSdk(
      createRequest({ ...openAIBinding, enable_tools: false }),
      { getEnv: () => "sk-openai" }
    );

    expect(model.doGenerateCalls[0].tools).toBeUndefined();
  });

  it("throws model_error when a non-streaming tool call payload is not an object", async () => {
    useMockModel(
      createGenerateResult({
        text: "",
        responseId: "msg-invalid-tool",
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        content: [
          {
            type: "tool-call",
            toolCallId: "toolu_invalid",
            toolName: "soul.emit_candidate_signal",
            input: JSON.stringify("not-an-object")
          }
        ]
      })
    );

    await expect(
      sendViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" })
    ).rejects.toMatchObject({
      kind: EngineErrorKind.MODEL_ERROR,
      message: "The model provider returned an invalid tool call payload for soul.emit_candidate_signal."
    });
  });

  it("appends continuation tool calls and tool results", async () => {
    const model = useMockModel(createGenerateResult({ text: "Signal emitted.", responseId: "msg-ai-sdk-final" }));

    await continueViaAiSdk(
      {
        apiKey: "ignored",
        baseUrl: null,
        request: createRequest(openAIBinding),
        response: {
          message: { role: "assistant", content: "Working on it", message_id: "msg-ai-sdk-tool" },
          finish_reason: "stop",
          tool_uses: [
            {
              type: "tool_use",
              id: "toolu_3",
              name: "soul.emit_candidate_signal",
              input: candidateSignalInput
            }
          ]
        },
        toolResults: [
          {
            type: "tool_result",
            tool_use_id: "toolu_3",
            content: JSON.stringify({ signal_id: "signal-1", status: "emitted" })
          }
        ]
      },
      { getEnv: () => "sk-openai" }
    );

    expect(model.doGenerateCalls[0].prompt).toMatchObject([
      { role: "system", content: "You are helpful." },
      { role: "system", content: "Nested system note." },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Previous reply" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "Working on it" },
          {
            type: "tool-call",
            toolCallId: "toolu_3",
            toolName: "soul.emit_candidate_signal",
            input: candidateSignalInput
          }
        ]
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_3",
            toolName: "soul.emit_candidate_signal",
            output: {
              type: "json",
              value: { signal_id: "signal-1", status: "emitted" }
            }
          }
        ]
      }
    ]);
  });
});

describe("APIConversationEngine", () => {
  beforeEach(() => {
    providerRegistryMock.resolveLanguageModel.mockReset();
  });

  it("implements the ConversationEnginePort contract", () => {
    const engine: ConversationEnginePort = new APIConversationEngine({ getEnv: () => "sk-test" });
    expect(engine).toBeInstanceOf(APIConversationEngine);
  });

  it("preserves the injected provider seam for sendMessage", async () => {
    const injectedProvider = {
      send: vi.fn().mockResolvedValue({
        message: {
          role: "assistant",
          content: "Injected provider reply",
          message_id: "msg-injected"
        },
        finish_reason: "stop"
      }),
      continueWithToolResults: vi.fn()
    };
    const engine = new APIConversationEngine({
      getEnv: () => "sk-openai",
      openaiProvider: injectedProvider
    });

    const result = await engine.sendMessage(createRequest(openAIBinding));

    expect(injectedProvider.send).toHaveBeenCalledWith(createRequest(openAIBinding), "", null);
    expect(result.message.content).toBe("Injected provider reply");
  });

  it("routes OpenAI requests and ignores contextLens null", async () => {
    const request = createRequest(openAIBinding);
    const model = useMockModel(createGenerateResult({ text: "AI SDK says hi", responseId: "msg-ai-sdk-openai" }));
    const engine = new APIConversationEngine({
      getEnv: (name) => (name === "OPENAI_API_KEY" ? "sk-openai" : undefined)
    });

    const result = await engine.sendMessage(request);

    expect(providerRegistryMock.resolveLanguageModel).toHaveBeenCalledWith(request.binding, expect.any(Function));
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(result.message.content).toBe("AI SDK says hi");
  });

  it("routes Anthropic requests", async () => {
    const request = createRequest(anthropicBinding);
    useMockModel(createGenerateResult({ text: "Anthropic says hi", responseId: "msg-ai-sdk-anthropic" }));
    const engine = new APIConversationEngine({
      getEnv: (name) => (name === "ANTHROPIC_API_KEY" ? "sk-anthropic" : undefined)
    });

    const result = await engine.sendMessage(request);

    expect(providerRegistryMock.resolveLanguageModel).toHaveBeenCalledWith(request.binding, expect.any(Function));
    expect(result.message.content).toBe("Anthropic says hi");
  });

  it("routes custom providers through the OpenAI-compatible path", async () => {
    const request = createRequest({
      binding_id: "binding-custom",
      provider: EngineProvider.CUSTOM,
      base_url: "https://proxy.example/v1",
      model: "proxy-model",
      api_key: "sk-custom",
      config: {}
    });
    useMockModel(createGenerateResult({ text: "Custom path says hi", responseId: "msg-ai-sdk-custom" }));
    const engine = new APIConversationEngine({ getEnv: () => undefined });

    const result = await engine.sendMessage(request);

    expect(providerRegistryMock.resolveLanguageModel).toHaveBeenCalledWith(request.binding, expect.any(Function));
    expect(result.message.content).toBe("Custom path says hi");
  });

  it("routes tool_use blocks through the MCP bridge and continues the provider exchange", async () => {
    const request = createRequest(openAIBinding);
    const responses = [
      createGenerateResult({
        text: "",
        responseId: "msg-openai-tool-loop",
        finishReason: { unified: "tool-calls", raw: "tool-calls" },
        content: [
          {
            type: "tool-call",
            toolCallId: "toolu_3",
            toolName: "soul.emit_candidate_signal",
            input: JSON.stringify(candidateSignalInput)
          }
        ]
      }),
      createGenerateResult({ text: "Signal emitted.", responseId: "msg-openai-final" })
    ];
    const model = useMockModel(async () => {
      const response = responses.shift();
      if (response === undefined) {
        throw new Error("Unexpected extra generateText call");
      }
      return response;
    });
    const mcpBridge = {
      executeToolUses: vi.fn().mockResolvedValue([
        {
          type: "tool_result",
          tool_use_id: "toolu_3",
          content: JSON.stringify({ signal_id: "signal-1", status: "emitted" })
        }
      ])
    };
    const engine = new APIConversationEngine({ getEnv: () => "sk-openai", mcpBridge });

    const result = await engine.sendMessage(request);

    expect(mcpBridge.executeToolUses).toHaveBeenCalledWith(
      [
        {
          type: "tool_use",
          id: "toolu_3",
          name: "soul.emit_candidate_signal",
          input: candidateSignalInput
        }
      ],
      request.runtime_context
    );
    expect(model.doGenerateCalls).toHaveLength(2);
    expect(result.message.content).toBe("Signal emitted.");
  });

  it("returns the provider result directly when no tool_use blocks are present", async () => {
    useMockModel(createGenerateResult({ text: "No tool call.", responseId: "msg-openai-no-tool" }));
    const engine = new APIConversationEngine({ getEnv: () => "sk-openai" });

    const result = await engine.sendMessage(createRequest(openAIBinding));

    expect(result.message.content).toBe("No tool call.");
  });

  it("tests a binding and returns normalized provider info", async () => {
    useMockModel(createGenerateResult({ text: "OK", responseId: "msg-test-1" }));
    const engine = new APIConversationEngine({ getEnv: () => undefined });

    await expect(
      engine.testBinding({
        binding_id: "binding-test",
        provider: EngineProvider.CUSTOM,
        base_url: "https://proxy.example/v1",
        api_key: "sk-custom",
        model: "proxy-model",
        config: {}
      })
    ).resolves.toEqual({
      provider_type: EngineProvider.CUSTOM,
      base_url: "https://proxy.example/v1",
      model: "proxy-model",
      available_models: []
    });
  });

  it("tests a binding without requiring an MCP bridge when the model would otherwise emit tools", async () => {
    useMockModel(
      createGenerateResult({
        text: "OK",
        responseId: "msg-test-tool-free",
        toolCalls: [
          {
            toolCallId: "tool-call-1",
            toolName: "soul.emit_candidate_signal",
            input: candidateSignalInput
          }
        ]
      })
    );
    const engine = new APIConversationEngine({ getEnv: () => undefined });

    await expect(
      engine.testBinding({
        binding_id: "binding-test",
        provider: EngineProvider.CUSTOM,
        base_url: "https://proxy.example/v1",
        api_key: "sk-custom",
        model: "proxy-model",
        config: {}
      })
    ).resolves.toMatchObject({
      provider_type: EngineProvider.CUSTOM,
      model: "proxy-model"
    });
  });

  it("surfaces auth failure from provider-registry resolution", async () => {
    providerRegistryMock.resolveLanguageModel.mockImplementation(() => {
      throw new EngineError("Authentication with the model provider failed.", EngineErrorKind.AUTH);
    });
    const engine = new APIConversationEngine({ getEnv: () => undefined });

    await expect(engine.sendMessage(createRequest(openAIBinding))).rejects.toMatchObject({
      kind: EngineErrorKind.AUTH,
      message: "Authentication with the model provider failed."
    });
    expect(providerRegistryMock.resolveLanguageModel).toHaveBeenCalled();
  });

  it("maps 401 responses to auth errors", async () => {
    useMockModel(async () => {
      throw new APICallError({
        message: "bad key",
        statusCode: 401,
        url: "https://api.example.test/v1/chat",
        requestBodyValues: {}
      });
    });
    const engine = new APIConversationEngine({ getEnv: () => "sk-openai" });

    await expect(engine.sendMessage(createRequest(openAIBinding))).rejects.toMatchObject({
      kind: EngineErrorKind.AUTH,
      message: "Authentication with the model provider failed."
    });
  });

  it("maps 429 responses to rate limit errors", async () => {
    useMockModel(async () => {
      throw new APICallError({
        message: "too many requests",
        statusCode: 429,
        url: "https://api.example.test/v1/chat",
        requestBodyValues: {}
      });
    });
    const engine = new APIConversationEngine({ getEnv: () => "sk-openai" });

    await expect(engine.sendMessage(createRequest(openAIBinding))).rejects.toMatchObject({
      kind: EngineErrorKind.RATE_LIMIT,
      message: "The model provider rate limit was exceeded."
    });
  });

  it("maps network-like failures to network errors", async () => {
    useMockModel(async () => {
      const error = new Error("timed out");
      error.name = "APIConnectionTimeoutError";
      throw error;
    });
    const engine = new APIConversationEngine({ getEnv: () => "sk-openai" });

    await expect(engine.sendMessage(createRequest(openAIBinding))).rejects.toMatchObject({
      kind: EngineErrorKind.NETWORK,
      message: "Network request to the model provider failed."
    });
  });

  it("maps unknown failures to model errors", async () => {
    useMockModel(async () => {
      throw new Error("weird provider failure");
    });
    const engine = new APIConversationEngine({ getEnv: () => "sk-openai" });

    await expect(engine.sendMessage(createRequest(openAIBinding))).rejects.toMatchObject({
      kind: EngineErrorKind.MODEL_ERROR,
      message: "The model provider request failed."
    });
  });

  it("does not leak the API key in surfaced errors", async () => {
    useMockModel(async () => {
      throw new EngineError("provider failed with sk-secret-value", EngineErrorKind.AUTH);
    });
    const engine = new APIConversationEngine({
      getEnv: () => "sk-secret-value"
    });

    await expect(engine.sendMessage(createRequest(openAIBinding))).rejects.toMatchObject({
      kind: EngineErrorKind.AUTH,
      message: "Authentication with the model provider failed."
    });
  });

  it("redacts api keys that only appear in nested causes", async () => {
    useMockModel(async () => {
      const inner = new Error("inner failure with sk-secret-value");
      const outer = new EngineError("safe top-level message", EngineErrorKind.MODEL_ERROR) as EngineError & {
        cause?: unknown;
      };
      outer.cause = inner;
      throw outer;
    });
    const engine = new APIConversationEngine({
      getEnv: () => "sk-secret-value"
    });

    await expect(engine.sendMessage(createRequest(openAIBinding))).rejects.toMatchObject({
      kind: EngineErrorKind.MODEL_ERROR,
      message: "The model provider request failed."
    });
  });

  it("throws after exceeding the non-streaming MCP tool loop depth limit", async () => {
    const responses = Array.from({ length: 4 }, (_, index) => createGenerateResult({
      text: "",
      responseId: `msg-tool-loop-${index}`,
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
      content: [
        {
          type: "tool-call",
          toolCallId: `toolu_loop_${index}`,
          toolName: "soul.emit_candidate_signal",
          input: JSON.stringify(candidateSignalInput)
        }
      ]
    }));
    useMockModel(async () => {
      const response = responses.shift();
      if (!response) {
        throw new Error("unexpected extra generateText call");
      }
      return response;
    });
    const engine = new APIConversationEngine({
      getEnv: () => "sk-openai",
      mcpBridge: {
        executeToolUses: vi.fn(async (toolUses) => toolUses.map((toolUse) => ({
          type: "tool_result" as const,
          tool_use_id: toolUse.id,
          content: JSON.stringify({ status: "ok" })
        })))
      }
    });

    await expect(engine.sendMessage(createRequest(openAIBinding))).rejects.toMatchObject({
      kind: EngineErrorKind.MODEL_ERROR,
      message: "The model exceeded the maximum MCP tool loop depth."
    });
  });
});
