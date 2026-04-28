import {
  ToolGovernanceDecisionSchema,
  type ToolGovernancePort,
  type ToolGovernanceQuery
} from "@do-what/protocol";
import { describe, expect, it } from "vitest";

class StubAdapter implements ToolGovernancePort {
  public readonly kind = "stub-governance-port";

  public async queryToolGovernance(_query: ToolGovernanceQuery) {
    return {
      final_result: "allow",
      matched_claim_refs: [],
      matched_slot_refs: [],
      hard_constraints_present: false,
      requires_red_card: false,
      explanation_summary: "stub governance decision"
    } as const;
  }
}

describe("ToolGovernancePort", () => {
  it("is available from the top-level protocol package and supports a stub implementation", async () => {
    const adapter: ToolGovernancePort = new StubAdapter();
    const decision = await adapter.queryToolGovernance({} as ToolGovernanceQuery);

    expect(adapter.kind).toBe("stub-governance-port");
    expect(ToolGovernanceDecisionSchema.parse(decision)).toEqual(decision);
  });
});
