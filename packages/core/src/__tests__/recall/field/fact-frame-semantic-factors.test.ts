import { describe, expect, it } from "vitest";
import {
  alignFactFrameSemanticFactor,
  projectFactFrameSemanticFactors
} from "../../../recall/field/fact-frame-semantic-factors.js";

describe("Fact Frame semantic factor contract", () => {
  it("shares exact role and text projection between both sides", () => {
    const demand = projectFactFrameSemanticFactors([
      { role: "relation", text: "watch" }
    ], 0)[0]!;
    const candidate = projectFactFrameSemanticFactors([
      { role: "relation", text: "watch" }
    ])[0]!;

    expect(alignFactFrameSemanticFactor({
      candidate,
      demand,
      demand_kind: "relation",
      allow_porter: false,
      require_exact_role: true
    })).toBe("exact_token_sequence_v1");
  });

  it("does not cross-bind a value slot to a relation demand", () => {
    const demand = projectFactFrameSemanticFactors([
      { role: "relation", text: "watch" }
    ], 0)[0]!;
    const candidate = projectFactFrameSemanticFactors([
      { role: "value", text: "watch" }
    ])[0]!;

    expect(alignFactFrameSemanticFactor({
      candidate,
      demand,
      demand_kind: "relation",
      allow_porter: true,
      require_exact_role: true
    })).toBeNull();
  });

  it("requires porter provenance before bounded inflection alignment", () => {
    const demand = projectFactFrameSemanticFactors([
      { role: "relation", text: "watch" }
    ], 0)[0]!;
    const candidate = projectFactFrameSemanticFactors([
      { role: "relation", text: "watched" }
    ])[0]!;

    expect(alignFactFrameSemanticFactor({
      candidate,
      demand,
      demand_kind: "relation",
      allow_porter: false,
      require_exact_role: true
    })).toBeNull();
    expect(alignFactFrameSemanticFactor({
      candidate,
      demand,
      demand_kind: "relation",
      allow_porter: true,
      require_exact_role: true
    })).toBe("porter_regular_relation_inflection_v1");
  });
});
