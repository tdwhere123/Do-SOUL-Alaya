import { describe, expect, it } from "vitest";
import {
  hashR3SpendApproval,
  parseR3SpendApproval,
  verifyR3SpendApproval
} from "../../../longmemeval/promotion/r3-spend-approval.js";

describe("R3 spend approval", () => {
  it("accepts a fresh approval bound to a valid material R2 result and exact 500Q target", () => {
    const approval = fixture();
    const verified = verifyR3SpendApproval(approval, expectation());

    expect(verified.approval_digest).toBe(hashR3SpendApproval(approval));
    expect(verified.approval.target.selected_count).toBe(500);
  });

  it("rejects a nonmaterial 100Q result before it can open 500Q", () => {
    expect(() => verifyR3SpendApproval({
      ...fixture(), r2: { ...fixture().r2, b_a_net_r5_wins: 4 }
    }, expectation())).toThrow(/net R@5 wins/u);
  });

  it("rejects alternate material-effect values that still pass the thresholds", () => {
    expect(() => verifyR3SpendApproval({
      ...fixture(),
      r2: {
        ...fixture().r2,
        b_a_net_r5_wins: 7,
        mcnemar: { method: "exact_two_sided", p_value: 0.02 }
      }
    }, expectation())).toThrow(/material effect/u);
  });

  it("rejects a mismatched target identity even when the effect passes", () => {
    expect(() => verifyR3SpendApproval({
      ...fixture(), target: { ...fixture().target, cache_identity_sha256: "9".repeat(64) }
    }, expectation())).toThrow(/target cache identity/u);
  });

  it("rejects a non-exact or non-significant McNemar result", () => {
    expect(() => verifyR3SpendApproval({
      ...fixture(), r2: { ...fixture().r2, mcnemar: { method: "asymptotic", p_value: 0.01 } }
    }, expectation())).toThrow(/exact two-sided McNemar/u);
    expect(() => verifyR3SpendApproval({
      ...fixture(), r2: { ...fixture().r2, mcnemar: { method: "exact_two_sided", p_value: 0.05 } }
    }, expectation())).toThrow(/p < 0.05/u);
  });

  it("rejects a scope or cap that could widen the authorized 500Q spend", () => {
    expect(() => parseR3SpendApproval({
      ...fixture(), target: { ...fixture().target, selected_count: 501 }
    })).toThrow(/selected_count/u);
    expect(() => verifyR3SpendApproval({
      ...fixture(), spend: { ...fixture().spend, maximum_attempts: 79506 }
    }, expectation())).toThrow(/110 percent attempt/u);
  });
});

function fixture() {
  return {
    schema_version: 1 as const,
    kind: "longmemeval_r3_spend_approval" as const,
    status: "approved" as const,
    operator: { identity: "operator@example", approved_at: "2026-07-17T00:00:00.000Z" },
    r2: {
      matrix_authorization_sha256: "1".repeat(64),
      source_selection_sha256: "2".repeat(64),
      source_selected_count: 100 as const,
      final_cache_identity_sha256: "3".repeat(64),
      hard_gates_passed: true as const,
      answerable_count: 94,
      b_a_net_r5_wins: 6,
      mcnemar: { method: "exact_two_sided" as const, p_value: 0.03125 }
    },
    target: {
      selection_sha256: "4".repeat(64),
      selected_count: 500 as const,
      cache_identity_sha256: "3".repeat(64)
    },
    spend: {
      starting_missing: 72277,
      maximum_attempts: 79505,
      successful_shard_ceiling: 72277,
      estimated_cost_usd: 99.5,
      disk_floor_bytes: 1000000
    }
  };
}

function expectation() {
  return {
    matrixAuthorizationSha256: "1".repeat(64),
    sourceSelectionSha256: "2".repeat(64),
    sourceSelectedCount: 100,
    finalCacheIdentitySha256: "3".repeat(64),
    targetSelectionSha256: "4".repeat(64),
    targetSelectedCount: 500,
    startingMissing: 72277,
    maximumAttempts: 79505,
    successfulShardCeiling: 72277,
    materialEffect: {
      paired_r_at_5: {
        answerable_count: 94 as const,
        control_hits: 80,
        product_hits: 86,
        gained: 6,
        lost: 0,
        net: 6,
        mcnemar: { method: "exact_two_sided" as const, p_value: 0.03125 }
      }
    }
  };
}
