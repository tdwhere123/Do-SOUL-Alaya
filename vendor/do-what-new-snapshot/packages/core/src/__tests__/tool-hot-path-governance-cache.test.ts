import type {
  EventLogEntry,
  WorkerRuntimeSessionConfig,
  ToolExecutionRecord,
  ToolGovernanceDecision,
  ToolGovernancePort,
  ToolGovernanceQuery,
  ToolSpec
} from "@do-what/protocol";
import { canonicalGovernanceSubject } from "@do-what/protocol";
import { describe, expect, it, vi } from "vitest";
import { ToolGovernanceClient, ToolHotPathFull, ToolSubstrate } from "../index.js";

describe("ToolHotPathFull governance cache integration", () => {
  it("reuses the governance cache for repeated executions in the same node bucket", async () => {
    const port = createPort();
    const hotPath = createHotPath(port);

    await hotPath.execute(createInput("node-a"));
    await hotPath.execute(createInput("node-a"));

    expect(port.queryToolGovernance).toHaveBeenCalledTimes(1);
  });

  it("misses the cache after invalidateNode is called", async () => {
    const port = createPort();
    const governanceClient = new ToolGovernanceClient({ port });
    const hotPath = createHotPath(port, governanceClient);

    await hotPath.execute(createInput("node-a"));
    governanceClient.invalidateNode("node-a");
    await hotPath.execute(createInput("node-a"));

    expect(port.queryToolGovernance).toHaveBeenCalledTimes(2);
  });

  it("misses the cache after the governance decision ttl expires", async () => {
    let nowMs = 1_000;
    const port = createPort();
    const governanceClient = new ToolGovernanceClient({
      port,
      ttlMs: 25,
      now: () => nowMs
    });
    const hotPath = createHotPath(port, governanceClient);

    await hotPath.execute(createInput("node-a"));
    nowMs = 1_024;
    await hotPath.execute(createInput("node-a"));
    nowMs = 1_026;
    await hotPath.execute(createInput("node-a"));

    expect(port.queryToolGovernance).toHaveBeenCalledTimes(2);
  });
});

function createHotPath(port: ToolGovernancePort, governanceClient?: ToolGovernanceClient) {
  return new ToolHotPathFull({
    substrate: new ToolSubstrate({
      generateExecutionId: () => "exec-001",
      now: () => "2026-04-12T10:00:00.000Z"
    }),
    governanceClient: governanceClient ?? new ToolGovernanceClient({ port }),
    targetRevalidateService: {
      findAndRevalidate: vi.fn(async () => [])
    },
    fastPath: {
      execute: vi.fn()
    },
    executionRecordRepo: {
      insert: vi.fn(async (record: ToolExecutionRecord) => record)
    },
    eventLogRepo: {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => ({
        ...entry,
        event_id: `event-${entry.event_type}`,
        created_at: "2026-04-12T10:00:00.100Z"
      }))
    },
    sseBroadcaster: {
      broadcastEntry: vi.fn(async () => {})
    },
    approvalSink: {
      requestApproval: vi.fn(async () => "approved" as const)
    },
    now: () => "2026-04-12T10:00:01.000Z",
    generateExecutionId: () => "gov-001"
  });
}

function createInput(nodeId: string) {
  return {
    toolSpec: createToolSpec(),
    rawInput: { path: "README.md" },
    governanceQueryBuilder: (): ToolGovernanceQuery => ({
      governance_subject: canonicalGovernanceSubject("tooling.policy", { execution: "exec-001" }),
      tool_category: "write",
      scope_guard: "project",
      destructive: false,
      requested_by: "principal",
      request_context: {
        node_template: "build",
        execution_stance_ref: "stance-default",
        project_ref: "project-alpha"
      }
    }),
    sessionConfig: createSessionConfig(),
    requestedBy: "principal" as const,
    requestingRunId: "run-principal-1",
    nodeId,
    stancePolicy: {
      policy_id: "policy-1",
      task_surface_ref: "surface://task/default",
      derived_from: [],
      default_bias: "analyze_first" as const,
      default_verification_attention: "high" as const,
      default_write_posture: "permissive" as const
    },
    stanceResolution: {
      resolution_id: "resolution-1",
      policy_ref: "policy-1",
      risk_signals: [],
      resolved_bias: "analyze_first" as const,
      resolved_verification_attention: "high" as const,
      resolved_write_posture: "permissive" as const,
      created_at: "2026-04-12T10:00:00.000Z",
      expires_at: "2026-04-12T11:00:00.000Z"
    },
    deniedToolCategories: [],
    handler: async () => ({ ok: true })
  };
}

function createPort(): ToolGovernancePort & { readonly queryToolGovernance: ReturnType<typeof vi.fn> } {
  const queryToolGovernance = vi.fn(async () => createGovernanceDecision());
  return {
    kind: "test-governance-port",
    queryToolGovernance
  };
}

function createGovernanceDecision(overrides: Partial<ToolGovernanceDecision> = {}): ToolGovernanceDecision {
  return {
    final_result: "allow",
    matched_claim_refs: ["claim-1"],
    matched_slot_refs: ["slot-1"],
    hard_constraints_present: false,
    requires_red_card: false,
    explanation_summary: "governance allows this tool request",
    ...overrides
  };
}

function createToolSpec(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    tool_id: overrides.tool_id ?? "tools.write_file",
    category: overrides.category ?? "write",
    description: overrides.description ?? "Write a file in the workspace.",
    scope_guard: overrides.scope_guard ?? "project",
    read_only: overrides.read_only ?? false,
    destructive: overrides.destructive ?? false,
    concurrency_safe: overrides.concurrency_safe ?? true,
    interrupt_behavior: overrides.interrupt_behavior ?? "continue",
    requires_confirmation: overrides.requires_confirmation ?? false,
    requires_evidence_reopen: overrides.requires_evidence_reopen ?? false,
    rollback_support: overrides.rollback_support ?? "none",
    fast_path_eligible: overrides.fast_path_eligible ?? false
  };
}

function createSessionConfig(
  overrides: Partial<WorkerRuntimeSessionConfig> = {}
): WorkerRuntimeSessionConfig {
  return {
    role: "worker",
    workspace_id: "ws-hot-path",
    run_id: "run-principal-1",
    cwd: "/workspace/project",
    writable_roots: ["/workspace/project"],
    tool_profile: "default",
    allowed_mcp_servers: ["filesystem"],
    sandbox_policy: "workspace_write",
    permission_policy: "ask",
    network_policy: "enabled",
    ...overrides
  };
}
