import { describe, expect, it } from "vitest";
import {
  StrongRefSchema,
  TargetRevalidateResultSchema,
  TargetStaleStatusSchema
} from "../strong-ref.js";

function createStrongRefFixture(overrides: Record<string, unknown> = {}) {
  return {
    ref_id: "strong-ref-1",
    source_entity_type: "governance_lease",
    source_entity_id: "lease-1",
    target_entity_type: "claim_form",
    target_entity_id: "claim-1",
    workspace_id: "workspace-1",
    reason: "governance_lease",
    created_at: "2026-04-15T00:00:00.000Z",
    ...overrides
  };
}

describe("StrongRefSchema", () => {
  it("parses a valid strong ref and returns a readonly object", () => {
    const parsed = StrongRefSchema.parse(createStrongRefFixture());

    expect(parsed).toEqual(createStrongRefFixture());
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("rejects unknown reason values", () => {
    const result = StrongRefSchema.safeParse(
      createStrongRefFixture({
        reason: "unknown_reason"
      })
    );

    expect(result.success).toBe(false);
  });

  it("enforces strict fields", () => {
    const result = StrongRefSchema.safeParse(
      createStrongRefFixture({
        extra_field: "not-allowed"
      })
    );

    expect(result.success).toBe(false);
  });
});

describe("TargetRevalidateResultSchema", () => {
  it("parses stale result payload with stale_since", () => {
    const parsed = TargetRevalidateResultSchema.parse({
      ref_id: "strong-ref-1",
      status: "stale",
      revalidated_at: "2026-04-15T00:10:00.000Z",
      stale_since: "2026-04-15T00:05:00.000Z"
    });

    expect(parsed.status).toBe("stale");
    expect(parsed.stale_since).toBe("2026-04-15T00:05:00.000Z");
    expect(Object.isFrozen(parsed)).toBe(true);
  });

  it("supports all stale-status enum members", () => {
    expect(TargetStaleStatusSchema.parse("fresh")).toBe("fresh");
    expect(TargetStaleStatusSchema.parse("stale")).toBe("stale");
    expect(TargetStaleStatusSchema.parse("missing")).toBe("missing");
  });
});
