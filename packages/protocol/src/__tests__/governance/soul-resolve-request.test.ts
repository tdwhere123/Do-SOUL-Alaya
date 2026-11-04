import { describe, expect, it } from "vitest";
import { SoulResolveRequestSchema, SoulResolutionKind } from "../../governance/resolution.js";

const base = {
  target_object_id: "claim-1",
  delivery_id: "delivery-1"
} as const;

describe("SoulResolveRequestSchema", () => {
  it("parses confirm without correction or defer_until", () => {
    expect(SoulResolveRequestSchema.parse({
      ...base,
      resolution: SoulResolutionKind.CONFIRM
    })).toMatchObject({ resolution: SoulResolutionKind.CONFIRM });
  });

  it("rejects correct without a non-empty correction", () => {
    expect(SoulResolveRequestSchema.safeParse({
      ...base,
      resolution: SoulResolutionKind.CORRECT
    }).success).toBe(false);
    expect(SoulResolveRequestSchema.safeParse({
      ...base,
      resolution: SoulResolutionKind.CORRECT,
      correction: "   "
    }).success).toBe(false);
  });

  it("parses correct with correction", () => {
    expect(SoulResolveRequestSchema.parse({
      ...base,
      resolution: SoulResolutionKind.CORRECT,
      correction: "use the workspace package manager"
    }).correction).toBe("use the workspace package manager");
  });

  it("rejects defer without defer_until", () => {
    expect(SoulResolveRequestSchema.safeParse({
      ...base,
      resolution: SoulResolutionKind.DEFER
    }).success).toBe(false);
  });

  it("parses defer with defer_until", () => {
    expect(SoulResolveRequestSchema.parse({
      ...base,
      resolution: SoulResolutionKind.DEFER,
      defer_until: "2026-05-18T00:00:00.000Z"
    }).defer_until).toBe("2026-05-18T00:00:00.000Z");
  });
});
