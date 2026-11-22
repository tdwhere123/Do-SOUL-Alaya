import { describe, expect, it } from "vitest";
import {
  MessageCompletedEventSchema,
  StreamingEventTypeSchema,
  StreamingEventType,
} from "../../events/message-delta.js";

const validTimestamp = "2026-04-07T12:00:00.000Z";

const validCompletedEvent = {
  type: "message.completed" as const,
  runId: "run-abc",
  messageId: "msg-123",
  content: "Hello world",
  finishReason: "stop" as const,
  timestamp: validTimestamp,
};

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
