import { describe, expect, it } from "vitest";
import {
  SoulApplyOverrideRequestSchema,
  SoulApplyOverrideResponseSchema
} from "../../soul/mcp-types.js";

describe("session override MCP schemas", () => {
  it("parses a valid soul.apply_override request", () => {
    const request = {
      target_object: "memory:build-style",
      correction: "Use pnpm instead of npm.",
      priority: 2
    } as const;

    expect(SoulApplyOverrideRequestSchema.parse(request)).toEqual(request);
  });

  it("parses a valid soul.apply_override response", () => {
    const response = {
      override_id: "11111111-1111-4111-8111-111111111111",
      status: "applied"
    } as const;

    expect(SoulApplyOverrideResponseSchema.parse(response)).toEqual(response);
  });

  it("rejects invalid priority values", () => {
    expect(() =>
      SoulApplyOverrideRequestSchema.parse({
        target_object: "memory:build-style",
        correction: "Use pnpm instead of npm.",
        priority: -1
      })
    ).toThrow();
  });
});