import type { EventLogEntry, ToolExecutionRecord, ToolSpec } from "@do-what/protocol";
import { PhaseA1EventType, RuntimeSessionConfigSchema } from "@do-what/protocol";
import { describe, expect, it, vi } from "vitest";
import {
  CURRENT_TOOL_EVENT_REVISION,
  calculateDurationMs,
  buildToolExecutionRecord,
  createToolCallEventEntry,
  emitCompletedToolExecution,
  resolveAffectedPaths,
  rethrowWithSuppressedError,
  summarizeForEvent
} from "../tool-hot-path/shared-execution.js";

describe("tool hot-path shared execution helpers", () => {
  it("caps serialized summaries at 200 characters", () => {
    const longText = "x".repeat(260);

    expect(summarizeForEvent(longText, "fallback")).toHaveLength(200);
    expect(summarizeForEvent({ value: longText }, "fallback")).toHaveLength(200);
  });

  it("falls back to stable object summaries when values are not serializable", () => {
    const circular: { self?: unknown } = {};
    circular.self = circular;

    expect(summarizeForEvent(circular, "tool output")).toBe("tool output: Object");
  });

  it("returns 0 when endedAt is before startedAt", () => {
    expect(calculateDurationMs("2026-04-12T10:00:02.000Z", "2026-04-12T10:00:01.000Z")).toBe(0);
  });

  it("keeps the current tool event revision centralized", () => {
    expect(CURRENT_TOOL_EVENT_REVISION).toBe(0);
  });

  it("builds centralized tool-call event entries with the current revision", () => {
    const entry = createToolCallEventEntry(
      PhaseA1EventType.TOOL_CALL_STARTED,
      createContext(),
      "exec-001",
      "worker",
      "run-1",
      {
        toolCallId: "exec-001",
        workerId: "run-1",
        toolId: "tools.read_file",
        inputSummary: "read README.md"
      }
    );

    expect(entry).toEqual({
      event_type: PhaseA1EventType.TOOL_CALL_STARTED,
      entity_type: "tool_execution",
      entity_id: "exec-001",
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "worker",
      revision: CURRENT_TOOL_EVENT_REVISION,
      payload_json: {
        toolCallId: "exec-001",
        workerId: "run-1",
        toolId: "tools.read_file",
        inputSummary: "read README.md"
      }
    });
  });

  it("builds frozen execution records that match the protocol schema", () => {
    const record = buildToolExecutionRecord({
      executionId: "exec-001",
      toolSpec: createToolSpec(),
      requestedBy: "worker",
      requestingRunId: "run-1",
      governanceDecisionRef: "gov-001",
      permissionResult: "allow",
      executed: true,
      startedAt: "2026-04-12T10:00:00.000Z",
      endedAt: "2026-04-12T10:00:01.000Z",
      resultSummary: "ok"
    });

    expect(record).toMatchObject({
      execution_id: "exec-001",
      tool_id: "tools.read_file",
      requested_by: "worker",
      requesting_run_id: "run-1",
      governance_decision_ref: "gov-001",
      permission_result: "allow",
      executed: true,
      result_summary: "ok",
      rollback_status: "none"
    });
    expect(Object.isFrozen(record)).toBe(true);
  });

  it("emits completed executions with the centralized event type and append-insert-broadcast ordering", async () => {
    const operations: string[] = [];
    const appendedEntries: EventLogEntry[] = [];
    const insertedRecords: ToolExecutionRecord[] = [];

    const result = await emitCompletedToolExecution({
      eventLogRepo: {
        append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
          operations.push(`append:${entry.event_type}`);
          const appended = {
            ...entry,
            event_id: "event-1",
            created_at: "2026-04-12T10:00:01.000Z"
          } satisfies EventLogEntry;
          appendedEntries.push(appended);
          return appended;
        })
      },
      executionRecordRepo: {
        insert: vi.fn(async (record: ToolExecutionRecord) => {
          operations.push(`insert:${record.execution_id}:${record.permission_result}`);
          insertedRecords.push(record);
          return record;
        })
      },
      sseBroadcaster: {
        broadcastEntry: vi.fn(async (entry: EventLogEntry) => {
          operations.push(`broadcast:${entry.event_type}`);
        })
      },
      context: createContext(),
      executionId: "exec-001",
      requestedBy: "worker",
      requestingRunId: "run-1",
      toolSpec: createToolSpec(),
      governanceDecisionRef: "gov-001",
      permissionResult: "allow",
      endedAt: "2026-04-12T10:00:01.000Z",
      statusKind: "success",
      outcome: { ok: true }
    });

    expect(operations).toEqual([
      `append:${PhaseA1EventType.TOOL_CALL_COMPLETED}`,
      "insert:exec-001:allow",
      `broadcast:${PhaseA1EventType.TOOL_CALL_COMPLETED}`
    ]);
    expect(appendedEntries[0]?.event_type).toBe(PhaseA1EventType.TOOL_CALL_COMPLETED);
    expect(appendedEntries[0]?.revision).toBe(CURRENT_TOOL_EVENT_REVISION);
    expect(insertedRecords[0]?.result_summary).toContain("ok");
    expect(result.completedEntry).toBe(appendedEntries[0]);
    expect(result.executionRecord).toBe(insertedRecords[0]);
  });

  it("resolves workspace-relative affected_paths for builtin and external filesystem write successes", () => {
    expect(
      resolveAffectedPaths({
        context: createContext(),
        toolSpec: createToolSpec({
          tool_id: "tools.write_file",
          category: "write",
          read_only: false,
          fast_path_eligible: false
        }),
        rawInput: { path: "/workspace/project/src/index.ts", content: "export {};\n" },
        outcome: { ok: true, bytesWritten: 10 }
      })
    ).toEqual(["src/index.ts"]);

    expect(
      resolveAffectedPaths({
        context: createContext(),
        toolSpec: createToolSpec({
          tool_id: "mcp__filesystem__write_file",
          category: "write",
          description: "Write a file through filesystem MCP.",
          read_only: false,
          fast_path_eligible: false
        }),
        rawInput: { path: "/workspace/project/docs/notes.md", content: "hello\n" },
        outcome: {
          content: [{ type: "text", text: "ok" }]
        }
      })
    ).toEqual(["docs/notes.md"]);
  });

  it("normalizes affected_paths against affectedPathRoots when repo binding narrows the path space", () => {
    expect(
      resolveAffectedPaths({
        context: createContext({
          writableRoots: ["/workspace/root"],
          affectedPathRoots: ["/workspace/root/repo"]
        }),
        toolSpec: createToolSpec({
          tool_id: "tools.write_file",
          category: "write",
          read_only: false,
          fast_path_eligible: false
        }),
        rawInput: {
          path: "/workspace/root/repo/src/index.ts",
          content: "export {};\n"
        },
        outcome: { ok: true, bytesWritten: 10 }
      })
    ).toEqual(["src/index.ts"]);
  });

  it("leaves affected_paths undefined for filesystem MCP failures and non-write tool ids", () => {
    expect(
      resolveAffectedPaths({
        context: createContext(),
        toolSpec: createToolSpec({
          tool_id: "mcp__filesystem__write_file",
          category: "write",
          description: "Write a file through filesystem MCP.",
          read_only: false,
          fast_path_eligible: false
        }),
        rawInput: { path: "/workspace/project/docs/notes.md", content: "hello\n" },
        outcome: {
          ok: false,
          code: "MCP_TOOL_ERROR",
          message: "permission denied"
        }
      })
    ).toBeUndefined();

    expect(
      resolveAffectedPaths({
        context: createContext(),
        toolSpec: createToolSpec({
          tool_id: "mcp__filesystem__read_file",
          description: "Read a file through filesystem MCP.",
          fast_path_eligible: false
        }),
        rawInput: { path: "/workspace/project/docs/notes.md" },
        outcome: {
          content: [{ type: "text", text: "hello" }]
        }
      })
    ).toBeUndefined();
  });

  it("wraps primary and secondary failures without mutating the original error", () => {
    const primaryError = new Error("handler exploded");
    const secondaryError = new Error("record insert failed");

    expect(() => {
      rethrowWithSuppressedError(primaryError, secondaryError);
    }).toThrowError(
      expect.objectContaining({
        message: "handler exploded",
        cause: primaryError,
        secondaryError
      })
    );

    expect(primaryError.cause).toBeUndefined();
    expect("secondaryError" in primaryError).toBe(false);
  });
});

function createContext(
  overrides: Partial<{
    writableRoots: readonly string[];
    affectedPathRoots: readonly string[];
    cwd: string;
  }> = {}
) {
  const writableRoots = overrides.writableRoots ?? ["/workspace/project"];
  const cwd = overrides.cwd ?? writableRoots[0] ?? "/workspace/project";

  return {
    executionId: "exec-001",
    toolId: "tools.read_file",
    workspaceId: "workspace-1",
    writableRoots,
    affectedPathRoots: overrides.affectedPathRoots ?? writableRoots,
    cwd,
    sessionConfig: RuntimeSessionConfigSchema.parse({
      role: "worker" as const,
      workspace_id: "workspace-1",
      run_id: "run-1",
      cwd,
      writable_roots: [...writableRoots],
      tool_profile: "conversation_engine",
      allowed_mcp_servers: [],
      sandbox_policy: "workspace_write" as const,
      permission_policy: "ask" as const,
      network_policy: "restricted" as const
    }),
    startedAt: "2026-04-12T10:00:00.000Z"
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
