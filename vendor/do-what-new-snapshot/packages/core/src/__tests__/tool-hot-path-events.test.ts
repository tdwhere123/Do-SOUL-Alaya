import type {
  EventLogEntry,
  RuntimeEvent,
  WorkerRuntimeSessionConfig,
  ToolExecutionRecord,
  ToolGovernanceDecision,
  ToolGovernanceQuery,
  ToolSpec
} from "@do-what/protocol";
import { canonicalGovernanceSubject } from "@do-what/protocol";
import { describe, expect, it, vi } from "vitest";
import { ToolHotPathFull, ToolSubstrate } from "../index.js";
import { ScriptedRuntimeAdapter } from "../test-doubles/index.js";

describe("ToolHotPathFull event ordering", () => {
  it("appends approved before broadcasting it, then appends started before broadcasting it", async () => {
    const operations: string[] = [];
    const hotPath = createHotPath(operations, createGovernanceDecision());

    await hotPath.execute({
      toolSpec: createToolSpec(),
      rawInput: { path: "README.md" },
      governanceQueryBuilder: createGovernanceQueryBuilder(),
      sessionConfig: createSessionConfig(),
      requestedBy: "principal",
      requestingRunId: "run-principal-1",
      stancePolicy: createStancePolicy(),
      stanceResolution: createStanceResolution(),
      deniedToolCategories: [],
      handler: async () => ({ ok: true })
    });

    expect(operations).toEqual([
      "append:tool.intent.approved",
      "broadcast:tool.intent.approved",
      "append:tool_call.started",
      "broadcast:tool_call.started",
      "append:tool_call.completed",
      "insert:tool_call.completed",
      "broadcast:tool_call.completed"
    ]);
  });

  it("appends completed, inserts the execution record, and only then broadcasts it", async () => {
    const operations: string[] = [];
    const hotPath = createHotPath(operations, createGovernanceDecision());

    await hotPath.execute({
      toolSpec: createToolSpec(),
      rawInput: { path: "README.md" },
      governanceQueryBuilder: createGovernanceQueryBuilder(),
      sessionConfig: createSessionConfig(),
      requestedBy: "principal",
      requestingRunId: "run-principal-1",
      stancePolicy: createStancePolicy(),
      stanceResolution: createStanceResolution(),
      deniedToolCategories: [],
      handler: async () => ({ ok: true })
    });

    const completedIndex = operations.indexOf("append:tool_call.completed");
    const insertIndex = operations.indexOf("insert:tool_call.completed");
    const broadcastIndex = operations.indexOf("broadcast:tool_call.completed");

    expect(completedIndex).toBeGreaterThan(-1);
    expect(insertIndex).toBeGreaterThan(completedIndex);
    expect(broadcastIndex).toBeGreaterThan(insertIndex);
  });

  it("replays a complete happy-path tool-call sequence through ScriptedRuntimeAdapter", async () => {
    const operations: string[] = [];
    const hotPath = createHotPath(operations, createGovernanceDecision());

    await hotPath.execute({
      toolSpec: createToolSpec(),
      rawInput: { path: "README.md" },
      governanceQueryBuilder: createGovernanceQueryBuilder(),
      sessionConfig: createSessionConfig(),
      requestedBy: "principal",
      requestingRunId: "run-principal-1",
      stancePolicy: createStancePolicy(),
      stanceResolution: createStanceResolution(),
      deniedToolCategories: [],
      handler: async () => ({ ok: true })
    });

    const adapter = new ScriptedRuntimeAdapter(createHappyPathReplayEvents());
    const replayed: RuntimeEvent[] = [];
    const detach = adapter.onEvent((event) => {
      replayed.push(event);
    });
    const session = await adapter.createSession(createSessionConfig());

    await adapter.prompt(session.session_id, { prompt: "replay hot path" });
    await adapter.replay();
    detach();

    expect(replayed.map((event) => event.type)).toEqual([
      "session_started",
      "tool_call_started",
      "tool_call_finished",
      "session_finished"
    ]);
    expect(replayed[1]).toMatchObject({
      type: "tool_call_started",
      call_id: "exec-001",
      tool_id: "tools.write_file"
    });
    expect(replayed[2]).toMatchObject({
      type: "tool_call_finished",
      call_id: "exec-001",
      tool_id: "tools.write_file",
      outcome: "success"
    });
  });
});

function createHotPath(operations: string[], governanceDecision: ToolGovernanceDecision) {
  return new ToolHotPathFull({
    substrate: new ToolSubstrate({
      generateExecutionId: () => "exec-001",
      now: () => "2026-04-12T10:00:00.000Z"
    }),
    governanceClient: {
      query: vi.fn(async () => governanceDecision)
    },
    targetRevalidateService: {
      findAndRevalidate: vi.fn(async () => [])
    },
    fastPath: {
      execute: vi.fn()
    },
    executionRecordRepo: {
      insert: vi.fn(async (record: ToolExecutionRecord) => {
        operations.push("insert:tool_call.completed");
        return record;
      })
    },
    eventLogRepo: {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
        operations.push(`append:${entry.event_type}`);
        return {
          ...entry,
          event_id: `event-${entry.event_type}`,
          created_at: "2026-04-12T10:00:00.100Z"
        } satisfies EventLogEntry;
      })
    },
    sseBroadcaster: {
      broadcastEntry: vi.fn(async (entry: EventLogEntry) => {
        operations.push(`broadcast:${entry.event_type}`);
      })
    },
    approvalSink: {
      requestApproval: vi.fn(async () => "approved" as const)
    },
    now: () => "2026-04-12T10:00:01.000Z",
    generateExecutionId: () => "gov-001"
  });
}

function createGovernanceQueryBuilder() {
  return (): ToolGovernanceQuery => ({
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
  });
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

function createStancePolicy() {
  return {
    policy_id: "policy-1",
    task_surface_ref: "surface://task/default",
    derived_from: [],
    default_bias: "analyze_first" as const,
    default_verification_attention: "high" as const,
    default_write_posture: "permissive" as const
  };
}

function createStanceResolution() {
  return {
    resolution_id: "resolution-1",
    policy_ref: "policy-1",
    risk_signals: [],
    resolved_bias: "analyze_first" as const,
    resolved_verification_attention: "high" as const,
    resolved_write_posture: "permissive" as const,
    created_at: "2026-04-12T10:00:00.000Z",
    expires_at: "2026-04-12T11:00:00.000Z"
  };
}

function createHappyPathReplayEvents(): readonly RuntimeEvent[] {
  return [
    {
      type: "session_started",
      session_id: "scripted-session-1",
      emitted_at: "2026-04-12T10:00:00.000Z"
    },
    {
      type: "tool_call_started",
      session_id: "scripted-session-1",
      emitted_at: "2026-04-12T10:00:00.100Z",
      call_id: "exec-001",
      tool_id: "tools.write_file"
    },
    {
      type: "tool_call_finished",
      session_id: "scripted-session-1",
      emitted_at: "2026-04-12T10:00:01.000Z",
      call_id: "exec-001",
      tool_id: "tools.write_file",
      outcome: "success",
      result_summary: "{\"ok\":true}"
    },
    {
      type: "session_finished",
      session_id: "scripted-session-1",
      emitted_at: "2026-04-12T10:00:01.100Z",
      status: "completed",
      result_summary: "replayed"
    }
  ];
}
