import { beforeEach, describe, expect, it, vi } from "vitest";
import { EngineProvider, type ConversationRequest, type EngineResult, type MessageDeltaEvent } from "@do-what/protocol";

const continueViaAiSdkMock = vi.hoisted(() => vi.fn());
const sendViaAiSdkMock = vi.hoisted(() => vi.fn());
const streamViaAiSdkMock = vi.hoisted(() => vi.fn());

vi.mock("../provider/ai-sdk-non-streaming.js", () => ({
  continueViaAiSdk: continueViaAiSdkMock,
  sendViaAiSdk: sendViaAiSdkMock,
  normalizeEngineError: (error: unknown) => {
    throw error;
  }
}));

vi.mock("../provider/ai-sdk-streaming.js", () => ({
  streamViaAiSdk: streamViaAiSdkMock
}));

import { APIConversationEngine } from "../api-conversation-engine.js";

describe("APIConversationEngine next-index regression", () => {
  beforeEach(() => {
    continueViaAiSdkMock.mockReset();
    sendViaAiSdkMock.mockReset();
    streamViaAiSdkMock.mockReset();
  });

  it("preserves provider delta indexes when no tool loop runs", async () => {
    streamViaAiSdkMock.mockImplementation(async function* (): AsyncGenerator<MessageDeltaEvent> {
      yield createDeltaEvent(0, "Hello");
      yield createDeltaEvent(1, " world", "stop");
    });

    const engine = new APIConversationEngine({ getEnv: () => "sk-openai" });
    const deltas = await collectDeltas(engine.streamMessage(createRequest()));

    expect(deltas.map((event) => event.index)).toEqual([0, 1]);
    expect(deltas.map((event) => event.delta)).toEqual(["Hello", " world"]);
  });

  it("continues indexes after a provider tool-use loop completes", async () => {
    streamViaAiSdkMock.mockImplementation(async function* (): AsyncGenerator<
      MessageDeltaEvent | { readonly type: "provider.tool_uses"; readonly result: EngineResult }
    > {
      yield createDeltaEvent(0, "Lead: ");
      yield {
        type: "provider.tool_uses",
        result: {
          message: {
            role: "assistant",
            content: "Lead: ",
            message_id: "msg-provider-tool"
          },
          finish_reason: "stop",
          tool_uses: [
            {
              type: "tool_use",
              id: "toolu-1",
              name: "soul.emit_candidate_signal",
              input: { workspace_id: "ws_1", run_id: "run_1" }
            }
          ]
        }
      };
    });
    continueViaAiSdkMock.mockResolvedValue({
      message: {
        role: "assistant",
        content: "Done",
        message_id: "msg-continuation"
      },
      finish_reason: "stop"
    } satisfies EngineResult);

    const mcpBridge = {
      executeToolUses: vi.fn(async () => [
        {
          type: "tool_result" as const,
          tool_use_id: "toolu-1",
          content: JSON.stringify({ status: "ok" })
        }
      ])
    };
    const engine = new APIConversationEngine({
      getEnv: () => "sk-openai",
      mcpBridge
    });

    const deltas = await collectDeltas(engine.streamMessage(createRequest()));

    expect(deltas.map((event) => ({ index: event.index, delta: event.delta }))).toEqual([
      { index: 0, delta: "Lead: " },
      { index: 1, delta: "Done" }
    ]);
    expect(mcpBridge.executeToolUses).toHaveBeenCalledTimes(1);
    expect(continueViaAiSdkMock).toHaveBeenCalledTimes(1);
  });
});

function createRequest(): ConversationRequest {
  return {
    messages: [{ role: "user", content: "Hello" }],
    systemPrompt: "You are helpful.",
    contextLens: null,
    binding: {
      binding_id: "binding-openai",
      provider: EngineProvider.OPENAI,
      base_url: null,
      model: "gpt-4o-mini",
      api_key_ref: "OPENAI_API_KEY",
      config: {}
    },
    runtime_context: {
      workspace_id: "ws-test",
      run_id: "run-test",
      surface_id: null,
      user_message_id: "msg-user",
      assistant_message_id: "msg-assistant"
    }
  };
}

function createDeltaEvent(
  index: number,
  delta: string,
  finishReason?: MessageDeltaEvent["finishReason"]
): MessageDeltaEvent {
  return {
    type: "message.delta",
    runId: "run-test",
    messageId: "msg-assistant",
    delta,
    index,
    ...(finishReason === undefined ? {} : { finishReason }),
    timestamp: "2026-04-12T12:00:00.000Z"
  };
}

async function collectDeltas(
  generator: AsyncGenerator<MessageDeltaEvent, void, unknown>
): Promise<MessageDeltaEvent[]> {
  const deltas: MessageDeltaEvent[] = [];

  for await (const event of generator) {
    deltas.push(event);
  }

  return deltas;
}
