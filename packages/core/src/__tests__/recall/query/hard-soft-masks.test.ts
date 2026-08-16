import { describe, expect, it } from "vitest";
import { evaluateHardMask, applySoftConditionFactors } from
  "../../../recall/query/condition/hard-soft-masks.js";
import {
  CLOCK_AS_OF,
  completeCondition,
  GENERATION_ID,
  node,
  OTHER_GENERATION_ID
} from "./query-condition-test-fixtures.js";

const MASK = {
  workspace_id: "workspace-1",
  principal: "agent",
  authorized_scopes: ["workspace-1", "project-a"],
  explicit_bridges: ["bridge-adopt"],
  generation_id: GENERATION_ID,
  effective_as_of: CLOCK_AS_OF
} as const;

describe("query condition hard and soft masks", () => {
  it("denies the same graph under a foreign principal", () => {
    expect(evaluateHardMask(node("owned"), MASK)).toBe("allow");
    expect(evaluateHardMask(node("owned"), {
      ...MASK,
      principal: "foreign-agent"
    })).toBe("deny");
    expect(evaluateHardMask(node("owned", { principal: "foreign-agent" }), MASK))
      .toBe("deny");
  });

  it("denies a cross-scope node without an explicit bridge", () => {
    expect(evaluateHardMask(node("foreign", { scope: "other-scope" }), MASK)).toBe("deny");
  });

  it("allows an adopted projection through an explicit bridge", () => {
    expect(evaluateHardMask(node("adopted", {
      scope: "foreign-scope",
      adopted_bridge: "bridge-adopt"
    }), MASK)).toBe("allow");
  });

  it("denies mixed generation, sealed, erased, revoked, and inactive time", () => {
    expect(evaluateHardMask(node("other-gen", {
      generation_id: OTHER_GENERATION_ID
    }), MASK)).toBe("deny");
    expect(evaluateHardMask(node("sealed", { sealed: true }), MASK)).toBe("deny");
    expect(evaluateHardMask(node("erased", { erased: true }), MASK)).toBe("deny");
    expect(evaluateHardMask(node("revoked", { revoked: true }), MASK)).toBe("deny");
    expect(evaluateHardMask(node("future", {
      valid_from: "2026-09-01T00:00:00.000Z"
    }), MASK)).toBe("deny");
    expect(evaluateHardMask(node("expired", {
      valid_from: "2026-01-01T00:00:00.000Z",
      valid_to: "2026-08-01T00:00:00.000Z"
    }), MASK)).toBe("deny");
  });

  it("allows unknown valid time as soft-recallable, not hard-active", () => {
    expect(evaluateHardMask(node("unknown-time", { valid_from: null }), MASK)).toBe("allow");
  });

  it("softens unmatched task factors without denying membership", () => {
    const condition = completeCondition();
    const matched = applySoftConditionFactors({
      lambda: 0.6,
      hop_cost: 0.05,
      node: node("matched", { task_factor_id: "task:ada" }),
      condition
    });
    const unmatched = applySoftConditionFactors({
      lambda: 0.6,
      hop_cost: 0.05,
      node: node("plain"),
      condition
    });

    expect(matched.lambda).toBe(0.6);
    expect(unmatched.lambda).toBeLessThan(matched.lambda);
    expect(unmatched.lambda).toBeGreaterThanOrEqual(0);
    expect(unmatched.lambda).toBeLessThan(1);
  });
});
