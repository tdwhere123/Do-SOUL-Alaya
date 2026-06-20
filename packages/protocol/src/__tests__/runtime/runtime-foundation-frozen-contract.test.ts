import { describe, expect, it } from "vitest";
import {
  laterTimestamp,
  loadRuntimeFoundationContracts,
  requiredRuntimeFoundationExports,
  validTimestamp
} from "./runtime-foundation-contract-support.js";

describe("Phase A1 runtime foundation frozen templates", () => {
  it("parses frozen node template contracts", async () => {
    const {
      ToolSpecSchema,
      ToolGovernanceQuerySchema,
      ToolGovernanceDecisionSchema,
      ToolExecutionRecordSchema,
      PrincipalRunSchema,
      DelegatedWorkerRunSchema,
      StancePolicySchema,
      StanceResolutionSchema,
      NarrativeDigestSchema,
      ConsolidationTriggerBudgetSchema,
      RuntimeSessionSchema,
      RuntimeTurnInputSchema,
      RuntimeCapabilitiesSchema,
      RuntimeSessionConfigSchema,
      RuntimeSandboxPolicySchema,
      RuntimePermissionPolicySchema,
      RuntimeNetworkPolicySchema,
      RuntimeCancelResultSchema,
      RuntimeEventSchema,
      OrphanedMemoryRecordSchema,
      NodeTemplateKindSchema,
      FrozenNodeTemplateContractsSchema,
      FROZEN_NODE_TEMPLATE_CONTRACTS,
      FrozenNodeTemplateContracts,
      assertFrozenNodeTemplateContracts
    } = await loadRuntimeFoundationContracts();
    const expectedFrozenNodeTemplateContracts = [
      {
        node_template: "analyze",
        input: ["prompt", "evidence"],
        output: ["analysis_note"],
        tools: ["read", "validation", "evidence"],
        approval: {
          checkpoint_required: false,
          user_confirmation_required: false
        },
        budget: {
          max_worker_delegations: 0,
          max_tool_calls: 3
        }
      },
      {
        node_template: "plan",
        input: ["goal"],
        output: ["plan"],
        tools: ["read", "validation", "governance"],
        approval: {
          checkpoint_required: true,
          user_confirmation_required: false
        },
        budget: {
          max_worker_delegations: 1,
          max_tool_calls: 4
        }
      },
      {
        node_template: "build",
        input: ["spec"],
        output: ["patch"],
        tools: ["read", "write", "exec", "validation"],
        approval: {
          checkpoint_required: true,
          user_confirmation_required: true
        },
        budget: {
          max_worker_delegations: 2,
          max_tool_calls: 8
        }
      },
      {
        node_template: "review",
        input: ["diff"],
        output: ["review_summary"],
        tools: ["read", "validation", "evidence"],
        approval: {
          checkpoint_required: false,
          user_confirmation_required: true
        },
        budget: {
          max_worker_delegations: 0,
          max_tool_calls: 2
        }
      }
    ] as const;

    expect(FROZEN_NODE_TEMPLATE_CONTRACTS).toEqual(expectedFrozenNodeTemplateContracts);
    expect(FrozenNodeTemplateContracts).toBe(FROZEN_NODE_TEMPLATE_CONTRACTS);
    expect(FrozenNodeTemplateContractsSchema.parse(FROZEN_NODE_TEMPLATE_CONTRACTS)).toEqual(
      expectedFrozenNodeTemplateContracts
    );
    expect(() => assertFrozenNodeTemplateContracts()).not.toThrow();
    expect(() => assertFrozenNodeTemplateContracts([])).toThrow("Invalid frozen node template contracts");
    expect(Object.isFrozen(FROZEN_NODE_TEMPLATE_CONTRACTS)).toBe(true);
    expect(Object.isFrozen(FROZEN_NODE_TEMPLATE_CONTRACTS[2])).toBe(true);
    expect(Object.isFrozen((FROZEN_NODE_TEMPLATE_CONTRACTS[2] as { approval: unknown }).approval)).toBe(true);
    expect(Object.isFrozen((FROZEN_NODE_TEMPLATE_CONTRACTS[2] as { budget: unknown }).budget)).toBe(true);
    expect(
      FrozenNodeTemplateContractsSchema.safeParse([
        {
          ...expectedFrozenNodeTemplateContracts[0],
          input: ["prompt"]
        },
        ...expectedFrozenNodeTemplateContracts.slice(1)
      ]).success
    ).toBe(false);
    expect(
      FrozenNodeTemplateContractsSchema.safeParse([
        expectedFrozenNodeTemplateContracts[0],
        {
          ...expectedFrozenNodeTemplateContracts[1],
          output: ["steps"]
        },
        ...expectedFrozenNodeTemplateContracts.slice(2)
      ]).success
    ).toBe(false);
    expect(
      FrozenNodeTemplateContractsSchema.safeParse([
        expectedFrozenNodeTemplateContracts[0],
        expectedFrozenNodeTemplateContracts[1],
        {
          ...expectedFrozenNodeTemplateContracts[2],
          tools: ["read", "write", "validation"]
        },
        expectedFrozenNodeTemplateContracts[3]
      ]).success
    ).toBe(false);
    expect(
      FrozenNodeTemplateContractsSchema.safeParse([
        expectedFrozenNodeTemplateContracts[0],
        {
          ...expectedFrozenNodeTemplateContracts[1],
          approval: {
            checkpoint_required: false,
            user_confirmation_required: false
          }
        },
        ...expectedFrozenNodeTemplateContracts.slice(2)
      ]).success
    ).toBe(false);
    expect(
      FrozenNodeTemplateContractsSchema.safeParse([
        ...expectedFrozenNodeTemplateContracts.slice(0, 3),
        {
          ...expectedFrozenNodeTemplateContracts[3],
          budget: {
            max_worker_delegations: 1,
            max_tool_calls: 2
          }
        }
      ]).success
    ).toBe(false);
  });

  it("rejects invalid runtime foundation values", async () => {
    const { ToolGovernanceQuerySchema, ToolExecutionRecordSchema, ConsolidationTriggerBudgetSchema, RuntimeEventSchema, FrozenNodeTemplateContractsSchema } = await loadRuntimeFoundationContracts();

    expect(
      ToolGovernanceQuerySchema.safeParse({
        governance_subject: {
          subject_domain: "runtime_governance",
          subject_qualifiers: {},
          canonical_key: "runtime_governance"
        },
        tool_category: "read",
        scope_guard: "workspace",
        target_paths: ["a"],
        destructive: false,
        requested_by: "principal",
        request_context: {
          node_template: "integrate",
          project_ref: "project-1"
        }
      }).success
    ).toBe(false);

    expect(
      ToolExecutionRecordSchema.safeParse({
        execution_id: "tool-exec-2",
        tool_id: "tool.read_workspace",
        requested_by: "principal",
        requesting_run_id: "run-1",
        governance_decision_ref: "decision-1",
        permission_result: "ask",
        executed: true,
        rollback_status: "failed",
        extra_field: true
      }).success
    ).toBe(false);

    expect(
      ConsolidationTriggerBudgetSchema.safeParse({
        trigger_id: "trigger-1",
        trigger_source: "native_surface_drift",
        max_attempts_within_window: 1,
        attempts_used: 0,
        cooldown_until: validTimestamp
      }).success
    ).toBe(true);

    expect(
      ConsolidationTriggerBudgetSchema.safeParse({
        trigger_id: "trigger-1",
        trigger_source: "not_allowed",
        max_attempts_within_window: 1,
        attempts_used: 0,
        cooldown_until: validTimestamp
      }).success
    ).toBe(false);

    expect(
      RuntimeEventSchema.safeParse({
        type: "tool_call_started",
        session_id: "session-1",
        emitted_at: validTimestamp,
        call_id: "call-1",
        tool_id: "tool.read_workspace",
        extra: "nope"
      }).success
    ).toBe(false);

    expect(
      FrozenNodeTemplateContractsSchema.safeParse([
        {
          node_template: "analyze",
          input: ["prompt"],
          output: ["analysis_note"],
          tools: ["read", "validation", "evidence"],
          approval: {
            checkpoint_required: false,
            user_confirmation_required: false
          },
          budget: {
            max_worker_delegations: 0,
            max_tool_calls: 3
          }
        }
      ]).success
    ).toBe(false);
  });
});
