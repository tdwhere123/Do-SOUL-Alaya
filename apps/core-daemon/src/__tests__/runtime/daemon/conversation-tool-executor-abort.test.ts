import { describe, expect, it, vi } from "vitest";
import { createConversationToolExecutor } from "../../../runtime/daemon/support/conversation-tool-executor.js";
import { initDatabase, SqliteEventLogRepo, SqliteToolExecutionRecordRepo, SqliteToolSpecRepo } from "@do-soul/alaya-storage";
import { EventPublisher } from "@do-soul/alaya-core";
import { createRuntimeNotifier } from "../../../runtime/daemon/support/runtime-notifier.js";
import { getBuiltinConversationToolSpecs } from "../../../mcp/server/builtin-conversation-tool-specs.js";
import { CLOCK, seedWorkspaces } from "../../../../../../packages/storage/src/__tests__/repos/field/field-contract-fixture.js";

const HANDLER_TIMEOUT = {
  error_code: "handler_timeout",
  message: "MCP tool execution timed out.",
  error_type: "TimeoutError"
} as const;

function createExecutor(insert = vi.fn()) {
  return {
    insert,
    executor: createConversationToolExecutor({
      eventLogRepo: {} as never,
      eventPublisher: { appendManyWithMutation: async (_entries: unknown, mutate: () => unknown) => mutate() } as never,
      runtimeNotifier: { notifyEntry: vi.fn() } as never,
      toolExecutionRecordRepo: { insert } as never,
      toolGovernanceClient: {} as never,
      targetRevalidateService: {},
      strongRefService: {} as never,
      canonicalAliasService: {} as never
    })
  };
}

describe("conversation tool executor abort", () => {
  it("persists the completed effect and its EventLog audit before reporting post-handler cancellation", async () => {
    const database = initDatabase();
    try {
      seedWorkspaces(database);
      database.connection.prepare("INSERT INTO runs (run_id, workspace_id, title, run_mode, created_at, last_active_at) VALUES (?, ?, ?, ?, ?, ?)")
        .run("run-1", "workspace-1", "audit cancellation", "chat", CLOCK, CLOCK);
      const spec = getBuiltinConversationToolSpecs().find(row => row.tool_id === "tools.read_file")!;
      new SqliteToolSpecRepo(database).insertSync(spec);
      const eventLogRepo = new SqliteEventLogRepo(database);
      const runtimeNotifier = createRuntimeNotifier();
      const eventPublisher = new EventPublisher({ eventLogRepo, runtimeNotifier, runHotStateService: { apply: async () => undefined } });
      const records = new SqliteToolExecutionRecordRepo(database);
      const executor = createConversationToolExecutor({ eventLogRepo, eventPublisher, runtimeNotifier,
        toolExecutionRecordRepo: records, toolGovernanceClient: {} as never, targetRevalidateService: {},
        strongRefService: {} as never, canonicalAliasService: {} as never });
      const abort = new AbortController();
      await expect(executor.execute({ toolId: spec.tool_id, rawInput: {},
        runtimeContext: { run_id: "run-1", workspace_id: "workspace-1" }, workspaceRoot: "/tmp", abortSignal: abort.signal,
        handler: async () => { database.connection.exec("CREATE TABLE completed_effect(value TEXT); INSERT INTO completed_effect VALUES ('done')");
          abort.abort(HANDLER_TIMEOUT); return { ok: true }; }
      })).rejects.toEqual(HANDLER_TIMEOUT);
      expect(database.connection.prepare("SELECT value FROM completed_effect").get()).toEqual({ value: "done" });
      expect(await records.listByRunId("run-1", "principal")).toEqual([expect.objectContaining({ executed: true })]);
      expect(await eventLogRepo.queryByRun("run-1")).toEqual([expect.objectContaining({ event_type: "tool_call.completed" })]);
    } finally { database.close(); }
  });

  it("does not run the tool handler when the abort signal is already set", async () => {
    const { insert, executor } = createExecutor();
    const handler = vi.fn(async () => ({ ok: true }));
    const abort = new AbortController();
    abort.abort(HANDLER_TIMEOUT);

    await expect(
      executor.execute({
        toolId: "tools.read_file",
        rawInput: { path: "README.md" },
        runtimeContext: { run_id: "run-1", workspace_id: "workspace-1" },
        workspaceRoot: "/tmp",
        abortSignal: abort.signal,
        handler
      })
    ).rejects.toEqual(HANDLER_TIMEOUT);
    expect(handler).not.toHaveBeenCalled();
    expect(insert).not.toHaveBeenCalled();
  });

  it("records the completed handler before returning cancellation that arrived during execution", async () => {
    const { insert, executor } = createExecutor();
    const abort = new AbortController();
    const handler = vi.fn(async () => {
      abort.abort(HANDLER_TIMEOUT);
      return { ok: true };
    });

    await expect(
      executor.execute({
        toolId: "tools.read_file",
        rawInput: { path: "README.md" },
        runtimeContext: { run_id: "run-1", workspace_id: "workspace-1" },
        workspaceRoot: "/tmp",
        abortSignal: abort.signal,
        handler
      })
    ).rejects.toEqual(HANDLER_TIMEOUT);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(insert).toHaveBeenCalledWith(expect.objectContaining({
      tool_id: "tools.read_file", executed: true, result_summary: "ok"
    }));
  });
});
