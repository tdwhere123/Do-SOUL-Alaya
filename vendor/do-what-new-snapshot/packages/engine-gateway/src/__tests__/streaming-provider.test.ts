import { streamText } from "ai";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  EngineErrorKind,
  EngineProvider,
  MessageDeltaEventSchema,
  type ConversationRequest,
  type MessageDeltaEvent
} from "@do-what/protocol";
import { APIConversationEngine } from "../api-conversation-engine.js";
import { streamViaAiSdk } from "../provider/ai-sdk-streaming.js";
import { resolveLanguageModel } from "../provider/provider-registry.js";
import { createGenerateResult } from "./ai-sdk-test-helpers.js";

vi.mock("ai", async () => {
  const actual = await vi.importActual<typeof import("ai")>("ai");

  return {
    ...actual,
    streamText: vi.fn()
  };
});

vi.mock("../provider/provider-registry.js", async () => {
  const actual = await vi.importActual<typeof import("../provider/provider-registry.js")>(
    "../provider/provider-registry.js"
  );

  return {
    ...actual,
    resolveLanguageModel: vi.fn()
  };
});

const resolveLanguageModelMock = vi.mocked(resolveLanguageModel);
const streamTextMock = vi.mocked(streamText);

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
  config: {
    max_tokens: 2048
  }
} as const;

const candidateSignalInput = {
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
} as const;

function createRequest(binding: ConversationRequest["binding"]): ConversationRequest {
  return {
    messages: [{ role: "user", content: "Hello" }],
    systemPrompt: "You are helpful.",
    contextLens: null,
    binding
  };
}

function createRequestWithContext(binding: ConversationRequest["binding"]): ConversationRequest {
  return {
    messages: [{ role: "user", content: "Hello" }],
    systemPrompt: "You are helpful.",
    contextLens: null,
    binding,
    runtime_context: {
      workspace_id: "ws-test",
      run_id: "run-test",
      surface_id: null,
      user_message_id: "msg_user_test",
      assistant_message_id: "msg_asst_test"
    }
  };
}

function createStreamModel(parts: readonly unknown[]) {
  const model = new MockLanguageModelV3();

  resolveLanguageModelMock.mockReturnValue(model);
  streamTextMock.mockReturnValue({
    fullStream: simulateReadableStream({ chunks: [...parts] })
  } as ReturnType<typeof streamText>);
  return model;
}

function createErroringStreamModel(error: unknown) {
  const model = new MockLanguageModelV3();

  resolveLanguageModelMock.mockReturnValue(model);
  streamTextMock.mockImplementation(() => {
    throw error;
  });
  return model;
}

function createMidStreamErrorModel(parts: readonly unknown[], error: unknown) {
  const model = new MockLanguageModelV3();

  resolveLanguageModelMock.mockReturnValue(model);
  streamTextMock.mockReturnValue({
    fullStream: (async function* () {
      for (const part of parts) {
        yield part;
      }
      throw error;
    })()
  } as ReturnType<typeof streamText>);
  return model;
}

function createPrematureEndModel(parts: readonly unknown[]) {
  const model = new MockLanguageModelV3();

  resolveLanguageModelMock.mockReturnValue(model);
  streamTextMock.mockReturnValue({
    fullStream: (async function* () {
      for (const part of parts) {
        yield part;
      }
    })()
  } as ReturnType<typeof streamText>);
  return model;
}

function createDeferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

async function collectDeltas(
  gen: AsyncGenerator<MessageDeltaEvent, void, unknown>
): Promise<MessageDeltaEvent[]> {
  const events: MessageDeltaEvent[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

async function collectProviderEvents(gen: AsyncIterable<unknown>): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const event of gen) {
    events.push(event);
  }
  return events;
}

