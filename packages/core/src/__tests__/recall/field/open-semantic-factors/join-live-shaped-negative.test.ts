import { describe, expect, it } from "vitest";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../../recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../../recall/field/open-semantic-factors/composition.js";
import { rematerializeG8LiveFormation } from "./fixtures/g8-live-formation.js";

describe("live-shaped join negative contract", () => {
  it("does not invent a location partner from the live coupon formation", () => {
    const query = rematerializeG8LiveFormation("q3_query");
    const redeem = rematerializeG8LiveFormation("q3_evidence");
    expect(redeem.graph?.factors.some((factor) => factor.surface === "Target")).toBe(false);

    const composition = materializeOpenSemanticFactorComposition({
      trace: materializeOpenSemanticFactorCompatibilityTrace({
        query_capture: query,
        evidence_formations: { redeem }
      }),
      query_capture: query,
      evidence_formations: { redeem }
    });
    expect(composition).toMatchObject({
      status: "no_match",
      solution_count: 0
    });
    expect(composition.solutions.flatMap((solution) =>
      solution.result_bindings.map((binding) => binding.semantic_identity)
    )).not.toContain("target");
  });
});
