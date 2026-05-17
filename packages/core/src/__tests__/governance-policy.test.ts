import { describe, expect, it } from "vitest";
import type { StagedWarning } from "@do-soul/alaya-protocol";
import {
  GovernancePolicy,
  GovernancePolicyOutcome
} from "../governance-policy.js";

function warning(
  overrides: Partial<StagedWarning> & Pick<StagedWarning, "kind" | "severity">
): StagedWarning {
  return {
    summary: overrides.summary ?? "test warning",
    policy: overrides.policy ?? "test-policy",
    resolution_options: overrides.resolution_options ?? ["defer"],
    ...overrides
  } as StagedWarning;
}

describe("GovernancePolicy.classifyWarning", () => {
  it("returns ask_now for blocking severity regardless of kind", () => {
    const policy = new GovernancePolicy({ askNowBudgetPerTurn: 10 });
    for (const kind of [
      "low_confidence",
      "contradiction_pending",
      "supersede_candidate",
      "evidence_missing",
      "policy_violation"
    ] as const) {
      const fresh = new GovernancePolicy({ askNowBudgetPerTurn: 10 });
      expect(fresh.classifyWarning(warning({ kind, severity: "blocking" }))).toBe(
        GovernancePolicyOutcome.ASK_NOW
      );
    }
    expect(policy).toBeDefined();
  });

  it("routes warning-level contradiction_pending / policy_violation to ask_now", () => {
    const policy = new GovernancePolicy({ askNowBudgetPerTurn: 10 });
    expect(
      policy.classifyWarning(warning({ kind: "contradiction_pending", severity: "warning" }))
    ).toBe(GovernancePolicyOutcome.ASK_NOW);
    expect(
      policy.classifyWarning(warning({ kind: "policy_violation", severity: "warning" }))
    ).toBe(GovernancePolicyOutcome.ASK_NOW);
  });

  it("routes supersede_candidate to apply_silently regardless of info/warning severity", () => {
    const policy = new GovernancePolicy({ askNowBudgetPerTurn: 10 });
    expect(
      policy.classifyWarning(warning({ kind: "supersede_candidate", severity: "info" }))
    ).toBe(GovernancePolicyOutcome.APPLY_SILENTLY);
    expect(
      policy.classifyWarning(warning({ kind: "supersede_candidate", severity: "warning" }))
    ).toBe(GovernancePolicyOutcome.APPLY_SILENTLY);
  });

  it("routes info-level low_confidence and evidence_missing to track_only", () => {
    const policy = new GovernancePolicy({ askNowBudgetPerTurn: 10 });
    expect(
      policy.classifyWarning(warning({ kind: "low_confidence", severity: "info" }))
    ).toBe(GovernancePolicyOutcome.TRACK_ONLY);
    expect(
      policy.classifyWarning(warning({ kind: "evidence_missing", severity: "info" }))
    ).toBe(GovernancePolicyOutcome.TRACK_ONLY);
  });

  it("falls through to inspect_later when ask_now budget is exhausted", () => {
    const policy = new GovernancePolicy({ askNowBudgetPerTurn: 2 });
    const blocking = warning({ kind: "contradiction_pending", severity: "blocking" });
    expect(policy.classifyWarning(blocking)).toBe(GovernancePolicyOutcome.ASK_NOW);
    expect(policy.classifyWarning(blocking)).toBe(GovernancePolicyOutcome.ASK_NOW);
    expect(policy.classifyWarning(blocking)).toBe(GovernancePolicyOutcome.INSPECT_LATER);
    expect(policy.askNowRemaining()).toBe(0);
  });

  it("resetTurn restores the ask_now budget", () => {
    const policy = new GovernancePolicy({ askNowBudgetPerTurn: 1 });
    const blocking = warning({ kind: "policy_violation", severity: "blocking" });
    expect(policy.classifyWarning(blocking)).toBe(GovernancePolicyOutcome.ASK_NOW);
    expect(policy.classifyWarning(blocking)).toBe(GovernancePolicyOutcome.INSPECT_LATER);
    policy.resetTurn();
    expect(policy.classifyWarning(blocking)).toBe(GovernancePolicyOutcome.ASK_NOW);
  });

  it("does not consume ask_now budget for non-ask_now outcomes", () => {
    const policy = new GovernancePolicy({ askNowBudgetPerTurn: 1 });
    expect(
      policy.classifyWarning(warning({ kind: "supersede_candidate", severity: "info" }))
    ).toBe(GovernancePolicyOutcome.APPLY_SILENTLY);
    expect(policy.askNowRemaining()).toBe(1);
  });
});
