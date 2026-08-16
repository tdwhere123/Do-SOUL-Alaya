import { describe, expect, it } from "vitest";
import {
  assertTransientQueryCondition,
  projectSoftConditionFactors
} from "../../../recall/field/query-attribution/query-condition-attribution.js";
import { captureQueryCondition } from
  "../../../recall/query/condition/query-condition-capture.js";
import {
  conditionDraft,
  frozenClock,
  testPin,
  testSha256
} from "../query/query-condition-test-fixtures.js";

describe("query condition attribution", () => {
  it("keeps captured conditions transient and non-learning", () => {
    const receipt = captureQueryCondition(conditionDraft(), {
      sha256: testSha256(),
      now: frozenClock(),
      pin: testPin()
    });

    expect(() => assertTransientQueryCondition(receipt)).not.toThrow();
    expect(receipt.governance_effect).toBe("none");
    expect(receipt.deletion_behavior).toBe("rebuildable");
  });

  it("projects soft task factors without minting a learning receipt", () => {
    const receipt = captureQueryCondition(conditionDraft(), {
      sha256: testSha256(),
      now: frozenClock(),
      pin: testPin()
    });
    const factors = projectSoftConditionFactors({
      receipt,
      attributions: [{ query_atom_id: "lexical_term:ada", role: "entity" }]
    });

    expect(factors).toEqual(expect.arrayContaining([
      expect.objectContaining({ factor_id: "task:ada", role: "task" }),
      expect.objectContaining({ factor_id: "lexical_term:ada", role: "entity" })
    ]));
    expect(factors.every((factor) => factor.weight > 0 && factor.weight <= 1)).toBe(true);
    expect(factors).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ usage_kind: "causal" })
    ]));
  });
});
