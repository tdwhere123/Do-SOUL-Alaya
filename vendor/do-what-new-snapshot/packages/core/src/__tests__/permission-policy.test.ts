import type {
  StancePolicy,
  StanceResolution,
  ToolCategory,
  ToolGovernanceDecision,
  ToolSpec
} from "@do-what/protocol";
import { describe, expect, it } from "vitest";
import { resolvePermission } from "../index.js";
import type { PermissionDecisionReasonCode, PermissionResolutionInput } from "../index.js";

describe("resolvePermission", () => {
  it("denies when the tool category is blocked by the worker security snapshot", () => {
    const input = createInput({
      deniedToolCategories: ["exec"],
      toolSpec: { category: "exec" }
    });

    expectDecision(input, "deny", "denied_tool_category");
  });

  it("denies from governance before checking destructive strict posture", () => {
    const input = createInput({
      governanceDecision: { final_result: "deny" },
      toolSpec: { destructive: true },
      stanceResolution: { resolved_write_posture: "strict" }
    });

    expectDecision(input, "deny", "governance_deny");
  });

  it("keeps denied categories ahead of governance deny", () => {
    const input = createInput({
      deniedToolCategories: ["exec"],
      governanceDecision: { final_result: "deny" },
      toolSpec: { category: "exec" }
    });

    expectDecision(input, "deny", "denied_tool_category");
  });

  it("denies destructive tools when the resolved write posture is strict", () => {
    const input = createInput({
      toolSpec: { destructive: true },
      stanceResolution: { resolved_write_posture: "strict" }
    });

    expectDecision(input, "deny", "destructive_strict_posture");
  });

  it("falls back to the stance policy default write posture when no resolution exists", () => {
    const input = createInput({
      toolSpec: { destructive: true },
      stancePolicy: { default_write_posture: "strict" },
      stanceResolution: undefined
    });

    expectDecision(input, "deny", "destructive_strict_posture");
  });

  it("defaults missing write posture inputs to permissive before later checks", () => {
    const input = createInput({
      toolSpec: { destructive: true },
      stancePolicy: undefined,
      stanceResolution: undefined
    });

    expectDecision(input, "allow", "policy_allow");
  });

  it("asks when governance requires approval and no deny condition wins first", () => {
    const input = createInput({
      governanceDecision: { final_result: "ask" }
    });

    expectDecision(input, "ask", "governance_ask");
  });

  it("keeps governance ask ahead of requires_confirmation", () => {
    const input = createInput({
      governanceDecision: { final_result: "ask" },
      toolSpec: { requires_confirmation: true }
    });

    expectDecision(input, "ask", "governance_ask");
  });

  it("asks when the tool requires confirmation after governance allows it", () => {
    const input = createInput({
      toolSpec: { requires_confirmation: true }
    });

    expectDecision(input, "ask", "requires_confirmation");
  });

  it("allows read-only fast-path-eligible tools when all higher-priority checks clear", () => {
    const input = createInput({
      toolSpec: {
        read_only: true,
        fast_path_eligible: true
      }
    });

    expectDecision(input, "allow", "read_only_tool");
  });

  it("allows by policy when no deny, ask, or read-only shortcut applies", () => {
    const input = createInput();

    expectDecision(input, "allow", "policy_allow");
  });

  it("does not mutate its readonly inputs while resolving the decision", () => {
    const input = createInput({
      deniedToolCategories: ["network"],
      toolSpec: { category: "read" }
    });
    const before = {
      deniedToolCategories: [...input.deniedToolCategories],
      toolSpec: { ...input.toolSpec },
      governanceDecision: { ...input.governanceDecision },
      stancePolicy: input.stancePolicy ? { ...input.stancePolicy } : undefined,
      stanceResolution: input.stanceResolution ? { ...input.stanceResolution } : undefined
    };

    resolvePermission(input);

    expect(input.deniedToolCategories).toEqual(before.deniedToolCategories);
    expect(input.toolSpec).toEqual(before.toolSpec);
    expect(input.governanceDecision).toEqual(before.governanceDecision);
    expect(input.stancePolicy).toEqual(before.stancePolicy);
    expect(input.stanceResolution).toEqual(before.stanceResolution);
  });

  it("normalizes multiline governance explanations into a single line", () => {
    const input = createInput({
      governanceDecision: {
        final_result: "ask",
        explanation_summary: "needs\n\nmore\tcontext before approval"
      }
    });

    const decision = resolvePermission(input);

    expect(decision.reasonCode).toBe("governance_ask");
    expect(decision.explanation).toBe(
      "Governance requires confirmation for this tool request: needs more context before approval."
    );
  });
});

function expectDecision(
  input: PermissionResolutionInput,
  result: "allow" | "ask" | "deny",
  reasonCode: PermissionDecisionReasonCode
) {
  const decision = resolvePermission(input);

  expect(decision.result).toBe(result);
  expect(decision.reasonCode).toBe(reasonCode);
  expect(decision.explanation).toEqual(expect.any(String));
  expect(decision.explanation).not.toHaveLength(0);
  expect(decision.explanation).not.toContain("\n");
}

function createInput(
  overrides: Partial<{
    toolSpec: Partial<ToolSpec>;
    governanceDecision: Partial<ToolGovernanceDecision>;
    stancePolicy: Partial<StancePolicy> | undefined;
    stanceResolution: Partial<StanceResolution> | undefined;
    deniedToolCategories: readonly ToolCategory[];
  }> = {}
): PermissionResolutionInput {
  const hasStancePolicyOverride = Object.prototype.hasOwnProperty.call(overrides, "stancePolicy");
  const hasStanceResolutionOverride = Object.prototype.hasOwnProperty.call(overrides, "stanceResolution");

  return {
    toolSpec: {
      tool_id: "tools.read_file",
      category: "read",
      description: "Read a file from the workspace",
      scope_guard: "workspace",
      read_only: false,
      destructive: false,
      concurrency_safe: true,
      interrupt_behavior: "continue",
      requires_confirmation: false,
      requires_evidence_reopen: false,
      rollback_support: "none",
      fast_path_eligible: false,
      ...overrides.toolSpec
    },
    governanceDecision: {
      final_result: "allow",
      matched_claim_refs: [],
      matched_slot_refs: [],
      hard_constraints_present: false,
      requires_red_card: false,
      explanation_summary: "governance allows the tool request",
      ...overrides.governanceDecision
    },
    stancePolicy:
      hasStancePolicyOverride && overrides.stancePolicy === undefined
        ? undefined
        : ({
            policy_id: "stance_policy_default",
            task_surface_ref: "surface://task/default",
            derived_from: [],
            default_bias: "analyze_first",
            default_verification_attention: "medium",
            default_write_posture: "permissive",
            ...overrides.stancePolicy
          } satisfies StancePolicy),
    stanceResolution:
      hasStanceResolutionOverride && overrides.stanceResolution === undefined
        ? undefined
        : ({
            resolution_id: "stance_resolution_default",
            policy_ref: "stance_policy_default",
            risk_signals: [],
            resolved_bias: "analyze_first",
            resolved_verification_attention: "medium",
            resolved_write_posture: "permissive",
            created_at: "2026-04-12T09:00:00.000Z",
            expires_at: "2026-04-12T10:00:00.000Z",
            ...overrides.stanceResolution
          } satisfies StanceResolution),
    deniedToolCategories: overrides.deniedToolCategories ?? []
  };
}
