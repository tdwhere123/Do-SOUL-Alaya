import type {
  EventLogEntry,
  WorkerRuntimeSessionConfig,
  ToolExecutionRecord,
  ToolSpec
} from "@do-what/protocol";
import { describe, expect, it, vi } from "vitest";
import { ToolFastPath } from "../tool-hot-path/fast-path.js";
import { ToolSubstrate } from "../tool-substrate/index.js";
import type { TestMock } from "./mock-types.js";

describe("ToolFastPath", () => {
  it("executes an eligible read-only tool, appends before broadcast, and inserts the final record once", async () => {
    const harness = createHarness();
    const toolSpec = createToolSpec();

    const result = await harness.fastPath.execute({
      toolSpec,
      rawInput: {},
      sessionConfig: createSessionConfig(),
      requestedBy: "principal",
      requestingRunId: "run-principal-1",
      handler: async (ctx, input) => {
        harness.operations.push(`handler:${ctx.executionId}:${ctx.startedAt}:${JSON.stringify(input)}`);
        return { ok: true };
      }
    });

    expect(result.result).toEqual({ ok: true });
    expect(result.executionRecord).toEqual(harness.insertedRecords[0]);
    expect(harness.insertedRecords).toHaveLength(1);
    expect(harness.insertedRecords[0]).toMatchObject({
      execution_id: "exec-001",
      tool_id: toolSpec.tool_id,
      requested_by: "principal",
      requesting_run_id: "run-principal-1",
      executed: true,
      permission_result: "allow",
      governance_decision_ref: "fast-path://skipped",
      started_at: "2026-04-12T10:00:00.000Z",
      ended_at: "2026-04-12T10:00:01.000Z",
      rollback_status: "none"
    });
    expect(harness.insertedRecords[0]?.result_summary).toContain("ok");
    expect(harness.operations).toEqual([
      "append:tool_call.started",
      "broadcast:tool_call.started",
      'handler:exec-001:2026-04-12T10:00:00.000Z:{}',
      "append:tool_call.completed",
      "insert:exec-001:true",
      "broadcast:tool_call.completed"
    ]);

    const startedEntry = harness.appendedEntries[0];
    const completedEntry = harness.appendedEntries[1];

    expect(startedEntry?.payload_json).toMatchObject({
      toolCallId: "exec-001",
      toolId: toolSpec.tool_id
    });
    expect(typeof startedEntry?.payload_json.inputSummary).toBe("string");
    expect(String(startedEntry?.payload_json.inputSummary).length).toBeGreaterThan(0);
    expect(completedEntry?.payload_json).toMatchObject({
      toolCallId: "exec-001",
      statusKind: "success"
    });
    expect(completedEntry?.payload_json).not.toHaveProperty("affected_paths");
    expect(result.executionRecord.affected_paths).toBeUndefined();
  });

  it("emits completion with error status, stores a final executed record, and rethrows the original handler error", async () => {
    const harness = createHarness();
    const toolSpec = createToolSpec();
    const handlerError = new Error("handler failed");

    await expect(
      harness.fastPath.execute({
        toolSpec,
        rawInput: { targetPath: "/workspace/project/README.md" },
        sessionConfig: createSessionConfig(),
        requestedBy: "worker",
        requestingRunId: "worker-run-1",
        handler: async () => {
          throw handlerError;
        }
      })
    ).rejects.toBe(handlerError);

    expect(harness.insertedRecords).toHaveLength(1);
    expect(harness.insertedRecords[0]).toMatchObject({
      execution_id: "exec-001",
      requested_by: "worker",
      requesting_run_id: "worker-run-1",
      executed: true
    });
    expect(harness.operations).toEqual([
      "append:tool_call.started",
      "broadcast:tool_call.started",
      "append:tool_call.completed",
      "insert:exec-001:true",
      "broadcast:tool_call.completed"
    ]);
    expect(harness.appendedEntries[1]?.payload_json).toMatchObject({
      toolCallId: "exec-001",
      statusKind: "error"
    });
  });

  it("wraps the original handler error when completion persistence fails on the error path", async () => {
    const handlerError = new Error("handler failed");
    const persistenceError = new Error("record insert failed");
    const harness = createHarness({
      insertImpl: vi.fn(async () => {
        throw persistenceError;
      })
    });

    await expect(
      harness.fastPath.execute({
        toolSpec: createToolSpec(),
        rawInput: { targetPath: "/workspace/project/README.md" },
        sessionConfig: createSessionConfig(),
        requestedBy: "worker",
        requestingRunId: "worker-run-1",
        handler: async () => {
          throw handlerError;
        }
      })
    ).rejects.toThrowError(
      expect.objectContaining({
        cause: handlerError,
        secondaryError: persistenceError
      })
    );

    expect(handlerError.cause).toBeUndefined();
    expect(harness.operations).toEqual([
      "append:tool_call.started",
      "broadcast:tool_call.started",
      "append:tool_call.completed"
    ]);
    expect(harness.broadcastEntries).toHaveLength(1);
  });

  it("caps fast-path input and output summaries at 200 characters", async () => {
    const harness = createHarness();
    const longSegment = "a".repeat(260);
    const longOutput = "b".repeat(260);

    const result = await harness.fastPath.execute({
      toolSpec: createToolSpec({ scope_guard: "workspace" }),
      rawInput: { targetPath: `/workspace/project/${longSegment}.txt` },
      sessionConfig: createSessionConfig(),
      requestedBy: "principal",
      requestingRunId: "run-principal-1",
      handler: async () => longOutput
    });

    expect((harness.appendedEntries[0]?.payload_json.inputSummary as string).length).toBe(200);
    expect((harness.appendedEntries[1]?.payload_json.outputSummary as string).length).toBe(200);
    expect(result.executionRecord.result_summary).toHaveLength(200);
  });

  it("rejects non-fast-path tools with a validation error and no side effects", async () => {
    const harness = createHarness();

    await expect(
      harness.fastPath.execute({
        toolSpec: createToolSpec({ fast_path_eligible: false }),
        rawInput: {},
        sessionConfig: createSessionConfig(),
        requestedBy: "principal",
        requestingRunId: "run-principal-1",
        handler: async () => "unreachable"
      })
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: "Tool is not fast-path eligible; route to ToolHotPathFull"
    });

    expect(harness.appendedEntries).toEqual([]);
    expect(harness.insertedRecords).toEqual([]);
    expect(harness.broadcastEntries).toEqual([]);
  });

  it("rejects out-of-scope absolute paths before emitting events", async () => {
    const harness = createHarness();

    await expect(
      harness.fastPath.execute({
        toolSpec: createToolSpec({ scope_guard: "workspace" }),
        rawInput: { targetPath: "/outside/workspace.txt" },
        sessionConfig: createSessionConfig(),
        requestedBy: "principal",
        requestingRunId: "run-principal-1",
        handler: async () => "unreachable"
      })
    ).rejects.toMatchObject({
      code: "VALIDATION"
    });

    expect(harness.appendedEntries).toEqual([]);
    expect(harness.insertedRecords).toEqual([]);
    expect(harness.broadcastEntries).toEqual([]);
  });

  it("rejects relative path traversal outside the workspace before emitting events", async () => {
    const harness = createHarness();

    await expect(
      harness.fastPath.execute({
        toolSpec: createToolSpec({ scope_guard: "workspace" }),
        rawInput: { targetPath: "../outside/workspace.txt" },
        sessionConfig: createSessionConfig(),
        requestedBy: "principal",
        requestingRunId: "run-principal-1",
        handler: async () => "unreachable"
      })
    ).rejects.toMatchObject({
      code: "VALIDATION"
    });

    expect(harness.appendedEntries).toEqual([]);
    expect(harness.insertedRecords).toEqual([]);
    expect(harness.broadcastEntries).toEqual([]);
  });

  it("rejects relative workspace path inputs that resolve outside writable roots before emitting events", async () => {
    const harness = createHarness();

    await expect(
      harness.fastPath.execute({
        toolSpec: createToolSpec({ scope_guard: "workspace" }),
        rawInput: { targetPath: "notes.txt" },
        sessionConfig: createSessionConfig(),
        requestedBy: "principal",
        requestingRunId: "run-principal-1",
        handler: async () => "unreachable"
      })
    ).rejects.toMatchObject({
      code: "VALIDATION"
    });

    expect(harness.appendedEntries).toEqual([]);
    expect(harness.insertedRecords).toEqual([]);
    expect(harness.broadcastEntries).toEqual([]);
  });

  it("checks baseDir candidates before emitting workspace-scoped fast-path events", async () => {
    const harness = createHarness();

    await expect(
      harness.fastPath.execute({
        toolSpec: createToolSpec({ tool_id: "tools.search_files", scope_guard: "workspace" }),
        rawInput: { baseDir: ".", pattern: "**/*.ts" },
        sessionConfig: createSessionConfig(),
        requestedBy: "principal",
        requestingRunId: "run-principal-1",
        handler: async () => "unreachable"
      })
    ).rejects.toMatchObject({
      code: "VALIDATION"
    });

    expect(harness.appendedEntries).toEqual([]);
    expect(harness.insertedRecords).toEqual([]);
    expect(harness.broadcastEntries).toEqual([]);
  });

  it("treats project scope as cwd-only even when workspace writable roots are broader", async () => {
    const harness = createHarness();
    const sessionConfig = createSessionConfig({
      writable_roots: ["/workspace/project", "/workspace/shared"]
    });

    await expect(
      harness.fastPath.execute({
        toolSpec: createToolSpec({ scope_guard: "project" }),
        rawInput: { targetPath: "/workspace/shared/notes.md" },
        sessionConfig,
        requestedBy: "principal",
        requestingRunId: "run-principal-1",
        handler: async () => "unreachable"
      })
    ).rejects.toMatchObject({
      code: "VALIDATION"
    });

    await expect(
      harness.fastPath.execute({
        toolSpec: createToolSpec({ scope_guard: "workspace" }),
        rawInput: { targetPath: "/workspace/shared/notes.md" },
        sessionConfig,
        requestedBy: "principal",
        requestingRunId: "run-principal-1",
        handler: async () => "ok"
      })
    ).resolves.toMatchObject({
      result: "ok"
    });
  });
});