function buildTextParts(
  chunks: readonly string[],
  finishReason: "stop" | "tool-calls" | "length" | "error" = "stop"
) {
  return [
    ...chunks.map((chunk, index) => ({
      type: "text-delta" as const,
      id: `text-${index}`,
      text: chunk
    })),
    {
      type: "finish" as const,
      finishReason,
      totalUsage: { inputTokens: 5, outputTokens: chunks.length, totalTokens: 5 + chunks.length }
    }
  ];
}

function buildToolParts(toolUseId: string) {
  return [
    {
      type: "tool-call" as const,
      toolCallId: toolUseId,
      toolName: "soul.emit_candidate_signal",
      input: {
        workspace_id: "ws_1",
        run_id: "run_1"
      }
    },
    {
      type: "finish" as const,
      finishReason: "tool-calls" as const,
      totalUsage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }
    }
  ];
}

function buildTextThenToolParts(prefix: string, toolUseId: string) {
  return [
    {
      type: "text-delta" as const,
      id: "text-before-tool",
      text: prefix
    },
    ...buildToolParts(toolUseId)
  ];
}

beforeEach(() => {
  vi.clearAllMocks();
  resolveLanguageModelMock.mockReset();
  streamTextMock.mockReset();
});

describe("streamViaAiSdk (OpenAI binding)", () => {
  it("returns an AsyncGenerator", () => {
    createStreamModel(buildTextParts(["Hello"]));

    const gen = streamViaAiSdk(createRequest(openAIBinding), {
      getEnv: () => "sk-openai"
    });

    expect(gen[Symbol.asyncIterator]).toBeDefined();
  });

  it("yields MessageDeltaEvent for each chunk, index increments from 0", async () => {
    createStreamModel(buildTextParts(["Hello", " world", "!"]));

    const deltas = await collectDeltas(
      streamViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" })
    );

    expect(deltas).toHaveLength(3);
    expect(deltas[0]!.index).toBe(0);
    expect(deltas[1]!.index).toBe(1);
    expect(deltas[2]!.index).toBe(2);
  });

  it("each yielded event passes MessageDeltaEventSchema.parse()", async () => {
    createStreamModel(buildTextParts(["Hi", " there"]));

    const deltas = await collectDeltas(
      streamViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" })
    );

    for (const delta of deltas) {
      expect(() => MessageDeltaEventSchema.parse(delta)).not.toThrow();
    }
  });

  it("does not delay normal stop completions to attach a finishReason", async () => {
    createStreamModel(buildTextParts(["One", "Two", "Three"], "stop"));

    const deltas = await collectDeltas(
      streamViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" })
    );

    expect(deltas).toHaveLength(3);
    expect(deltas.every((delta) => delta.finishReason === undefined)).toBe(true);
  });

  it("emits a terminal finish marker when the provider stops for length", async () => {
    createStreamModel(buildTextParts(["One", "Two"], "length"));

    const deltas = await collectDeltas(
      streamViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" })
    );

    expect(deltas[deltas.length - 1]).toMatchObject({
      delta: "",
      index: 2,
      finishReason: "length"
    });
  });

  it("emits a terminal finish marker when the provider reports an error finish", async () => {
    createStreamModel(buildTextParts(["One", "Two"], "error"));

    const deltas = await collectDeltas(
      streamViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" })
    );

    expect(deltas[deltas.length - 1]).toMatchObject({
      delta: "",
      index: 2,
      finishReason: "error"
    });
  });

  it("intermediate deltas have no finishReason", async () => {
    createStreamModel(buildTextParts(["A", "B", "C"]));

    const deltas = await collectDeltas(
      streamViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" })
    );

    for (const delta of deltas.slice(0, -1)) {
      expect(delta.finishReason).toBeUndefined();
    }
  });

  it("on simulated API error, propagates the error to the caller", async () => {
    createErroringStreamModel(new Error("stream broke"));

    await expect(
      collectDeltas(streamViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" }))
    ).rejects.toMatchObject({
      kind: EngineErrorKind.MODEL_ERROR,
      message: "The model provider request failed."
    });
  });

  it("normalizes a mid-stream failure after yielding text", async () => {
    createMidStreamErrorModel(
      [
        {
          type: "text-delta" as const,
          id: "midstream-1",
          text: "partial"
        },
        {
          type: "text-delta" as const,
          id: "midstream-2",
          text: " response"
        }
      ],
      new Error("stream broke mid-flight")
    );

    const gen = streamViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" });

    await expect(gen.next()).resolves.toMatchObject({
      value: expect.objectContaining({
        type: "message.delta",
        delta: "partial",
        index: 0
      }),
      done: false
    });
    await expect(gen.next()).resolves.toMatchObject({
      value: expect.objectContaining({
        type: "message.delta",
        delta: " response",
        index: 1
      }),
      done: false
    });
    await expect(gen.next()).rejects.toMatchObject({
      kind: EngineErrorKind.MODEL_ERROR,
      message: "The model provider request failed."
    });
  });

  it("flushes the pending delta before propagating an explicit stream error event", async () => {
    createStreamModel([
      {
        type: "text-delta" as const,
        id: "stream-error-1",
        text: "partial"
      },
      {
        type: "error" as const,
        error: new Error("stream event failed")
      }
    ]);

    const gen = streamViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" });

    await expect(gen.next()).resolves.toMatchObject({
      value: expect.objectContaining({
        type: "message.delta",
        delta: "partial",
        index: 0
      }),
      done: false
    });
    await expect(gen.next()).rejects.toMatchObject({
      kind: EngineErrorKind.MODEL_ERROR,
      message: "The model provider request failed."
    });
  });

  it("throws model_error when the stream ends before a finish event", async () => {
    createPrematureEndModel([
      {
        type: "text-delta" as const,
        id: "premature-end-1",
        text: "partial"
      }
    ]);

    const gen = streamViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" });

    await expect(gen.next()).resolves.toMatchObject({
      value: expect.objectContaining({
        type: "message.delta",
        delta: "partial",
        index: 0
      }),
      done: false
    });
    await expect(gen.next()).rejects.toMatchObject({
      kind: EngineErrorKind.MODEL_ERROR,
      message: "The model provider terminated the stream before a finish event."
    });
  });

  it("yields the first text chunk before later provider chunks arrive", async () => {
    const secondChunkGate = createDeferred<void>();

    resolveLanguageModelMock.mockReturnValue(new MockLanguageModelV3());
    streamTextMock.mockReturnValue({
      fullStream: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "text-delta" as const,
            id: "delayed-1",
            text: "Hello"
          };
          await secondChunkGate.promise;
          yield {
            type: "text-delta" as const,
            id: "delayed-2",
            text: " world"
          };
          yield {
            type: "finish" as const,
            finishReason: "stop" as const,
            totalUsage: { inputTokens: 5, outputTokens: 2, totalTokens: 7 }
          };
        }
      }
    } as ReturnType<typeof streamText>);

    const gen = streamViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" });
    const firstNext = gen.next();
    let firstResolved = false;
    void firstNext.then(() => {
      firstResolved = true;
    });

    try {
      for (let index = 0; index < 5; index += 1) {
        await Promise.resolve();
      }

      expect(firstResolved).toBe(true);
      await expect(firstNext).resolves.toMatchObject({
        value: expect.objectContaining({
          type: "message.delta",
          delta: "Hello",
          index: 0
        }),
        done: false
      });
    } finally {
      secondChunkGate.resolve();
      await gen.return(undefined);
    }
  });

  it("all deltas concatenated equal the full response text", async () => {
    createStreamModel(buildTextParts(["Hello", " ", "world", "!"]));

    const deltas = await collectDeltas(
      streamViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" })
    );

    const assembled = deltas.map((delta) => delta.delta).join("");
    expect(assembled).toBe("Hello world!");
  });

  it("uses runId and messageId from runtime_context when provided", async () => {
    createStreamModel(buildTextParts(["Hi"]));

    const deltas = await collectDeltas(
      streamViaAiSdk(createRequestWithContext(openAIBinding), { getEnv: () => "sk-openai" })
    );

    expect(deltas[0]!.runId).toBe("run-test");
    expect(deltas[0]!.messageId).toBe("msg_asst_test");
  });

  it("falls back to placeholder '_' when runtime_context is absent", async () => {
    createStreamModel(buildTextParts(["Hi"]));

    const deltas = await collectDeltas(
      streamViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" })
    );

    expect(deltas[0]!.runId).toBe("_");
    expect(deltas[0]!.messageId).toBe("_");
  });

  it("emits an internal tool-use event instead of mapping streamed tool calls to error", async () => {
    createStreamModel(buildToolParts("call_1"));

    const events = await collectProviderEvents(
      streamViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" })
    );

    expect(events).toEqual([
      {
        type: "provider.tool_uses",
        result: {
          message: {
            role: "assistant",
            content: "",
            message_id: "openai-stream-tool-use"
          },
          finish_reason: "stop",
          usage: {
            prompt_tokens: 10,
            completion_tokens: 1
          },
          tool_uses: [
            {
              type: "tool_use",
              id: "call_1",
              name: "soul.emit_candidate_signal",
              input: {
                workspace_id: "ws_1",
                run_id: "run_1"
              }
            }
          ]
        }
      }
    ]);
  });

  it("preserves already streamed assistant text inside the tool-use sentinel result", async () => {
    createStreamModel(buildTextThenToolParts("I found a lead. ", "call_2"));

    const events = await collectProviderEvents(
      streamViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" })
    );

    expect(events).toEqual([
      expect.objectContaining({
        type: "message.delta",
        delta: "I found a lead. ",
        index: 0
      }),
      expect.objectContaining({
        type: "provider.tool_uses",
        result: expect.objectContaining({
          message: expect.objectContaining({
            content: "I found a lead. "
          })
        })
      })
    ]);
  });

  it("rejects streamed tool calls whose input is not an object", async () => {
    createStreamModel([
      {
        type: "tool-call" as const,
        toolCallId: "call_invalid",
        toolName: "soul.emit_candidate_signal",
        input: "not-an-object"
      },
      {
        type: "finish" as const,
        finishReason: "tool-calls" as const,
        totalUsage: { inputTokens: 10, outputTokens: 1, totalTokens: 11 }
      }
    ]);

    await expect(
      collectProviderEvents(
        streamViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" })
      )
    ).rejects.toMatchObject({
      kind: EngineErrorKind.MODEL_ERROR,
      message: "The model provider returned an invalid tool call payload for soul.emit_candidate_signal."
    });
  });
});

