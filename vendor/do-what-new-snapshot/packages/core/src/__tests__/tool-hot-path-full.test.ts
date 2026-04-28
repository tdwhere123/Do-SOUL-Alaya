import type {
  EventLogEntry,
  WorkerRuntimeSessionConfig,
  ToolExecutionRecord,
  ToolGovernanceDecision,
  ToolGovernanceQuery,
  ToolSpec
} from "@do-what/protocol";
import { canonicalGovernanceSubject } from "@do-what/protocol";
import { describe, expect, it, vi } from "vitest";
import { ToolHotPathFull } from "../tool-hot-path/hot-path-full.js";
import { ToolSubstrate } from "../tool-substrate/index.js";
import type { TestMock } from "./mock-types.js";

describe("ToolHotPathFull", () => {
  it("executes an allow path without confirmation and emits approved plus tool call events", async () => {
    const harness = createHarness();

    const result = await harness.hotPath.execute({
      toolSpec: createToolSpec(),
      rawInput: { path: "README.md" },
      governanceQueryBuilder: createGovernanceQueryBuilder(),
      sessionConfig: createSessionConfig(),
      requestedBy: "principal",
      requestingRunId: "run-principal-1",
      stancePolicy: createStancePolicy(),
      stanceResolution: createStanceResolution(),
      deniedToolCategories: [],
      handler: async (context, input) => {
        harness.operations.push(`handler:${context.executionId}:${JSON.stringify(input)}`);
        return { ok: true };
      }
    });

    expect(result.result).toEqual({ ok: true });
    expect(result.permissionResult).toBe("allow");
    expect(result.executionRecord).toEqual(harness.insertedRecords[0]);
    expect(harness.approvalSink.requestApproval).not.toHaveBeenCalled();
    expect(harness.operations).toEqual([
      "governance:exec-001",
      "targetRevalidate",
      "targetRevalidate",
      "append:tool.intent.approved",
      "broadcast:tool.intent.approved",
      "append:tool_call.started",
      "broadcast:tool_call.started",
      'handler:exec-001:{"path":"README.md"}',
      "append:tool_call.completed",
      "insert:exec-001:true:allow",
      "broadcast:tool_call.completed"
    ]);
    expect(harness.appendedEntries.map((entry) => entry.event_type)).toEqual([
      "tool.intent.approved",
      "tool_call.started",
      "tool_call.completed"
    ]);
  });

  it("emits created then approved on an ask path when approval is granted", async () => {
    const harness = createHarness({
      governanceDecision: createGovernanceDecision({ final_result: "ask" })
    });

    const result = await harness.hotPath.execute({
      toolSpec: createToolSpec({ requires_confirmation: true, read_only: false, fast_path_eligible: false }),
      rawInput: { path: "README.md" },
      governanceQueryBuilder: createGovernanceQueryBuilder(),
      sessionConfig: createSessionConfig(),
      requestedBy: "principal",
      requestingRunId: "run-principal-1",
      stancePolicy: createStancePolicy(),
      stanceResolution: createStanceResolution(),
      deniedToolCategories: [],
      handler: async () => "approved-result"
    });

    expect(result.result).toBe("approved-result");
    expect(result.permissionResult).toBe("ask");
    expect(harness.approvalSink.requestApproval).toHaveBeenCalledTimes(1);
    expect(harness.appendedEntries.map((entry) => entry.event_type)).toEqual([
      "tool.intent.created",
      "tool.intent.approved",
      "tool_call.started",
      "tool_call.completed"
    ]);
  });

  it("emits created then denied on an ask path when approval is rejected and does not run the handler", async () => {
    const harness = createHarness({
      governanceDecision: createGovernanceDecision({ final_result: "ask" }),
      approvalResult: "denied"
    });
    const handler = vi.fn(async () => "should-not-run");

    const result = await harness.hotPath.execute({
      toolSpec: createToolSpec({ requires_confirmation: true, read_only: false, fast_path_eligible: false }),
      rawInput: { path: "README.md" },
      governanceQueryBuilder: createGovernanceQueryBuilder(),
      sessionConfig: createSessionConfig(),
      requestedBy: "principal",
      requestingRunId: "run-principal-1",
      stancePolicy: createStancePolicy(),
      stanceResolution: createStanceResolution(),
      deniedToolCategories: [],
      handler
    });

    expect(result.result).toBeNull();
    expect(result.permissionResult).toBe("deny");
    expect(result.executionRecord.executed).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(harness.appendedEntries.map((entry) => entry.event_type)).toEqual([
      "tool.intent.created",
      "tool.intent.denied"
    ]);
  });

  it("emits denied and returns without executing when policy resolution denies the tool", async () => {
    const harness = createHarness({
      governanceDecision: createGovernanceDecision({ final_result: "deny" })
    });
    const handler = vi.fn(async () => "should-not-run");

    const result = await harness.hotPath.execute({
      toolSpec: createToolSpec({ destructive: true, read_only: false, fast_path_eligible: false }),
      rawInput: { command: "rm -rf ." },
      governanceQueryBuilder: createGovernanceQueryBuilder(),
      sessionConfig: createSessionConfig(),
      requestedBy: "principal",
      requestingRunId: "run-principal-1",
      stancePolicy: createStancePolicy(),
      stanceResolution: createStanceResolution(),
      deniedToolCategories: [],
      handler
    });

    expect(result.result).toBeNull();
    expect(result.permissionResult).toBe("deny");
    expect(result.executionRecord.executed).toBe(false);
    expect(handler).not.toHaveBeenCalled();
    expect(harness.appendedEntries.map((entry) => entry.event_type)).toEqual(["tool.intent.denied"]);
    expect(harness.outcomeRecorder.recordOutcome).toHaveBeenCalledWith(
      "run-principal-1",
      "ws-hot-path",
      "exec-001",
      "tooling.policy::execution=exec-001",
      "deny"
    );
  });

  it("delegates fast-path-eligible read-only tools to ToolFastPath and skips governance plus approval", async () => {
    const fastPathResult = {
      result: { ok: true },
      executionRecord: createExecutionRecord({
        execution_id: "fast-exec-1",
        governance_decision_ref: "fast-path://skipped",
        permission_result: "allow",
        executed: true
      })
    };
    const harness = createHarness({
      fastPathImpl: vi.fn(async () => fastPathResult)
    });

    const result = await harness.hotPath.execute({
      toolSpec: createToolSpec({
        tool_id: "tools.read_file",
        category: "read",
        description: "Read a file from the workspace.",
        read_only: true,
        fast_path_eligible: true,
        scope_guard: "workspace"
      }),
      rawInput: { path: "/workspace/project/README.md" },
      governanceQueryBuilder: createGovernanceQueryBuilder(),
      sessionConfig: createSessionConfig(),
      requestedBy: "principal",
      requestingRunId: "run-principal-1",
      stancePolicy: createStancePolicy(),
      stanceResolution: createStanceResolution(),
      deniedToolCategories: [],
      handler: async () => "unreachable"
    });

    expect(result).toEqual({
      result: { ok: true },
      executionRecord: fastPathResult.executionRecord,
      permissionResult: "allow"
    });
    expect(harness.fastPathExecute).toHaveBeenCalledTimes(1);
    expect(harness.fastPathExecute).toHaveBeenCalledWith({
      toolSpec: expect.objectContaining({
        tool_id: "tools.read_file",
        read_only: true,
        fast_path_eligible: true
      }),
      rawInput: { path: "/workspace/project/README.md" },
      sessionConfig: createSessionConfig(),
      requestedBy: "principal",
      requestingRunId: "run-principal-1",
      handler: expect.any(Function)
    });
    expect(harness.governanceQuerySpy).not.toHaveBeenCalled();
    expect(harness.approvalSink.requestApproval).not.toHaveBeenCalled();
  });

  it("does not delegate to fast-path when a read-only spec still requires confirmation", async () => {
    const harness = createHarness({
      governanceDecision: createGovernanceDecision({ final_result: "allow" })
    });

    const result = await harness.hotPath.execute({
      toolSpec: createToolSpec({
        tool_id: "tools.read_file",
        category: "read",
        description: "Read a file from the workspace.",
        scope_guard: "workspace",
        read_only: true,
        fast_path_eligible: true,
        requires_confirmation: true
      }),
      rawInput: { path: "/workspace/project/README.md" },
      governanceQueryBuilder: createGovernanceQueryBuilder(),
      sessionConfig: createSessionConfig(),
      requestedBy: "principal",
      requestingRunId: "run-principal-1",
      stancePolicy: createStancePolicy(),
      stanceResolution: createStanceResolution(),
      deniedToolCategories: [],
      handler: async () => "approved-after-confirmation"
    });

    expect(result.result).toBe("approved-after-confirmation");
    expect(result.permissionResult).toBe("ask");
    expect(harness.fastPathExecute).not.toHaveBeenCalled();
    expect(harness.approvalSink.requestApproval).toHaveBeenCalledTimes(1);
    expect(harness.appendedEntries.map((entry) => entry.event_type)).toEqual([
      "tool.intent.created",
      "tool.intent.approved",
      "tool_call.started",
      "tool_call.completed"
    ]);
  });

  it("records workspace-relative affected_paths for successful tools.write_file executions only", async () => {
    const harness = createHarness();

    const result = await harness.hotPath.execute({
      toolSpec: createToolSpec({
        tool_id: "tools.write_file",
        category: "write",
        scope_guard: "workspace"
      }),
      rawInput: { path: "/workspace/project/src/index.ts", content: "export {};\n" },
      governanceQueryBuilder: createGovernanceQueryBuilder(),
      sessionConfig: createSessionConfig(),
      requestedBy: "principal",
      requestingRunId: "run-principal-1",
      stancePolicy: createStancePolicy(),
      stanceResolution: createStanceResolution(),
      deniedToolCategories: [],
      handler: async () => ({ ok: true, bytesWritten: 10 })
    });

    expect(result.executionRecord.affected_paths).toEqual(["src/index.ts"]);
    expect(harness.insertedRecords[0]?.affected_paths).toEqual(["src/index.ts"]);
    expect(harness.appendedEntries[2]?.payload_json).toMatchObject({
      toolCallId: "exec-001",
      statusKind: "success",
      affected_paths: ["src/index.ts"]
    });
  });

  it("leaves affected_paths undefined for non-success write-file results and non-file tools", async () => {
    const writeHarness = createHarness();

    const writeResult = await writeHarness.hotPath.execute({
      toolSpec: createToolSpec({
        tool_id: "tools.write_file",
        category: "write",
        scope_guard: "workspace"
      }),
      rawInput: { path: "/workspace/project/src/index.ts", content: "export {};\n" },
      governanceQueryBuilder: createGovernanceQueryBuilder(),
      sessionConfig: createSessionConfig(),
      requestedBy: "principal",
      requestingRunId: "run-principal-1",
      stancePolicy: createStancePolicy(),
      stanceResolution: createStanceResolution(),
      deniedToolCategories: [],
      handler: async () => ({ ok: false, code: "WRITE_ERROR", message: "disk full" })
    });

    expect(writeResult.executionRecord.affected_paths).toBeUndefined();
    expect(writeHarness.appendedEntries[2]?.payload_json).not.toHaveProperty("affected_paths");

    const execHarness = createHarness();
    const execResult = await execHarness.hotPath.execute({
      toolSpec: createToolSpec({
        tool_id: "tools.exec_shell",
        category: "exec",
        scope_guard: "project",
        destructive: true,
        requires_confirmation: true
      }),
      rawInput: { command: "git", args: ["status"] },
      governanceQueryBuilder: createGovernanceQueryBuilder(),
      sessionConfig: createSessionConfig(),
      requestedBy: "principal",
      requestingRunId: "run-principal-1",
      stancePolicy: createStancePolicy(),
      stanceResolution: createStanceResolution(),
      deniedToolCategories: [],
      handler: async () => ({ ok: true, exitCode: 0, stdout: "", stderr: "" })
    });

    expect(execResult.executionRecord.affected_paths).toBeUndefined();
    expect(execHarness.appendedEntries[3]?.payload_json).not.toHaveProperty("affected_paths");
  });

  it("does not delegate to fast-path when a spec declares destructive even if read_only and fast_path_eligible", async () => {
    const harness = createHarness({
      governanceDecision: createGovernanceDecision({ final_result: "allow" })
    });

    const result = await harness.hotPath.execute({
      toolSpec: createToolSpec({
        tool_id: "tools.read_file",
        category: "read",
        description: "Read a file from the workspace.",
        scope_guard: "workspace",
        read_only: true,
        fast_path_eligible: true,
        destructive: true
      }),
      rawInput: { path: "/workspace/project/README.md" },
      governanceQueryBuilder: createGovernanceQueryBuilder(),
      sessionConfig: createSessionConfig(),
      requestedBy: "principal",
      requestingRunId: "run-principal-1",
      stancePolicy: createStancePolicy(),
      stanceResolution: createStanceResolution(),
      deniedToolCategories: [],
      handler: async () => "ran-via-full-path"
    });

    expect(result.result).toBe("ran-via-full-path");
    expect(harness.fastPathExecute).not.toHaveBeenCalled();
    expect(harness.governanceQuerySpy).toHaveBeenCalledTimes(1);
  });

  it("enforces scope_guard before executing non-fast-path handlers", async () => {
    const harness = createHarness();

    await expect(
      harness.hotPath.execute({
        toolSpec: createToolSpec({ scope_guard: "project" }),
        rawInput: { path: "../escape.txt" },
        governanceQueryBuilder: createGovernanceQueryBuilder(),
        sessionConfig: createSessionConfig(),
        requestedBy: "principal",
        requestingRunId: "run-principal-1",
        stancePolicy: createStancePolicy(),
        stanceResolution: createStanceResolution(),
        deniedToolCategories: [],
        handler: async () => "should-not-run"
      })
    ).rejects.toMatchObject({
      message: "Tool input path violates scope_guard project"
    });

    expect(harness.appendedEntries.map((entry) => entry.event_type)).toEqual(["tool.intent.approved"]);
  });

  it("rejects undefined rawInput before fast-path delegation or governance work", async () => {
    const harness = createHarness();

    await expect(
      harness.hotPath.execute({
        toolSpec: createToolSpec({
          tool_id: "tools.read_file",
          category: "read",
          scope_guard: "workspace",
          read_only: true,
          fast_path_eligible: true
        }),
        rawInput: undefined,
        governanceQueryBuilder: createGovernanceQueryBuilder(),
        sessionConfig: createSessionConfig(),
        requestedBy: "principal",
        requestingRunId: "run-principal-1",
        stancePolicy: createStancePolicy(),
        stanceResolution: createStanceResolution(),
        deniedToolCategories: [],
        handler: async () => "unreachable"
      })
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: "rawInput is required"
    });

    expect(harness.fastPathExecute).not.toHaveBeenCalled();
    expect(harness.governanceQuerySpy).not.toHaveBeenCalled();
    expect(harness.appendedEntries).toEqual([]);
    expect(harness.insertedRecords).toEqual([]);
  });

  it("rejects destructive tools in read_only sandboxes before tool execution starts", async () => {
    const harness = createHarness();
    const handler = vi.fn(async () => "should-not-run");

    await expect(
      harness.hotPath.execute({
        toolSpec: createToolSpec({ destructive: true }),
        rawInput: { path: "README.md" },
        governanceQueryBuilder: createGovernanceQueryBuilder(),
        sessionConfig: createSessionConfig({ sandbox_policy: "read_only" }),
        requestedBy: "principal",
        requestingRunId: "run-principal-1",
        stancePolicy: createStancePolicy(),
        stanceResolution: createStanceResolution(),
        deniedToolCategories: [],
        handler
      })
    ).rejects.toMatchObject({
      code: "VALIDATION",
      message: "Destructive tools are not allowed in read_only sandboxes."
    });

    expect(handler).not.toHaveBeenCalled();
    expect(harness.appendedEntries.map((entry) => entry.event_type)).toEqual(["tool.intent.approved"]);
    expect(harness.insertedRecords).toEqual([]);
  });

  it("emits tool_call.completed with error status, stores the final record, and rethrows handler failures", async () => {
    const harness = createHarness();
    const handlerError = new Error("handler exploded");

    await expect(
      harness.hotPath.execute({
        toolSpec: createToolSpec(),
        rawInput: { path: "README.md" },
        governanceQueryBuilder: createGovernanceQueryBuilder(),
        sessionConfig: createSessionConfig(),
        requestedBy: "principal",
        requestingRunId: "run-principal-1",
        stancePolicy: createStancePolicy(),
        stanceResolution: createStanceResolution(),
        deniedToolCategories: [],
        handler: async () => {
          throw handlerError;
        }
      })
    ).rejects.toBe(handlerError);

    expect(harness.operations).toEqual([
      "governance:exec-001",
      "targetRevalidate",
      "targetRevalidate",
      "append:tool.intent.approved",
      "broadcast:tool.intent.approved",
      "append:tool_call.started",
      "broadcast:tool_call.started",
      "append:tool_call.completed",
      "insert:exec-001:true:allow",
      "broadcast:tool_call.completed"
    ]);
    expect(harness.insertedRecords).toHaveLength(1);
    expect(harness.insertedRecords[0]).toMatchObject({
      execution_id: "exec-001",
      executed: true,
      permission_result: "allow"
    });
    expect(harness.appendedEntries[2]?.payload_json).toMatchObject({
      toolCallId: "exec-001",
      statusKind: "error",
      outputSummary: "handler exploded"
    });
  });

  it("wraps the original handler failure when completed-event persistence fails", async () => {
    const handlerError = new Error("handler exploded");
    const persistenceError = new Error("record insert failed");
    const harness = createHarness({
      insertImpl: vi.fn(async () => {
        throw persistenceError;
      })
    });

    await expect(
      harness.hotPath.execute({
        toolSpec: createToolSpec(),
        rawInput: { path: "README.md" },
        governanceQueryBuilder: createGovernanceQueryBuilder(),
        sessionConfig: createSessionConfig(),
        requestedBy: "principal",
        requestingRunId: "run-principal-1",
        stancePolicy: createStancePolicy(),
        stanceResolution: createStanceResolution(),
        deniedToolCategories: [],
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
      "governance:exec-001",
      "targetRevalidate",
      "targetRevalidate",
      "append:tool.intent.approved",
      "broadcast:tool.intent.approved",
      "append:tool_call.started",
      "broadcast:tool_call.started",
      "append:tool_call.completed"
    ]);
  });

  it("logs stale targetRevalidate results after governance query and continues execution", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const harness = createHarness({
      targetRevalidateImpl: vi.fn(async () => [
        {
          ref_id: "strong-ref-1",
          status: "stale",
          stale_since: "2026-04-12T09:30:00.000Z",
          revalidated_at: "2026-04-12T10:00:00.500Z"
        }
      ])
    });

    const result = await harness.hotPath.execute({
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

    expect(result.permissionResult).toBe("allow");
    expect(harness.operations.slice(0, 3)).toEqual(["governance:exec-001", "targetRevalidate", "targetRevalidate"]);
    expect(warnSpy).toHaveBeenCalledWith(
      "targetRevalidate detected stale or missing governance refs; continuing execution",
      expect.objectContaining({
        toolId: "tools.write_file"
      })
    );

    warnSpy.mockRestore();
  });

  it("releases governance_lease strong refs even when handler execution throws", async () => {
    const harness = createHarness();

    await expect(
      harness.hotPath.execute({
        toolSpec: createToolSpec(),
        rawInput: { path: "README.md" },
        governanceQueryBuilder: createGovernanceQueryBuilder(),
        sessionConfig: createSessionConfig(),
        requestedBy: "principal",
        requestingRunId: "run-principal-1",
        stancePolicy: createStancePolicy(),
        stanceResolution: createStanceResolution(),
        deniedToolCategories: [],
        handler: async () => {
          throw new Error("handler exploded");
        }
      })
    ).rejects.toThrow("handler exploded");

    expect(harness.strongRefProtect).toHaveBeenCalledTimes(2);
    expect(harness.strongRefReleaseBySource).toHaveBeenCalledWith({
      sourceEntityType: "tool_execution",
      sourceEntityId: "exec-001"
    });
  });

  it("protects matched governance refs before handler and releases after completion", async () => {
    const harness = createHarness();

    await harness.hotPath.execute({
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

    expect(harness.operations.slice(0, 3)).toEqual(["governance:exec-001", "targetRevalidate", "targetRevalidate"]);
    expect(harness.targetRevalidateFind).toHaveBeenCalledWith("ws-hot-path", "claim", ["claim-1"]);
    expect(harness.targetRevalidateFind).toHaveBeenCalledWith("ws-hot-path", "slot", ["slot-1"]);
    expect(harness.strongRefProtect).toHaveBeenCalledTimes(2);
    expect(harness.strongRefProtect).toHaveBeenCalledWith({
      sourceEntityType: "tool_execution",
      sourceEntityId: "exec-001",
      targetEntityType: "claim",
      targetEntityId: "claim-1",
      workspaceId: "ws-hot-path",
      reason: "governance_lease"
    });
    expect(harness.strongRefProtect).toHaveBeenCalledWith({
      sourceEntityType: "tool_execution",
      sourceEntityId: "exec-001",
      targetEntityType: "slot",
      targetEntityId: "slot-1",
      workspaceId: "ws-hot-path",
      reason: "governance_lease"
    });
    expect(harness.strongRefReleaseBySource).toHaveBeenCalledWith({
      sourceEntityType: "tool_execution",
      sourceEntityId: "exec-001"
    });
  });

  it("skips governance_lease protection when strongRefService is not wired", async () => {
    const harness = createHarness({ disableStrongRefService: true });

    await harness.hotPath.execute({
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

    expect(harness.strongRefProtect).not.toHaveBeenCalled();
    expect(harness.strongRefReleaseBySource).not.toHaveBeenCalled();
  });
});

function createHarness(options: {
  readonly approvalResult?: "approved" | "denied";
  readonly governanceDecision?: ToolGovernanceDecision;
  readonly fastPathImpl?: TestMock;
  readonly insertImpl?: TestMock;
  readonly targetRevalidateImpl?: TestMock;
  readonly strongRefProtectImpl?: TestMock;
  readonly strongRefReleaseImpl?: TestMock;
  readonly disableStrongRefService?: boolean;
} = {}) {
  const operations: string[] = [];
  const appendedEntries: EventLogEntry[] = [];
  const insertedRecords: ToolExecutionRecord[] = [];
  let eventSequence = 0;

  const governanceQuerySpy = vi.fn(
    async (query: ToolGovernanceQuery) => {
      operations.push(`governance:${readExecutionId(query)}`);
      return options.governanceDecision ?? createGovernanceDecision();
    }
  );

  const fastPathExecute =
    options.fastPathImpl ??
    vi.fn(async () => ({
      result: { ok: true },
      executionRecord: createExecutionRecord({
        execution_id: "fast-exec-1",
        governance_decision_ref: "fast-path://skipped",
        permission_result: "allow",
        executed: true
      })
    }));
  const targetRevalidateImpl =
    options.targetRevalidateImpl ??
    vi.fn(async () => []);
  const strongRefProtect =
    options.strongRefProtectImpl ??
    vi.fn(async () => undefined);
  const strongRefReleaseBySource =
    options.strongRefReleaseImpl ??
    vi.fn(async () => undefined);
  const targetRevalidateFind = vi.fn(async (_workspaceId: string, _targetEntityType: string, targetEntityIds: readonly string[]) => {
    operations.push("targetRevalidate");
    return await targetRevalidateImpl(targetEntityIds);
  });

  const approvalSink = {
    requestApproval: vi.fn(async () => options.approvalResult ?? "approved")
  };
  const outcomeRecorder = {
    recordOutcome: vi.fn(async () => undefined)
  };

  const hotPath = new ToolHotPathFull({
    substrate: new ToolSubstrate({
      generateExecutionId: () => "exec-001",
      now: () => "2026-04-12T10:00:00.000Z"
    }),
    governanceClient: {
      query: governanceQuerySpy
    },
    targetRevalidateService: {
      findAndRevalidate: targetRevalidateFind
    },
    strongRefService: options.disableStrongRefService === true
      ? undefined
      : {
          protect: strongRefProtect,
          releaseBySource: strongRefReleaseBySource
        },
    fastPath: {
      execute: fastPathExecute
    },
    executionRecordRepo: {
      insert:
        options.insertImpl ??
        vi.fn(async (record: ToolExecutionRecord) => {
          operations.push(`insert:${record.execution_id}:${String(record.executed)}:${record.permission_result}`);
          insertedRecords.push(record);
          return record;
        })
    },
    eventLogRepo: {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
        operations.push(`append:${entry.event_type}`);
        const appended = {
          ...entry,
          event_id: `event-${eventSequence + 1}`,
          created_at:
            eventSequence === 0 ? "2026-04-12T10:00:00.100Z" : `2026-04-12T10:00:0${eventSequence + 1}.000Z`
        } satisfies EventLogEntry;
        eventSequence += 1;
        appendedEntries.push(appended);
        return appended;
      })
    },
    sseBroadcaster: {
      broadcastEntry: vi.fn(async (entry: EventLogEntry) => {
        operations.push(`broadcast:${entry.event_type}`);
      })
    },
    approvalSink,
    outcomeRecorder,
    now: () => "2026-04-12T10:00:01.000Z",
    generateExecutionId: () => "gov-001"
  });

  return {
    hotPath,
    operations,
    appendedEntries,
    insertedRecords,
    governanceQuerySpy,
    approvalSink,
    fastPathExecute,
    outcomeRecorder,
    strongRefProtect,
    strongRefReleaseBySource,
    targetRevalidateFind
  };
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

function createExecutionRecord(overrides: Partial<ToolExecutionRecord>): ToolExecutionRecord {
  return {
    execution_id: overrides.execution_id ?? "exec-001",
    tool_id: overrides.tool_id ?? "tools.write_file",
    requested_by: overrides.requested_by ?? "principal",
    requesting_run_id: overrides.requesting_run_id ?? "run-principal-1",
    governance_decision_ref: overrides.governance_decision_ref ?? "gov-001",
    permission_result: overrides.permission_result ?? "allow",
    executed: overrides.executed ?? true,
    started_at: overrides.started_at ?? "2026-04-12T10:00:00.000Z",
    ended_at: overrides.ended_at ?? "2026-04-12T10:00:01.000Z",
    result_summary: overrides.result_summary ?? "ok",
    rollback_status: overrides.rollback_status ?? "none",
    affected_paths: overrides.affected_paths
  };
}

function readExecutionId(query: ToolGovernanceQuery): string {
  return query.governance_subject.subject_qualifiers["execution"] ?? "missing";
}
