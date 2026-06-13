import { describe, expect, it } from "vitest";
import {
  RecallTimeFieldSchema,
  SoulMemorySearchRequestSchema,
  soulToolJsonSchemas
} from "../../soul/mcp-types.js";

const baseRequest = {
  query: "what did I say on May 20",
  scope_class: null,
  dimension: null,
  domain_tags: null,
  max_results: 30
} as const;

describe("SoulMemorySearchRequestSchema time-filter fields", () => {
  it("accepts a request with all time fields omitted (backward-compatible)", () => {
    const parsed = SoulMemorySearchRequestSchema.parse({ ...baseRequest });
    expect(parsed.query).toBe("what did I say on May 20");
    expect(parsed.since).toBeUndefined();
    expect(parsed.until).toBeUndefined();
    expect(parsed.time_field).toBeUndefined();
  });

  it("accepts explicit null for since and until", () => {
    const parsed = SoulMemorySearchRequestSchema.parse({
      ...baseRequest,
      since: null,
      until: null
    });
    expect(parsed.since).toBeNull();
    expect(parsed.until).toBeNull();
  });

  it("accepts a single-day window with both bounds", () => {
    const parsed = SoulMemorySearchRequestSchema.parse({
      ...baseRequest,
      since: "2026-05-20T00:00:00.000Z",
      until: "2026-05-20T23:59:59.000Z",
      time_field: "created_at"
    });
    expect(parsed.since).toBe("2026-05-20T00:00:00.000Z");
    expect(parsed.until).toBe("2026-05-20T23:59:59.000Z");
    expect(parsed.time_field).toBe("created_at");
  });

  it("accepts time_field=last_used_at", () => {
    const parsed = SoulMemorySearchRequestSchema.parse({
      ...baseRequest,
      since: "2026-05-01T00:00:00.000Z",
      time_field: "last_used_at"
    });
    expect(parsed.time_field).toBe("last_used_at");
  });

  it("accepts optional host_context tokenizer hints without requiring old callers to send it", () => {
    expect(SoulMemorySearchRequestSchema.parse({ ...baseRequest }).host_context).toBeUndefined();

    const parsed = SoulMemorySearchRequestSchema.parse({
      ...baseRequest,
      host_context: {
        tokenizer_hint: "cl100k"
      }
    });

    expect(parsed.host_context).toEqual({
      tokenizer_hint: "cl100k"
    });

    expect(
      SoulMemorySearchRequestSchema.safeParse({
        ...baseRequest,
        host_context: { tokenizer_hint: "cl100k", host_context_window: 200000 }
      }).success
    ).toBe(false);
  });

  it("rejects unknown tokenizer hints and publishes host_context in the MCP catalog schema", () => {
    expect(() =>
      SoulMemorySearchRequestSchema.parse({
        ...baseRequest,
        host_context: {
          tokenizer_hint: "unknown-tokenizer"
        }
      })
    ).toThrow();

    const recallSchema = soulToolJsonSchemas["soul.recall"] as {
      readonly properties?: Record<string, unknown>;
    };
    const hostContextSchema = recallSchema.properties?.["host_context"] as {
      readonly properties?: Record<string, unknown>;
    } | undefined;
    const tokenizerHintSchema = hostContextSchema?.properties?.["tokenizer_hint"] as {
      readonly enum?: readonly string[];
    } | undefined;

    expect(hostContextSchema).toBeDefined();
    expect(tokenizerHintSchema?.enum).toEqual(["cl100k", "o200k", "approx_chars_per_token"]);
  });

  it("rejects a non-ISO datetime in since", () => {
    expect(() =>
      SoulMemorySearchRequestSchema.parse({
        ...baseRequest,
        since: "May 20, 2026"
      })
    ).toThrow();
  });

  it("rejects an ISO datetime with explicit offset (current schema is offset:false)", () => {
    expect(() =>
      SoulMemorySearchRequestSchema.parse({
        ...baseRequest,
        since: "2026-05-20T00:00:00+08:00"
      })
    ).toThrow();
  });

  it("rejects an unknown time_field value", () => {
    expect(() =>
      SoulMemorySearchRequestSchema.parse({
        ...baseRequest,
        time_field: "updated_at"
      })
    ).toThrow();
  });

  it("RecallTimeFieldSchema enumerates exactly created_at and last_used_at", () => {
    expect(RecallTimeFieldSchema.parse("created_at")).toBe("created_at");
    expect(RecallTimeFieldSchema.parse("last_used_at")).toBe("last_used_at");
    expect(() => RecallTimeFieldSchema.parse("anything_else")).toThrow();
  });

  it("accepts an optional recent_turn without requiring old callers to send it", () => {
    expect(SoulMemorySearchRequestSchema.parse({ ...baseRequest }).recent_turn).toBeUndefined();

    const parsed = SoulMemorySearchRequestSchema.parse({
      ...baseRequest,
      recent_turn: "From now on always call me by my handle, not my full name."
    });
    expect(parsed.recent_turn).toBe("From now on always call me by my handle, not my full name.");

    expect(
      SoulMemorySearchRequestSchema.safeParse({ ...baseRequest, recent_turn: "x".repeat(4097) })
        .success
    ).toBe(false);

    const recallSchema = soulToolJsonSchemas["soul.recall"] as {
      readonly properties?: Record<string, unknown>;
    };
    expect(recallSchema.properties?.["recent_turn"]).toBeDefined();
  });
});