describe("streamViaAiSdk (Anthropic binding)", () => {
  it("returns an AsyncGenerator", () => {
    createStreamModel(buildTextParts(["Hello"]));

    const gen = streamViaAiSdk(createRequest(anthropicBinding), {
      getEnv: () => "sk-anthropic"
    });

    expect(gen[Symbol.asyncIterator]).toBeDefined();
  });

  it("passes the expected request contract to streamText", async () => {
    const request = createRequest(anthropicBinding);
    const model = createStreamModel(buildTextParts(["Hello"]));

    await collectDeltas(streamViaAiSdk(request, { getEnv: () => "sk-anthropic" }));

    expect(resolveLanguageModelMock).toHaveBeenCalledWith(
      anthropicBinding,
      expect.any(Function),
      "sk-anthropic"
    );

    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        model,
        system: "You are helpful.",
        messages: [{ role: "user", content: "Hello" }],
        maxOutputTokens: 2048,
        tools: expect.any(Object),
        maxRetries: 0
      })
    );
    const [{ tools }] = streamTextMock.mock.calls.at(-1) ?? [];
    expect(Object.keys(tools ?? {})).toEqual([
      "soul.emit_candidate_signal",
      "soul.apply_override",
      "soul.explore_graph"
    ]);
  });

  it("omits tools from streamText when the binding disables them", async () => {
    createStreamModel(buildTextParts(["Hello"]));

    await collectDeltas(
      streamViaAiSdk(createRequest({ ...anthropicBinding, enable_tools: false }), {
        getEnv: () => "sk-anthropic"
      })
    );

    expect(streamTextMock).toHaveBeenCalledWith(
      expect.not.objectContaining({
        tools: expect.anything()
      })
    );
  });

  it("yields MessageDeltaEvent for each text chunk, index increments from 0", async () => {
    createStreamModel(buildTextParts(["Hello", " world", "!"]));

    const deltas = await collectDeltas(
      streamViaAiSdk(createRequest(anthropicBinding), { getEnv: () => "sk-anthropic" })
    );

    expect(deltas[0]!.index).toBe(0);
    expect(deltas[1]!.index).toBe(1);
    expect(deltas[2]!.index).toBe(2);
  });

  it("each yielded event passes MessageDeltaEventSchema.parse()", async () => {
    createStreamModel(buildTextParts(["Hi", " there"]));

    const deltas = await collectDeltas(
      streamViaAiSdk(createRequest(anthropicBinding), { getEnv: () => "sk-anthropic" })
    );

    for (const delta of deltas) {
      expect(() => MessageDeltaEventSchema.parse(delta)).not.toThrow();
    }
  });

  it("does not delay anthropic stop completions to attach a finishReason", async () => {
    createStreamModel(buildTextParts(["One", "Two"], "stop"));

    const deltas = await collectDeltas(
      streamViaAiSdk(createRequest(anthropicBinding), { getEnv: () => "sk-anthropic" })
    );

    expect(deltas).toHaveLength(2);
    expect(deltas.every((delta) => delta.finishReason === undefined)).toBe(true);
  });

  it("intermediate deltas have no finishReason", async () => {
    createStreamModel(buildTextParts(["A", "B", "C"]));

    const deltas = await collectDeltas(
      streamViaAiSdk(createRequest(anthropicBinding), { getEnv: () => "sk-anthropic" })
    );

    const intermediate = deltas.filter((delta) => delta.finishReason === undefined);
    expect(intermediate.length).toBeGreaterThan(0);
  });

  it("on simulated API error, propagates the error to the caller", async () => {
    createErroringStreamModel(new Error("anthropic stream broke"));

    await expect(
      collectDeltas(
        streamViaAiSdk(createRequest(anthropicBinding), { getEnv: () => "sk-anthropic" })
      )
    ).rejects.toMatchObject({
      kind: EngineErrorKind.MODEL_ERROR,
      message: "The model provider request failed."
    });
  });

  it("all text deltas concatenated equal the full response text", async () => {
    createStreamModel(buildTextParts(["Hello", " ", "world", "!"]));

    const deltas = await collectDeltas(
      streamViaAiSdk(createRequest(anthropicBinding), { getEnv: () => "sk-anthropic" })
    );

    const assembled = deltas.map((delta) => delta.delta).join("");
    expect(assembled).toBe("Hello world!");
  });

  it("uses runId and messageId from runtime_context when provided", async () => {
    createStreamModel(buildTextParts(["Hi"]));

    const deltas = await collectDeltas(
      streamViaAiSdk(createRequestWithContext(anthropicBinding), {
        getEnv: () => "sk-anthropic"
      })
    );

    expect(deltas[0]!.runId).toBe("run-test");
    expect(deltas[0]!.messageId).toBe("msg_asst_test");
  });

  it("falls back to placeholder '_' when runtime_context is absent", async () => {
    createStreamModel(buildTextParts(["Hi"]));

    const deltas = await collectDeltas(
      streamViaAiSdk(createRequest(anthropicBinding), { getEnv: () => "sk-anthropic" })
    );

    expect(deltas[0]!.runId).toBe("_");
    expect(deltas[0]!.messageId).toBe("_");
  });

  it("emits an internal tool-use event instead of mapping streamed tool use to error", async () => {
    createStreamModel(buildToolParts("toolu_1"));

    const events = await collectProviderEvents(
      streamViaAiSdk(createRequest(anthropicBinding), { getEnv: () => "sk-anthropic" })
    );

    expect(events).toEqual([
      {
        type: "provider.tool_uses",
        result: {
          message: {
            role: "assistant",
            content: "",
            message_id: "anthropic-stream-tool-use"
          },
          finish_reason: "stop",
          usage: {
            prompt_tokens: 10,
            completion_tokens: 1
          },
          tool_uses: [
            {
              type: "tool_use",
              id: "toolu_1",
              name: "soul.emit_candidate_signal",
              input: {
                workspace_id: "ws_1",
                run_id: "run_1"
              }
            }
          ]
        }
      }
    ]);
  });
});

