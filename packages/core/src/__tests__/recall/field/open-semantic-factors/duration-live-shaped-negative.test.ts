import { describe, expect, it } from "vitest";
import { materializeOpenSemanticFactorCompatibility } from
  "../../../../recall/field/open-semantic-factors/compatibility.js";
import { materializeOpenSemanticFactorCompatibilityTrace } from
  "../../../../recall/field/open-semantic-factors/compatibility-trace.js";
import { materializeOpenSemanticFactorComposition } from
  "../../../../recall/field/open-semantic-factors/composition.js";
import { rematerializeG8LiveFormation } from "./fixtures/g8-live-formation.js";

describe("live-shaped duration negative contract", () => {
  it("does not drop query to work for evidence daily commute", () => {
    const query = rematerializeG8LiveFormation("q2_query");
    const evidence = rematerializeG8LiveFormation("q2_evidence");
    expect(query.graph?.factors.some((factor) => factor.surface.includes("to work"))).toBe(true);
    expect(evidence.graph?.factors.some((factor) => factor.surface === "daily commute")).toBe(true);

    expect(materializeOpenSemanticFactorCompatibility({
      evidence_capture: evidence,
      query_capture: query
    })).toMatchObject({
      status: "incompatible",
      matched_query_proposition_count: 0
    });
    expect(materializeOpenSemanticFactorComposition({
      trace: materializeOpenSemanticFactorCompatibilityTrace({
        query_capture: query,
        evidence_formations: { live: evidence }
      }),
      query_capture: query
    })).toMatchObject({
      status: "no_match",
      solution_count: 0
    });
  });
});
