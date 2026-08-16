import { describe, expect, it } from "vitest";
import {
  hashR3SpendApproval,
  parseR3SpendApproval,
  verifyR3SpendApproval
} from "../../../longmemeval/promotion/r3-spend-approval.js";
import { computeExtractionFillAttemptCeiling } from
  "../../../longmemeval/extraction/authority/receipt-limits.js";

const STARTING_MISSING = 72_277;
const MAXIMUM_ATTEMPTS = computeExtractionFillAttemptCeiling(STARTING_MISSING);

describe("R3 spend approval", () => {
  it("accepts a fresh approval bound to qualified A/B diagnostics and exact 500Q target", () => {
    const approval = fixture();
    const verified = verifyR3SpendApproval(approval, expectation());

    expect(verified.approval_digest).toBe(hashR3SpendApproval(approval));
    expect(verified.approval.target.selected_count).toBe(500);
  });

  it("rejects malformed A/B diagnostics before they can open 500Q", () => {
    expect(() => verifyR3SpendApproval({
      ...fixture(), r2: { ...fixture().r2, b_a_net_r5_wins: 3.5 }
    }, expectation())).toThrow(/integer net R@5/u);
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

  it("rejects a non-exact McNemar diagnostic without significance gating", () => {
    expect(() => verifyR3SpendApproval({
      ...fixture(), r2: { ...fixture().r2, mcnemar: { method: "asymptotic", p_value: 0.01 } }
    }, expectation())).toThrow(/exact two-sided McNemar/u);
  });

  it("rejects a scope or cap that could widen the authorized 500Q spend", () => {
    expect(() => parseR3SpendApproval({
      ...fixture(), target: { ...fixture().target, selected_count: 501 }
    })).toThrow(/selected_count/u);
    expect(() => verifyR3SpendApproval({
      ...fixture(), spend: { ...fixture().spend, maximum_attempts: MAXIMUM_ATTEMPTS + 1 }
    }, expectation())).toThrow(/transport attempt/u);
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
      b_a_net_r5_wins: 3,
      mcnemar: { method: "exact_two_sided" as const, p_value: 0.375 }
    },
    target: {
      selection_sha256: "4".repeat(64),
      selected_count: 500 as const,
      cache_identity_sha256: "3".repeat(64)
    },
    spend: {
      starting_missing: STARTING_MISSING,
      maximum_attempts: MAXIMUM_ATTEMPTS,
      successful_shard_ceiling: STARTING_MISSING,
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
    startingMissing: STARTING_MISSING,
    maximumAttempts: MAXIMUM_ATTEMPTS,
    successfulShardCeiling: STARTING_MISSING,
    materialEffect: {
      paired_r_at_5: {
        answerable_count: 94 as const,
        control_hits: 87,
        product_hits: 90,
        gained: 4,
        lost: 1,
        net: 3,
        mcnemar: { method: "exact_two_sided" as const, p_value: 0.375 }
      }
    }
  };
}
