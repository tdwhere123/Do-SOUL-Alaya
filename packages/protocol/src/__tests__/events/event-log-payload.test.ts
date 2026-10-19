import { describe, expect, it } from "vitest";
import { EVENT_LOG_PAYLOAD_MAX_CHARS, EventLogPayloadSchema } from "../../events/event-log.js";
import { BOUNDED_JSON_OBJECT_MAX_CHARS, BoundedJsonObjectSchema } from "../../shared/schema-primitives.js";

// JSON punctuation consumes 11 code units in {"text":""}.
const overhead = JSON.stringify({ text: "" }).length;

describe("EventLog payload serialization budget", () => {
  it("admits the exact aggregate limit and rejects the next code unit without truncation", () => {
    const payload = { text: "x".repeat(EVENT_LOG_PAYLOAD_MAX_CHARS - overhead) };
    expect(EventLogPayloadSchema.parse(payload)).toEqual(payload);
    expect(EventLogPayloadSchema.safeParse({ text: `${payload.text}x` }).success).toBe(false);
  });

  it("measures escaped JSON rather than source string length", () => {
    const text = "\u0000".repeat(Math.ceil(EVENT_LOG_PAYLOAD_MAX_CHARS / 6));
    expect(text.length).toBeLessThan(EVENT_LOG_PAYLOAD_MAX_CHARS);
    expect(EventLogPayloadSchema.safeParse({ text }).success).toBe(false);
  });

  it("keeps the attached-agent and benchmark JSON budget unchanged", () => {
    expect(BOUNDED_JSON_OBJECT_MAX_CHARS).toBe(16_384);
    const payload = { text: "x".repeat(16_384 - overhead) };
    expect(BoundedJsonObjectSchema.safeParse(payload).success).toBe(true);
    expect(BoundedJsonObjectSchema.safeParse({ text: `${payload.text}x` }).success).toBe(false);
  });

  it("refuses nonserializable audit objects", () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(EventLogPayloadSchema.safeParse(circular).success).toBe(false);
    expect(EventLogPayloadSchema.safeParse({ value: 1n }).success).toBe(false);
  });
});