describe("APIConversationEngine.streamMessage", () => {
  it("streams via AI SDK and does not depend on injected non-streaming providers", async () => {
    createStreamModel(buildTextParts(["Hello", " world"]));
    const engine = new APIConversationEngine({ getEnv: () => "sk-openai" });

    const deltas: MessageDeltaEvent[] = [];
    for await (const delta of engine.streamMessage(createRequest(openAIBinding))) {
      deltas.push(delta);
    }

    expect(streamTextMock).toHaveBeenCalledTimes(1);
    expect(deltas).toHaveLength(2);
    expect(deltas[0]!.delta).toBe("Hello");
    expect(deltas[1]!.delta).toBe(" world");
  });

  it("runs the MCP tool loop for streamed provider tool-use events and yields final assistant text", async () => {
    const model = new MockLanguageModelV3({
      doGenerate: createGenerateResult({
        text: "Signal emitted.",
        responseId: "msg-final"
      })
    });
    resolveLanguageModelMock.mockReturnValue(model);
    streamTextMock.mockReturnValue({
      fullStream: simulateReadableStream({ chunks: buildTextThenToolParts("I found a lead. ", "toolu_stream_1") })
    } as ReturnType<typeof streamText>);
    const mcpBridge = {
      executeToolUses: vi.fn().mockResolvedValue([
        {
          type: "tool_result",
          tool_use_id: "toolu_stream_1",
          content: JSON.stringify({ status: "emitted" })
        }
      ])
    };
    const engine = new APIConversationEngine({
      getEnv: () => "sk-openai",
      mcpBridge
    });

    const deltas: MessageDeltaEvent[] = [];
    for await (const delta of engine.streamMessage(createRequestWithContext(openAIBinding))) {
      deltas.push(delta);
    }

    expect(mcpBridge.executeToolUses).toHaveBeenCalledWith(
      [
        {
          type: "tool_use",
          id: "toolu_stream_1",
          name: "soul.emit_candidate_signal",
          input: { workspace_id: "ws_1", run_id: "run_1" }
        }
      ],
      createRequestWithContext(openAIBinding).runtime_context
    );
    expect(model.doGenerateCalls).toHaveLength(1);
    expect(model.doGenerateCalls[0]?.prompt).toMatchObject([
      { role: "system", content: "You are helpful." },
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "I found a lead. " },
          {
            type: "tool-call",
            toolCallId: "toolu_stream_1",
            toolName: "soul.emit_candidate_signal",
            input: { workspace_id: "ws_1", run_id: "run_1" }
          }
        ]
      },
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "toolu_stream_1",
            toolName: "soul.emit_candidate_signal",
            output: {
              type: "json",
              value: { status: "emitted" }
            }
          }
        ]
      }
    ]);
    expect(deltas).toEqual([
      expect.objectContaining({
        type: "message.delta",
        runId: "run-test",
        messageId: "msg_asst_test",
        delta: "I found a lead. ",
        index: 0
      }),
      expect.objectContaining({
        type: "message.delta",
        runId: "run-test",
        messageId: "msg_asst_test",
        delta: "Signal emitted.",
        index: 1,
        finishReason: "stop"
      })
    ]);
  });

  it("throws EngineError when streamed tool use has no MCP bridge", async () => {
    createStreamModel(buildToolParts("toolu_stream_2"));

    const engine = new APIConversationEngine({ getEnv: () => "sk-openai" });

    const gen = engine.streamMessage(createRequest(openAIBinding));
    await expect(gen.next()).rejects.toMatchObject({
      kind: EngineErrorKind.MODEL_ERROR,
      message: "MCP bridge is not configured for tool use handling."
    });
  });

  it("normalizes auth errors (401) as EngineError with kind 'auth'", async () => {
    createErroringStreamModel(Object.assign(new Error("Unauthorized"), { status: 401 }));

    const engine = new APIConversationEngine({ getEnv: () => "sk-openai" });

    const gen = engine.streamMessage(createRequest(openAIBinding));
    await expect(gen.next()).rejects.toMatchObject({
      kind: EngineErrorKind.AUTH,
      message: "Authentication with the model provider failed."
    });
  });

  it("passes an injected abort signal through to streamText", async () => {
    const abortController = new AbortController();
    createStreamModel(buildTextParts(["Hello"]));
    const engine = new APIConversationEngine({
      getEnv: () => "sk-openai",
      ...({ getAbortSignal: () => abortController.signal } as Record<string, unknown>)
    });

    await collectDeltas(engine.streamMessage(createRequest(openAIBinding)));

    expect(streamTextMock).toHaveBeenCalledWith(
      expect.objectContaining({
        abortSignal: abortController.signal
      })
    );
  });

  it("cancels the underlying provider stream when the generator is returned early", async () => {
    const cancel = vi.fn();
    resolveLanguageModelMock.mockReturnValue(new MockLanguageModelV3());
    streamTextMock.mockReturnValue({
      fullStream: {
        async *[Symbol.asyncIterator]() {
          yield {
            type: "text-delta" as const,
            id: "cancel-1",
            text: "Hello"
          };
          yield {
            type: "text-delta" as const,
            id: "cancel-2",
            text: " world"
          };
        },
        cancel
      }
    } as ReturnType<typeof streamText>);

    const gen = streamViaAiSdk(createRequest(openAIBinding), { getEnv: () => "sk-openai" });
    await gen.next();
    await gen.return(undefined);

    expect(cancel).toHaveBeenCalledTimes(1);
  });

  it("throws after exceeding the streaming MCP tool loop depth limit", async () => {
    const continuationResponses = Array.from({ length: 4 }, (_, index) => createGenerateResult({
      text: "",
      responseId: `msg-stream-loop-${index}`,
      finishReason: { unified: "tool-calls", raw: "tool-calls" },
      content: [
        {
          type: "tool-call",
          toolCallId: `toolu_stream_loop_${index}`,
          toolName: "soul.emit_candidate_signal",
          input: JSON.stringify(candidateSignalInput)
        }
      ]
    }));
    const continuationModel = new MockLanguageModelV3({
      doGenerate: async () => {
        const response = continuationResponses.shift();
        if (!response) {
          throw new Error("unexpected extra streaming continuation call");
        }
        return response;
      }
    });
    resolveLanguageModelMock.mockReturnValue(continuationModel);
    streamTextMock.mockReturnValue({
      fullStream: simulateReadableStream({ chunks: buildToolParts("toolu_stream_depth_0") })
    } as ReturnType<typeof streamText>);
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

    await expect(
      collectDeltas(engine.streamMessage(createRequestWithContext(openAIBinding)))
    ).rejects.toMatchObject({
      kind: EngineErrorKind.MODEL_ERROR,
      message: "The model exceeded the maximum MCP tool loop depth."
    });
  });
});