function createHarness(options: {
  readonly insertImpl?: TestMock;
} = {}): {
  readonly fastPath: ToolFastPath;
  readonly appendedEntries: EventLogEntry[];
  readonly broadcastEntries: EventLogEntry[];
  readonly insertedRecords: ToolExecutionRecord[];
  readonly operations: string[];
} {
  const operations: string[] = [];
  const appendedEntries: EventLogEntry[] = [];
  const broadcastEntries: EventLogEntry[] = [];
  const insertedRecords: ToolExecutionRecord[] = [];
  let eventSequence = 0;

  const fastPath = new ToolFastPath({
    substrate: new ToolSubstrate({
      generateExecutionId: () => "exec-001",
      now: () => "2026-04-12T10:00:00.000Z"
    }),
    executionRecordRepo: {
      insert:
        options.insertImpl ??
        vi.fn(async (record: ToolExecutionRecord) => {
          operations.push(`insert:${record.execution_id}:${String(record.executed)}`);
          insertedRecords.push(record);
          return record;
        })
    },
    eventLogRepo: {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
        operations.push(`append:${entry.event_type}`);
        const createdAt =
          eventSequence === 0 ? "2026-04-12T10:00:00.100Z" : "2026-04-12T10:00:01.000Z";
        const appended = {
          ...entry,
          event_id: `event-${eventSequence + 1}`,
          created_at: createdAt
        } satisfies EventLogEntry;
        appendedEntries.push(appended);
        eventSequence += 1;
        return appended;
      })
    },
    sseBroadcaster: {
      broadcastEntry: vi.fn(async (entry: EventLogEntry) => {
        operations.push(`broadcast:${entry.event_type}`);
        broadcastEntries.push(entry);
      })
    },
    now: () => "2026-04-12T10:00:01.000Z"
  });

  return {
    fastPath,
    appendedEntries,
    broadcastEntries,
    insertedRecords,
    operations
  };
}

function createToolSpec(overrides: Partial<ToolSpec> = {}): ToolSpec {
  return {
    tool_id: overrides.tool_id ?? "tools.read_file",
    category: overrides.category ?? "read",
    description: overrides.description ?? "Read a file from the workspace.",
    scope_guard: overrides.scope_guard ?? "workspace",
    read_only: overrides.read_only ?? true,
    destructive: overrides.destructive ?? false,
    concurrency_safe: overrides.concurrency_safe ?? true,
    interrupt_behavior: overrides.interrupt_behavior ?? "continue",
    requires_confirmation: overrides.requires_confirmation ?? false,
    requires_evidence_reopen: overrides.requires_evidence_reopen ?? false,
    rollback_support: overrides.rollback_support ?? "none",
    fast_path_eligible: overrides.fast_path_eligible ?? true
  };
}

function createSessionConfig(
  overrides: Partial<WorkerRuntimeSessionConfig> = {}
): WorkerRuntimeSessionConfig {
  return {
    role: "worker",
    workspace_id: "ws-fast-path",
    run_id: "principal-run-1",
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
