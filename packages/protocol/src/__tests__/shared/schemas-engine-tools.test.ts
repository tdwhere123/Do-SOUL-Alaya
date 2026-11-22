import { describe, expect, it } from "vitest";
import {
  ConversationMessageSchema,
  EngineError,
  EngineErrorKind,
  EngineErrorSchema,
  EngineResultSchema,
  ToolUseBlockSchema
} from "../../index.js";


describe("EngineResultSchema", () => {
  const message = { role: "assistant", content: "Hello", message_id: "message-1" } as const;

  it("accepts a result without usage", () => {
    const result = { message, finish_reason: "stop" };
    expect(EngineResultSchema.parse(result)).toEqual(result);
  });

  it("accepts a result with usage", () => {
    const result = {
      message,
      finish_reason: "length",
      tool_uses: [
        {
          type: "tool_use",
          id: "toolu_1",
          name: "soul.emit_candidate_signal",
          input: {
            workspace_id: "workspace-1",
            run_id: "run-1"
          }
        }
      ],
      usage: {
        prompt_tokens: 10,
        completion_tokens: 20
      }
    };

    expect(EngineResultSchema.parse(result)).toEqual(result);
  });

  it("rejects an invalid finish_reason", () => {
    expect(EngineResultSchema.safeParse({ message, finish_reason: "timeout" }).success).toBe(false);
  });

  it("rejects a missing message", () => {
    expect(EngineResultSchema.safeParse({ finish_reason: "stop" }).success).toBe(false);
  });

  it("accepts a result without tool_uses", () => {
    const result = { message, finish_reason: "stop" };
    expect(EngineResultSchema.parse(result)).toEqual(result);
  });

  it("rejects a tool_use block missing an id", () => {
    expect(
      EngineResultSchema.safeParse({
        message,
        finish_reason: "stop",
        tool_uses: [
          {
            type: "tool_use",
            name: "soul.emit_candidate_signal",
            input: {}
          }
        ]
      }).success
    ).toBe(false);
  });

  it("rejects negative usage tokens", () => {
    expect(
      EngineResultSchema.safeParse({
        message,
        finish_reason: "stop",
        usage: {
          prompt_tokens: -1,
          completion_tokens: 20
        }
      }).success
    ).toBe(false);
  });

  it("rejects fractional usage tokens", () => {
    expect(
      EngineResultSchema.safeParse({
        message,
        finish_reason: "stop",
        usage: {
          prompt_tokens: 1.5,
          completion_tokens: 20
        }
      }).success
    ).toBe(false);
  });
});


describe("ToolUseBlockSchema", () => {
  it("accepts a tool_use block", () => {
    const value = {
      type: "tool_use",
      id: "toolu_1",
      name: "soul.emit_candidate_signal",
      input: {
        workspace_id: "workspace-1",
        run_id: "run-1"
      }
    } as const;

    expect(ToolUseBlockSchema.parse(value)).toEqual(value);
  });

  it("rejects an invalid block type", () => {
    expect(
      ToolUseBlockSchema.safeParse({
        type: "tool_call",
        id: "toolu_1",
        name: "soul.emit_candidate_signal",
        input: {}
      }).success
    ).toBe(false);
  });
});


describe("EngineErrorSchema and EngineError", () => {
  it("accepts a network error payload", () => {
    const value = { message: "Network failed", kind: EngineErrorKind.NETWORK };
    expect(EngineErrorSchema.parse(value)).toEqual(value);
  });

  it("accepts an auth error payload", () => {
    const value = { message: "Auth failed", kind: EngineErrorKind.AUTH };
    expect(EngineErrorSchema.parse(value)).toEqual(value);
  });

  it("rejects an invalid error kind", () => {
    expect(EngineErrorSchema.safeParse({ message: "Boom", kind: "timeout" }).success).toBe(false);
  });

  it("rejects a missing message", () => {
    expect(EngineErrorSchema.safeParse({ kind: EngineErrorKind.MODEL_ERROR }).success).toBe(false);
  });

  it("constructs the EngineError class with the expected metadata", () => {
    const error = new EngineError("Boom", EngineErrorKind.RATE_LIMIT);
    expect(error).toBeInstanceOf(Error);
    expect(error.name).toBe("EngineError");
    expect(error.kind).toBe(EngineErrorKind.RATE_LIMIT);
    expect(error.message).toBe("Boom");
  });
});

describe("ConversationMessageSchema", () => {
  it("accepts a user message", () => {
    const value = { message_id: "msg_user_1", role: "user", content: "hello" };
    expect(ConversationMessageSchema.parse(value)).toEqual(value);
  });

  it("accepts an assistant message", () => {
    const value = { message_id: "msg_assistant_1", role: "assistant", content: "hi" };
    expect(ConversationMessageSchema.parse(value)).toEqual(value);
  });

  it("rejects an invalid role", () => {
    expect(ConversationMessageSchema.safeParse({ message_id: "msg_1", role: "system", content: "nope" }).success).toBe(false);
  });

  it("rejects a missing message id", () => {
    expect(ConversationMessageSchema.safeParse({ role: "user", content: "hello" }).success).toBe(false);
  });

  it("accepts an optional source created_at and rejects an invalid timestamp", () => {
    const value = {
      message_id: "msg_user_1",
      role: "user",
      content: "hello",
      created_at: "2026-04-29T00:00:00.000Z"
    };
    expect(ConversationMessageSchema.parse(value)).toEqual(value);
    expect(ConversationMessageSchema.safeParse({
      message_id: "msg_user_1",
      role: "user",
      content: "hello",
      created_at: "not-a-timestamp"
    }).success).toBe(false);
  });
});

