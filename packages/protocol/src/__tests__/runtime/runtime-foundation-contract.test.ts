import { describe, expect, it } from "vitest";
import {
  laterTimestamp,
  loadRuntimeFoundationContracts,
  requiredRuntimeFoundationExports,
  validTimestamp
} from "./runtime-foundation-contract-support.js";

describe("Phase A1 runtime foundation protocol schemas", () => {
  it("parses core runtime foundation contracts and exposes the top-level exports", async () => {
    const runtime = await loadRuntimeFoundationContracts();
    for (const exportName of requiredRuntimeFoundationExports) {
      expect(runtime.protocol[exportName]).toBeDefined();
    }
    expect(runtime.NodeTemplateKindSchema.options).toEqual(["analyze", "plan", "build", "review"]);
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
    const toolSpec = {
      tool_id: "tool.read_workspace",
      category: "read",
      description: "Read workspace files",
      scope_guard: "workspace",
      read_only: true,
      destructive: false,
      concurrency_safe: true,
      interrupt_behavior: "continue",
      requires_confirmation: false,
      requires_evidence_reopen: false,
      rollback_support: "none",
      fast_path_eligible: true
    } as const;
    expect(ToolSpecSchema.parse(toolSpec)).toEqual(toolSpec);
    expect(
      ToolSpecSchema.safeParse({
        ...toolSpec,
        category: "mutate"
      }).success
    ).toBe(false);
    expect(
      ToolSpecSchema.safeParse({
        ...toolSpec,
        scope_guard: "repo"
      }).success
    ).toBe(false);
    expect(
      ToolSpecSchema.safeParse({
        ...toolSpec,
        rollback_support: "maybe"
      }).success
    ).toBe(false);

    const toolGovernanceQuery = {
      governance_subject: {
        subject_domain: "runtime_governance",
        subject_qualifiers: { scope: "workspace" },
        canonical_key: "runtime_governance::scope=workspace"
      },
      tool_category: "validation",
      scope_guard: "project",
      destructive: false,
      requested_by: "principal",
      request_context: {
        node_template: "plan",
        execution_stance_ref: "stance-resolution-1",
        project_ref: "project-1"
      }
    } as const;
    expect(ToolGovernanceQuerySchema.parse(toolGovernanceQuery)).toEqual(toolGovernanceQuery);
    expect(
      ToolGovernanceQuerySchema.parse({
        ...toolGovernanceQuery,
        target_surface: "surface-1",
        target_paths: ["packages/protocol/src/index.ts"]
      })
    ).toEqual({
      ...toolGovernanceQuery,
      target_surface: "surface-1",
      target_paths: ["packages/protocol/src/index.ts"]
    });

    const toolGovernanceDecision = {
      final_result: "deny",
      matched_claim_refs: ["claim-1"],
      matched_slot_refs: ["slot-1"],
      hard_constraints_present: true,
      requires_red_card: true,
      explanation_summary: "The tool would violate a hard governance constraint."
    } as const;
    expect(ToolGovernanceDecisionSchema.parse(toolGovernanceDecision)).toEqual(toolGovernanceDecision);

    const toolExecutionRecord = {
      execution_id: "tool-exec-1",
      tool_id: "tool.read_workspace",
      requested_by: "worker",
      requesting_run_id: "run-1",
      governance_decision_ref: "decision-1",
      permission_result: "allow",
      executed: false,
      rollback_status: "none"
    } as const;
    expect(ToolExecutionRecordSchema.parse(toolExecutionRecord)).toEqual(toolExecutionRecord);
    expect(
      ToolExecutionRecordSchema.parse({
        ...toolExecutionRecord,
        executed: true,
        started_at: validTimestamp,
        ended_at: laterTimestamp,
        result_summary: "Read completed",
        post_effect_refs: ["evidence-1", "evidence-2"]
      })
    ).toEqual({
      ...toolExecutionRecord,
      executed: true,
      started_at: validTimestamp,
      ended_at: laterTimestamp,
      result_summary: "Read completed",
      post_effect_refs: ["evidence-1", "evidence-2"]
    });
    expect(
      ToolExecutionRecordSchema.parse({
        ...toolExecutionRecord,
        affected_paths: null
      })
    ).toEqual({
      ...toolExecutionRecord,
      affected_paths: null
    });
    expect(
      ToolExecutionRecordSchema.parse({
        ...toolExecutionRecord,
        affected_paths: ["src/index.ts", "docs/README.md"]
      })
    ).toEqual({
      ...toolExecutionRecord,
      affected_paths: ["src/index.ts", "docs/README.md"]
    });
    expect(
      ToolExecutionRecordSchema.safeParse({
        ...toolExecutionRecord,
        affected_paths: ["/tmp/escape.txt"]
      }).success
    ).toBe(false);

    const principalRun = {
      workspace_id: "workspace-1",
      run_id: "run-1",
      engine_class: "coding_engine",
      claim_mode: "STRICT",
      task_surface_ref: null,
      context_lens_ref: null,
      stance_resolution_ref: "stance-resolution-1",
      governance_lease_ref: "lease-1",
      active_node_id: null,
      created_at: validTimestamp,
      updated_at: laterTimestamp
    } as const;
    expect(PrincipalRunSchema.parse(principalRun)).toEqual(principalRun);
    expect(
      PrincipalRunSchema.safeParse({
        ...principalRun,
        principal_run_id: "principal-1"
      }).success
    ).toBe(false);

    const delegatedWorkerRun = {
      worker_run_id: "worker-run-1",
      principal_run_id: "run-1",
      workspace_id: "workspace-1",
      requesting_run_id: "run-1",
      engine_class: "conversation_engine",
      state: "init",
      subtask_description: "Inspect the package protocol exports.",
      local_surface_ref: "surface-1",
      local_evidence_pointer: null,
      restricted_tool_set: ["tool.read_workspace"],
      local_budget: {
        max_worker_delegations: 1,
        max_tool_calls: 4,
        max_output_tokens: 2000,
        max_wall_time_ms: 600000
      },
      agreed_return_format: {
        allowed_return_kinds: ["analysis_note", "handoff"],
        requires_structured_summary: true
      },
      principal_security_snapshot: {
        governance_lease_ref: "lease-1",
        hard_constraint_refs: ["constraint-1"],
        denied_tool_categories: ["governance"]
      },
      created_at: validTimestamp,
      updated_at: laterTimestamp
    } as const;
    expect(DelegatedWorkerRunSchema.parse(delegatedWorkerRun)).toEqual(delegatedWorkerRun);
    expect(
      DelegatedWorkerRunSchema.safeParse({
        ...delegatedWorkerRun,
        restricted_tool_set: undefined
      }).success
    ).toBe(false);
    expect(
      DelegatedWorkerRunSchema.safeParse({
        ...delegatedWorkerRun,
        local_budget: {
          max_tool_calls: 4,
          max_output_tokens: 2000,
          max_wall_time_ms: 600000
        }
      }).success
    ).toBe(false);
    expect(
      DelegatedWorkerRunSchema.safeParse({
        ...delegatedWorkerRun,
        agreed_return_format: {
          allowed_return_kinds: [],
          requires_structured_summary: true
        }
      }).success
    ).toBe(false);
    expect(
      DelegatedWorkerRunSchema.safeParse({
        ...delegatedWorkerRun,
        principal_security_snapshot: undefined
      }).success
    ).toBe(false);

    const stancePolicy = {
      policy_id: "stance-policy-1",
      task_surface_ref: "surface-1",
      derived_from: ["slot-1", "claim-1"],
      default_bias: "analyze_first",
      default_verification_attention: "high",
      default_write_posture: "guarded"
    } as const;
    expect(StancePolicySchema.parse(stancePolicy)).toEqual(stancePolicy);

    const stanceResolution = {
      resolution_id: "stance-resolution-1",
      policy_ref: "stance-policy-1",
      risk_signals: ["likely_tool_misuse", "likely_budget_pressure"],
      resolved_bias: "verify_first",
      resolved_verification_attention: "high",
      resolved_write_posture: "strict",
      created_at: validTimestamp,
      expires_at: laterTimestamp
    } as const;
    expect(StanceResolutionSchema.parse(stanceResolution)).toEqual(stanceResolution);
    expect(
      StanceResolutionSchema.safeParse({
        ...stanceResolution,
        risk_signals: ["not_frozen"]
      }).success
    ).toBe(false);
    expect(
      StancePolicySchema.safeParse({
        ...stancePolicy,
        risk_signals: ["likely_tool_misuse"]
      }).success
    ).toBe(false);

    const narrativeDigest = {
      digest_id: "digest-1",
      derived_from_workers: ["worker-run-1", "worker-run-2"],
      source_trust_tags: ["trusted", "verified"],
      bound_to: { run_id: "run-1" },
      created_at: validTimestamp,
      expires_at: laterTimestamp,
      retention_after_expiry: "audit_only"
    } as const;
    expect(NarrativeDigestSchema.parse(narrativeDigest)).toEqual(narrativeDigest);
    expect(
      NarrativeDigestSchema.safeParse({
        ...narrativeDigest,
        retention_after_expiry: "archive"
      }).success
    ).toBe(false);

    const consolidationTriggerBudget = {
      trigger_id: "trigger-1",
      trigger_source: "verification_failure",
      governance_subject: "governance-subject-1",
      source_object_ref: "claim-1",
      max_attempts_within_window: 2,
      attempts_used: 1,
      cooldown_until: laterTimestamp
    } as const;
    expect(ConsolidationTriggerBudgetSchema.parse(consolidationTriggerBudget)).toEqual(
      consolidationTriggerBudget
    );
    expect(
      ConsolidationTriggerBudgetSchema.safeParse({
        ...consolidationTriggerBudget,
        max_attempts_within_window: 0
      }).success
    ).toBe(false);
    expect(
      ConsolidationTriggerBudgetSchema.safeParse({
        ...consolidationTriggerBudget,
        attempts_used: 3
      }).success
    ).toBe(false);
  });
});
