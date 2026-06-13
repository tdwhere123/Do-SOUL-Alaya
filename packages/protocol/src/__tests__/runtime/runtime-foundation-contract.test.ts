import { describe, expect, it } from "vitest";

const validTimestamp = "2026-04-10T00:00:00.000Z";
const laterTimestamp = "2026-04-10T01:00:00.000Z";

type ParseableSchema = {
  readonly parse: (value: unknown) => unknown;
  readonly safeParse: (value: unknown) => { readonly success: boolean };
};

describe("Phase A1 runtime foundation protocol schemas", () => {
  it("parses the frozen runtime foundation contracts and exposes the top-level exports", async () => {
    const protocol = (await import("../../" + "index.js")) as Record<string, unknown>;

    const requiredExports = [
      "ToolSpecSchema",
      "ToolGovernanceQuerySchema",
      "ToolGovernanceDecisionSchema",
      "ToolExecutionRecordSchema",
      "PrincipalRunSchema",
      "DelegatedWorkerRunSchema",
      "StancePolicySchema",
      "StanceResolutionSchema",
      "NarrativeDigestSchema",
      "ConsolidationTriggerBudgetSchema",
      "EngineClassSchema",
      "ClaimModeSchema",
      "WorkerRunStateSchema",
      "RuntimeSessionSchema",
      "RuntimeTurnInputSchema",
      "RuntimeCapabilitiesSchema",
      "RuntimeSessionConfigSchema",
      "RuntimeSandboxPolicySchema",
      "RuntimePermissionPolicySchema",
      "RuntimeNetworkPolicySchema",
      "RuntimeCancelResultSchema",
      "RuntimeEventSchema",
      "OrphanedMemoryRecordSchema",
      "NodeTemplateKindSchema",
      "FrozenNodeTemplateContractsSchema",
      "FROZEN_NODE_TEMPLATE_CONTRACTS",
      "FrozenNodeTemplateContracts",
      "assertFrozenNodeTemplateContracts"
    ] as const;

    for (const exportName of requiredExports) {
      expect(protocol[exportName]).toBeDefined();
    }

    const ToolSpecSchema = protocol.ToolSpecSchema as ParseableSchema;
    const ToolGovernanceQuerySchema = protocol.ToolGovernanceQuerySchema as ParseableSchema;
    const ToolGovernanceDecisionSchema = protocol.ToolGovernanceDecisionSchema as ParseableSchema;
    const ToolExecutionRecordSchema = protocol.ToolExecutionRecordSchema as ParseableSchema;
    const PrincipalRunSchema = protocol.PrincipalRunSchema as ParseableSchema;
    const DelegatedWorkerRunSchema = protocol.DelegatedWorkerRunSchema as ParseableSchema;
    const StancePolicySchema = protocol.StancePolicySchema as ParseableSchema;
    const StanceResolutionSchema = protocol.StanceResolutionSchema as ParseableSchema;
    const NarrativeDigestSchema = protocol.NarrativeDigestSchema as ParseableSchema;
    const ConsolidationTriggerBudgetSchema = protocol.ConsolidationTriggerBudgetSchema as ParseableSchema;
    const RuntimeSessionSchema = protocol.RuntimeSessionSchema as ParseableSchema;
    const RuntimeTurnInputSchema = protocol.RuntimeTurnInputSchema as ParseableSchema;
    const RuntimeCapabilitiesSchema = protocol.RuntimeCapabilitiesSchema as ParseableSchema;
    const RuntimeSessionConfigSchema = protocol.RuntimeSessionConfigSchema as ParseableSchema;
    const RuntimeSandboxPolicySchema = protocol.RuntimeSandboxPolicySchema as ParseableSchema;
    const RuntimePermissionPolicySchema = protocol.RuntimePermissionPolicySchema as ParseableSchema;
    const RuntimeNetworkPolicySchema = protocol.RuntimeNetworkPolicySchema as ParseableSchema;
    const RuntimeCancelResultSchema = protocol.RuntimeCancelResultSchema as ParseableSchema;
    const RuntimeEventSchema = protocol.RuntimeEventSchema as ParseableSchema;
    const OrphanedMemoryRecordSchema = protocol.OrphanedMemoryRecordSchema as ParseableSchema;
    const NodeTemplateKindSchema = protocol.NodeTemplateKindSchema as {
      options: readonly string[];
    };
    const FrozenNodeTemplateContractsSchema = protocol.FrozenNodeTemplateContractsSchema as {
      safeParse: (value: unknown) => { success: boolean };
      parse: (value: unknown) => unknown;
    };
    const FROZEN_NODE_TEMPLATE_CONTRACTS = protocol.FROZEN_NODE_TEMPLATE_CONTRACTS as readonly unknown[];
    const FrozenNodeTemplateContracts = protocol.FrozenNodeTemplateContracts as readonly unknown[];
    const assertFrozenNodeTemplateContracts = protocol.assertFrozenNodeTemplateContracts as (value?: unknown) => void;

    expect(NodeTemplateKindSchema.options).toEqual(["analyze", "plan", "build", "review"]);

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

    expect(
      RuntimeSessionSchema.parse({
        session_id: "session-1"
      })
    ).toEqual({
      session_id: "session-1"
    });
    expect(RuntimeTurnInputSchema.parse({ prompt: "Continue" })).toEqual({ prompt: "Continue" });
    expect(
      RuntimeCapabilitiesSchema.parse({
        supports_resume: true,
        supports_interrupt: true,
        supports_streaming_updates: true,
        supports_tool_events: true,
        supports_permission_requests: true,
        supports_artifact_events: true,
        supports_terminal_events: false
      })
    ).toEqual({
      supports_resume: true,
      supports_interrupt: true,
      supports_streaming_updates: true,
      supports_tool_events: true,
      supports_permission_requests: true,
      supports_artifact_events: true,
      supports_terminal_events: false
    });
    expect(
      RuntimeCapabilitiesSchema.safeParse({
        supportsResume: true,
        supportsInterrupt: true,
        supportsStreamingUpdates: true,
        supportsToolEvents: true,
        supportsPermissionRequests: true,
        supportsArtifactEvents: true,
        supportsTerminalEvents: false
      }).success
    ).toBe(false);
    expect(
      RuntimeSessionConfigSchema.parse({
        role: "principal",
        workspace_id: "workspace-1",
        run_id: "run-1",
        cwd: "/workspace",
        writable_roots: ["/workspace"],
        tool_profile: "default",
        allowed_mcp_servers: ["filesystem"],
        sandbox_policy: "workspace_write",
        permission_policy: "ask",
        network_policy: "restricted"
      })
    ).toEqual({
      role: "principal",
      workspace_id: "workspace-1",
      run_id: "run-1",
      cwd: "/workspace",
      writable_roots: ["/workspace"],
      tool_profile: "default",
      allowed_mcp_servers: ["filesystem"],
      sandbox_policy: "workspace_write",
      permission_policy: "ask",
      network_policy: "restricted"
    });
    expect(
      RuntimeSessionConfigSchema.parse({
        role: "principal",
        workspace_id: "workspace-1",
        run_id: "run-1",
        cwd: "/workspace",
        writable_roots: ["/workspace"],
        tool_profile: "principal_coding",
        allowed_mcp_servers: ["filesystem"],
        sandbox_policy: "workspace_write",
        permission_policy: "ask",
        network_policy: "restricted"
      })
    ).toEqual({
      role: "principal",
      workspace_id: "workspace-1",
      run_id: "run-1",
      cwd: "/workspace",
      writable_roots: ["/workspace"],
      tool_profile: "principal_coding",
      allowed_mcp_servers: ["filesystem"],
      sandbox_policy: "workspace_write",
      permission_policy: "ask",
      network_policy: "restricted"
    });
    expect(
      RuntimeSessionConfigSchema.parse({
        role: "worker",
        workspace_id: "workspace-1",
        run_id: "run-1",
        cwd: "/workspace",
        writable_roots: ["/workspace"],
        tool_profile: "default",
        allowed_mcp_servers: ["filesystem"],
        sandbox_policy: "workspace_write",
        permission_policy: "ask",
        network_policy: "restricted"
      })
    ).toEqual({
      role: "worker",
      workspace_id: "workspace-1",
      run_id: "run-1",
      cwd: "/workspace",
      writable_roots: ["/workspace"],
      tool_profile: "default",
      allowed_mcp_servers: ["filesystem"],
      sandbox_policy: "workspace_write",
      permission_policy: "ask",
      network_policy: "restricted"
    });
    expect(
      RuntimeSessionConfigSchema.parse({
        role: "worker",
        workspace_id: "workspace-1",
        run_id: "run-1",
        cwd: "/workspace",
        writable_roots: ["/workspace"],
        tool_profile: "coding",
        allowed_mcp_servers: ["filesystem"],
        sandbox_policy: "workspace_write",
        permission_policy: "ask",
        network_policy: "restricted"
      })
    ).toEqual({
      role: "worker",
      workspace_id: "workspace-1",
      run_id: "run-1",
      cwd: "/workspace",
      writable_roots: ["/workspace"],
      tool_profile: "coding",
      allowed_mcp_servers: ["filesystem"],
      sandbox_policy: "workspace_write",
      permission_policy: "ask",
      network_policy: "restricted"
    });
    expect(
      RuntimeSessionConfigSchema.safeParse({
        role: "principal",
        workspace_id: "workspace-1",
        cwd: "/workspace",
        writable_roots: ["/workspace"],
        tool_profile: "default",
        allowed_mcp_servers: ["filesystem"],
        sandbox_policy: "workspace_write",
        permission_policy: "ask",
        network_policy: "restricted"
      }).success
    ).toBe(false);
    expect(
      RuntimeSessionConfigSchema.safeParse({
        role: "principal",
        workspace_id: "workspace-1",
        run_id: "run-1",
        cwd: "/workspace",
        writable_roots: ["/workspace"],
        tool_profile: "conversation_engine",
        allowed_mcp_servers: ["filesystem"],
        sandbox_policy: "workspace_write",
        permission_policy: "ask",
        network_policy: "restricted"
      }).success
    ).toBe(false);
    expect(
      RuntimeSessionConfigSchema.parse({
        role: "worker",
        workspace_id: "workspace-1",
        cwd: "/workspace",
        writable_roots: ["/workspace"],
        tool_profile: "conversation_engine",
        allowed_mcp_servers: ["filesystem"],
        sandbox_policy: "workspace_write",
        permission_policy: "ask",
        network_policy: "restricted"
      })
    ).toEqual({
      role: "worker",
      workspace_id: "workspace-1",
      cwd: "/workspace",
      writable_roots: ["/workspace"],
      tool_profile: "conversation_engine",
      allowed_mcp_servers: ["filesystem"],
      sandbox_policy: "workspace_write",
      permission_policy: "ask",
      network_policy: "restricted"
    });
    expect(
      RuntimeSessionConfigSchema.safeParse({
        role: "worker",
        workspace_id: "workspace-1",
        cwd: "/workspace",
        writable_roots: ["/workspace"],
        tool_profile: "principal_coding",
        allowed_mcp_servers: ["filesystem"],
        sandbox_policy: "workspace_write",
        permission_policy: "ask",
        network_policy: "restricted"
      }).success
    ).toBe(false);
    expect(RuntimeSandboxPolicySchema.parse("workspace_write")).toBe("workspace_write");
    expect(RuntimePermissionPolicySchema.parse("ask")).toBe("ask");
    expect(RuntimeNetworkPolicySchema.parse("restricted")).toBe("restricted");
    expect(
      RuntimeSessionConfigSchema.safeParse({
        role: "worker",
        workspaceId: "workspace-1",
        cwd: "/workspace",
        writableRoots: ["/workspace"],
        toolProfile: "default",
        allowedMcpServers: [],
        sandboxPolicy: "anything",
        permissionPolicy: "anything",
        networkPolicy: "anything"
      }).success
    ).toBe(false);
    expect(
      RuntimeSessionConfigSchema.safeParse({
        role: "worker",
        workspace_id: "workspace-1",
        cwd: "/workspace",
        writable_roots: ["/workspace"],
        tool_profile: "default",
        allowed_mcp_servers: [],
        sandbox_policy: "anything",
        permission_policy: "anything",
        network_policy: "anything"
      }).success
    ).toBe(false);
    expect(
      RuntimeSessionConfigSchema.safeParse({
        role: "operator",
        workspace_id: "workspace-1",
        cwd: "/workspace",
        writable_roots: ["/workspace"],
        tool_profile: "default",
        allowed_mcp_servers: [],
        sandbox_policy: "workspace_write",
        permission_policy: "deny",
        network_policy: "restricted"
      }).success
    ).toBe(false);
    expect(
      RuntimeCancelResultSchema.parse({
        session_id: "session-1",
        status: "cancelled"
      })
    ).toEqual({
      session_id: "session-1",
      status: "cancelled"
    });
    expect(
      RuntimeEventSchema.parse({
        type: "message_delta",
        session_id: "session-1",
        emitted_at: validTimestamp,
        delta: "hello",
        sequence: 0
      })
    ).toEqual({
      type: "message_delta",
      session_id: "session-1",
      emitted_at: validTimestamp,
      delta: "hello",
      sequence: 0
    });
    expect(
      RuntimeEventSchema.parse({
        type: "tool_call_finished",
        session_id: "session-1",
        emitted_at: validTimestamp,
        call_id: "call-1",
        tool_id: "tool.read_workspace",
        outcome: "success",
        result_summary: null
      })
    ).toEqual({
      type: "tool_call_finished",
      session_id: "session-1",
      emitted_at: validTimestamp,
      call_id: "call-1",
      tool_id: "tool.read_workspace",
      outcome: "success",
      result_summary: null
    });
    expect(
      OrphanedMemoryRecordSchema.parse({
        memory_id: "memory-1",
        workspace_id: "workspace-1",
        suspected_surface_gaps: ["memory.surface_id:null"],
        orphan_confidence: 0.8
      })
    ).toEqual({
      memory_id: "memory-1",
      workspace_id: "workspace-1",
      suspected_surface_gaps: ["memory.surface_id:null"],
      orphan_confidence: 0.8
    });
    expect(
      OrphanedMemoryRecordSchema.safeParse({
        memory_id: "memory-1",
        workspace_id: "workspace-1",
        suspected_surface_gaps: [],
        orphan_confidence: 0.8
      }).success
    ).toBe(false);
    expect(
      OrphanedMemoryRecordSchema.safeParse({
        memory_id: "memory-1",
        workspace_id: "workspace-1",
        suspected_surface_gaps: ["memory.surface_id:null"],
        orphan_confidence: 1.2
      }).success
    ).toBe(false);

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
    const protocol = (await import("../../" + "index.js")) as Record<string, unknown>;
    const ToolGovernanceQuerySchema = protocol.ToolGovernanceQuerySchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const ToolExecutionRecordSchema = protocol.ToolExecutionRecordSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const ConsolidationTriggerBudgetSchema = protocol.ConsolidationTriggerBudgetSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const RuntimeEventSchema = protocol.RuntimeEventSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };
    const FrozenNodeTemplateContractsSchema = protocol.FrozenNodeTemplateContractsSchema as {
      safeParse: (value: unknown) => { success: boolean };
    };

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
