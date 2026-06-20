import { describe, expect, it } from "vitest";
import {
  laterTimestamp,
  loadRuntimeFoundationContracts,
  requiredRuntimeFoundationExports,
  validTimestamp
} from "./runtime-foundation-contract-support.js";

describe("Phase A1 runtime foundation session schemas", () => {
  it("parses runtime session, config, event, and orphan contracts", async () => {
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
  });
});
