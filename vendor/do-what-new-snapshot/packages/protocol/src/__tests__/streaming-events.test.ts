import { describe, expect, it } from "vitest";
import {
  MessageDeltaEventSchema,
  MessageCompletedEventSchema,
  MessageCreatedEventSchema,
  RunErrorEventSchema,
  RunStateChangedEventSchema,
  StreamingStatusSchema,
  StreamingEventTypeSchema,
  StreamingEventType,
} from "../events/message-delta.js";

const validTimestamp = "2026-04-07T12:00:00.000Z";

const validDeltaEvent = {
  type: "message.delta" as const,
  runId: "run-abc",
  messageId: "msg-123",
  delta: "Hello",
  index: 0,
  timestamp: validTimestamp,
};

const validCompletedEvent = {
  type: "message.completed" as const,
  runId: "run-abc",
  messageId: "msg-123",
  content: "Hello world",
  finishReason: "stop" as const,
  timestamp: validTimestamp,
};

const validCreatedEvent = {
  messageId: "msg-123",
  runId: "run-abc",
  role: "assistant" as const,
  createdAt: validTimestamp,
};

const validRunStateChangedEvent = {
  runId: "run-abc",
  state: "completed",
  previousState: "active",
};

const validRunErrorEvent = {
  runId: "run-abc",
  errorMessage: "Engine failed",
  errorCode: "ENGINE_ERROR",
};

describe("MessageCreatedEvent", () => {
  it("parses valid created event", () => {
    const result = MessageCreatedEventSchema.parse(validCreatedEvent);
    expect(result.messageId).toBe("msg-123");
    expect(result.runId).toBe("run-abc");
    expect(result.role).toBe("assistant");
  });

  it("rejects invalid message role", () => {
    expect(() => MessageCreatedEventSchema.parse({ ...validCreatedEvent, role: "system" })).toThrow();
  });
});

describe("MessageDeltaEvent", () => {
  it("parses valid delta event", () => {
    const result = MessageDeltaEventSchema.parse(validDeltaEvent);
    expect(result.type).toBe("message.delta");
    expect(result.runId).toBe("run-abc");
    expect(result.messageId).toBe("msg-123");
    expect(result.delta).toBe("Hello");
    expect(result.index).toBe(0);
  });

  it("rejects missing required field: runId", () => {
    const { runId: _omitted, ...rest } = validDeltaEvent;
    expect(() => MessageDeltaEventSchema.parse(rest)).toThrow();
  });

  it("rejects missing required field: messageId", () => {
    const { messageId: _omitted, ...rest } = validDeltaEvent;
    expect(() => MessageDeltaEventSchema.parse(rest)).toThrow();
  });

  it("rejects missing required field: delta", () => {
    const { delta: _omitted, ...rest } = validDeltaEvent;
    expect(() => MessageDeltaEventSchema.parse(rest)).toThrow();
  });

  it("rejects missing required field: index", () => {
    const { index: _omitted, ...rest } = validDeltaEvent;
    expect(() => MessageDeltaEventSchema.parse(rest)).toThrow();
  });

  it("rejects missing required field: timestamp", () => {
    const { timestamp: _omitted, ...rest } = validDeltaEvent;
    expect(() => MessageDeltaEventSchema.parse(rest)).toThrow();
  });

  it("accepts event without finishReason (optional)", () => {
    const result = MessageDeltaEventSchema.parse(validDeltaEvent);
    expect(result.finishReason).toBeUndefined();
  });

  it("rejects invalid finishReason value", () => {
    expect(() =>
      MessageDeltaEventSchema.parse({ ...validDeltaEvent, finishReason: "done" })
    ).toThrow();
  });

  it("rejects type other than 'message.delta'", () => {
    expect(() =>
      MessageDeltaEventSchema.parse({ ...validDeltaEvent, type: "message.completed" })
    ).toThrow();
  });

  it("rejects negative index", () => {
    expect(() =>
      MessageDeltaEventSchema.parse({ ...validDeltaEvent, index: -1 })
    ).toThrow();
  });

  it("accepts finishReason: 'stop'", () => {
    const result = MessageDeltaEventSchema.parse({ ...validDeltaEvent, finishReason: "stop" });
    expect(result.finishReason).toBe("stop");
  });

  it("accepts finishReason: null", () => {
    const result = MessageDeltaEventSchema.parse({ ...validDeltaEvent, finishReason: null });
    expect(result.finishReason).toBeNull();
  });
});

describe("MessageCompletedEvent", () => {
  it("parses valid completed event", () => {
    const result = MessageCompletedEventSchema.parse(validCompletedEvent);
    expect(result.type).toBe("message.completed");
    expect(result.content).toBe("Hello world");
    expect(result.finishReason).toBe("stop");
  });

  it("rejects missing content field", () => {
    const { content: _omitted, ...rest } = validCompletedEvent;
    expect(() => MessageCompletedEventSchema.parse(rest)).toThrow();
  });

  it("rejects missing finishReason field", () => {
    const { finishReason: _omitted, ...rest } = validCompletedEvent;
    expect(() => MessageCompletedEventSchema.parse(rest)).toThrow();
  });

  it("rejects optional finishReason (it's required here)", () => {
    // finishReason is required in MessageCompletedEvent — undefined is not allowed
    expect(() =>
      MessageCompletedEventSchema.parse({ ...validCompletedEvent, finishReason: undefined })
    ).toThrow();
  });

  it("accepts all valid finishReason values", () => {
    for (const reason of ["stop", "length", "error"] as const) {
      const result = MessageCompletedEventSchema.parse({ ...validCompletedEvent, finishReason: reason });
      expect(result.finishReason).toBe(reason);
    }
  });

  it("rejects invalid finishReason value", () => {
    expect(() =>
      MessageCompletedEventSchema.parse({ ...validCompletedEvent, finishReason: "done" })
    ).toThrow();
  });
});

describe("Run hot-state streaming events", () => {
  it("parses valid run.state_changed event", () => {
    const result = RunStateChangedEventSchema.parse(validRunStateChangedEvent);
    expect(result.runId).toBe("run-abc");
    expect(result.state).toBe("completed");
  });

  it("parses valid run.error event", () => {
    const result = RunErrorEventSchema.parse(validRunErrorEvent);
    expect(result.runId).toBe("run-abc");
    expect(result.errorMessage).toBe("Engine failed");
  });
});

describe("StreamingStatus", () => {
  it("accepts all valid values", () => {
    for (const status of ["idle", "streaming", "completed", "error"] as const) {
      expect(StreamingStatusSchema.parse(status)).toBe(status);
    }
  });

  it("rejects invalid value", () => {
    expect(() => StreamingStatusSchema.parse("unknown")).toThrow();
  });
});

describe("StreamingEventTypeSchema", () => {
  it("includes message.delta and message.completed", () => {
    expect(StreamingEventTypeSchema.parse("message.delta")).toBe("message.delta");
    expect(StreamingEventTypeSchema.parse("message.completed")).toBe("message.completed");
  });

  it("rejects unknown event type", () => {
    expect(() => StreamingEventTypeSchema.parse("message.unknown")).toThrow();
  });

  it("StreamingEventType constants match schema values", () => {
    expect(StreamingEventType.MESSAGE_DELTA).toBe("message.delta");
    expect(StreamingEventType.MESSAGE_COMPLETED).toBe("message.completed");
  });
});
