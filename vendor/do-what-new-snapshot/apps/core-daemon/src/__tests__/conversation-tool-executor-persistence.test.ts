import { afterEach, describe, expect, it, vi } from "vitest";
import type { ConversationRuntimeContext, EventLogEntry, ToolProvider, ToolSpec } from "@do-what/protocol";
import {
  ConversationToolExecutor,
  ToolFastPath,
  ToolGovernanceClient,
  ToolSpecService,
  ToolSubstrate
} from "@do-what/core";
import {
  initDatabase,
  SqliteEventLogRepo,
  SqliteToolExecutionRecordRepo,
  SqliteToolSpecRepo
} from "@do-what/storage";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("ConversationToolExecutor persistence", () => {
  it("persists conversation-engine fast-path file tools as principal execution records", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    seedWorkspace(database);
    seedRun(database);

    const toolSpecRepo = new SqliteToolSpecRepo(database);
    const toolSpecService = new ToolSpecService({ toolSpecRepo });
    await toolSpecService.register(createReadFileToolSpec());

    const actualEventLogRepo = new SqliteEventLogRepo(database);
    const appendedEntries: EventLogEntry[] = [];
    const eventLogRepo = {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
        const appended = await actualEventLogRepo.append(entry);
        appendedEntries.push(appended);
        return appended;
      })
    };
    const executionRecordRepo = new SqliteToolExecutionRecordRepo(database);
    const substrate = new ToolSubstrate({
      generateExecutionId: () => "exec-001",
      now: () => "2026-04-12T10:00:00.000Z"
    });
    const sseBroadcaster = {
      broadcastEntry: async () => undefined
    };

    const executor = new ConversationToolExecutor({
      toolSpecService,
      substrate,
      governanceClient: new ToolGovernanceClient({
        port: {
          kind: "test-governance",
          queryToolGovernance: async () => ({
            final_result: "allow",
            matched_claim_refs: [],
            matched_slot_refs: [],
            hard_constraints_present: false,
            requires_red_card: false,
            explanation_summary: "ok"
          })
        }
      }),
      fastPath: new ToolFastPath({
        substrate,
        executionRecordRepo,
        eventLogRepo,
        sseBroadcaster,
        now: () => "2026-04-12T10:00:01.000Z"
      }),
      targetRevalidateService: {
        findAndRevalidate: async () => []
      },
      executionRecordRepo,
      eventLogRepo,
      sseBroadcaster,
      circuitBreaker: {
        getState: () => ({
          postureLevel: 0,
          additionalDeniedCategories: [],
          cooldownUntil: null
        }),
        recordOutcome: async () => undefined
      },
      now: () => "2026-04-12T10:00:01.000Z",
      generateExecutionId: () => "gov-001"
    });

    const result = await executor.execute({
      toolId: "tools.read_file",
      rawInput: {
        path: "/workspace/project/README.md"
      },
      runtimeContext: createRuntimeContext(),
      workspaceRoot: "/workspace/project",
      handler: async (context) => {
        expect(context.sessionConfig.role).toBe("principal");
        expect(context.sessionConfig.tool_profile).toBe("default");

        return {
          ok: true,
          content: "hello",
          bytesRead: 5
        };
      }
    });

    expect(result.executionRecord).toMatchObject({
      execution_id: "exec-001",
      tool_id: "tools.read_file",
      requested_by: "principal",
      requesting_run_id: "run-1"
    });

    const rawRow = database.connection
      .prepare(
        `SELECT
          requested_by,
          requesting_principal_run_id,
          requesting_worker_run_id
         FROM tool_execution_records
         WHERE execution_id = ?`
      )
      .get("exec-001") as
      | {
          readonly requested_by: string;
          readonly requesting_principal_run_id: string | null;
          readonly requesting_worker_run_id: string | null;
        }
      | undefined;

    expect(rawRow).toEqual({
      requested_by: "principal",
      requesting_principal_run_id: "run-1",
      requesting_worker_run_id: null
    });

    const events = await actualEventLogRepo.queryByRun("run-1");
    expect(events.map((entry) => entry.event_type)).toEqual([
      "tool_call.started",
      "tool_call.completed"
    ]);
  });

  it("persists affected_paths for successful conversation-engine write-file executions", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    seedWorkspace(database);
    seedRun(database);

    const toolSpecRepo = new SqliteToolSpecRepo(database);
    const toolSpecService = new ToolSpecService({ toolSpecRepo });
    await toolSpecService.register(createWriteFileToolSpec());

    const actualEventLogRepo = new SqliteEventLogRepo(database);
    const appendedEntries: EventLogEntry[] = [];
    const eventLogRepo = {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
        const appended = await actualEventLogRepo.append(entry);
        appendedEntries.push(appended);
        return appended;
      })
    };
    const executionRecordRepo = new SqliteToolExecutionRecordRepo(database);
    const substrate = new ToolSubstrate({
      generateExecutionId: () => "exec-002",
      now: () => "2026-04-12T10:10:00.000Z"
    });
    const broadcastedEntries: EventLogEntry[] = [];
    const sseBroadcaster = {
      broadcastEntry: vi.fn(async (entry: EventLogEntry) => {
        broadcastedEntries.push(entry);
      })
    };

    const executor = new ConversationToolExecutor({
      toolSpecService,
      substrate,
      governanceClient: new ToolGovernanceClient({
        port: {
          kind: "test-governance",
          queryToolGovernance: async () => ({
            final_result: "allow",
            matched_claim_refs: [],
            matched_slot_refs: [],
            hard_constraints_present: false,
            requires_red_card: false,
            explanation_summary: "ok"
          })
        }
      }),
      fastPath: new ToolFastPath({
        substrate,
        executionRecordRepo,
        eventLogRepo,
        sseBroadcaster,
        now: () => "2026-04-12T10:10:01.000Z"
      }),
      targetRevalidateService: {
        findAndRevalidate: async () => []
      },
      executionRecordRepo,
      eventLogRepo,
      sseBroadcaster,
      circuitBreaker: {
        getState: () => ({
          postureLevel: 0,
          additionalDeniedCategories: [],
          cooldownUntil: null
        }),
        recordOutcome: async () => undefined
      },
      now: () => "2026-04-12T10:10:01.000Z",
      generateExecutionId: () => "gov-002"
    });

    const result = await executor.execute({
      toolId: "tools.write_file",
      rawInput: {
        path: "/workspace/project/src/index.ts",
        content: "export {};\n"
      },
      runtimeContext: createRuntimeContext(),
      workspaceRoot: "/workspace/project",
      handler: async () => ({
        ok: true,
        bytesWritten: 10
      })
    });

    expect(result.executionRecord.affected_paths).toEqual(["src/index.ts"]);

    const rawRow = database.connection
      .prepare(
        `SELECT affected_paths_json
         FROM tool_execution_records
         WHERE execution_id = ?`
      )
      .get("exec-002") as
      | {
          readonly affected_paths_json: string | null;
        }
      | undefined;

    expect(rawRow).toEqual({
      affected_paths_json: JSON.stringify(["src/index.ts"])
    });

    const completedEntry = (await actualEventLogRepo.queryByRun("run-1")).find(
      (entry) => entry.event_type === "tool_call.completed"
    );
    const appendedCompletedEntry = appendedEntries.find(
      (entry) => entry.event_type === "tool_call.completed"
    );
    const broadcastedCompletedEntry = broadcastedEntries.find(
      (entry) => entry.event_type === "tool_call.completed"
    );

    expect(appendedCompletedEntry).toBeDefined();
    expect(broadcastedCompletedEntry).toBe(appendedCompletedEntry);
    expect(completedEntry?.payload_json).toMatchObject({
      toolCallId: "exec-002",
      statusKind: "success",
      affected_paths: ["src/index.ts"]
    });
    expect(broadcastedCompletedEntry?.payload_json).toEqual(completedEntry?.payload_json);
  });

  it("persists affected_paths for successful external filesystem write executions on the conversation path", async () => {
    const database = initDatabase({ filename: ":memory:" });
    databases.add(database);
    seedWorkspace(database);
    seedRun(database);

    const toolSpecRepo = new SqliteToolSpecRepo(database);
    const toolSpecService = new ToolSpecService({ toolSpecRepo });
    await toolSpecService.register(createExternalFilesystemWriteToolSpec());

    const actualEventLogRepo = new SqliteEventLogRepo(database);
    const eventLogRepo = {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">) => {
        return await actualEventLogRepo.append(entry);
      })
    };
    const executionRecordRepo = new SqliteToolExecutionRecordRepo(database);
    const substrate = new ToolSubstrate({
      generateExecutionId: () => "exec-003",
      now: () => "2026-04-12T10:20:00.000Z"
    });
    const sseBroadcaster = {
      broadcastEntry: vi.fn(async () => undefined)
    };

    const executor = new ConversationToolExecutor({
      toolSpecService,
      substrate,
      governanceClient: new ToolGovernanceClient({
        port: {
          kind: "test-governance",
          queryToolGovernance: async () => ({
            final_result: "allow",
            matched_claim_refs: [],
            matched_slot_refs: [],
            hard_constraints_present: false,
            requires_red_card: false,
            explanation_summary: "ok"
          })
        }
      }),
      fastPath: new ToolFastPath({
        substrate,
        executionRecordRepo,
        eventLogRepo,
        sseBroadcaster,
        now: () => "2026-04-12T10:20:01.000Z"
      }),
      targetRevalidateService: {
        findAndRevalidate: async () => []
      },
      executionRecordRepo,
      eventLogRepo,
      sseBroadcaster,
      circuitBreaker: {
        getState: () => ({
          postureLevel: 0,
          additionalDeniedCategories: [],
          cooldownUntil: null
        }),
        recordOutcome: async () => undefined
      },
      extensionRegistry: {
        findProviderForTool: async () => createExternalFilesystemProvider()
      },
      now: () => "2026-04-12T10:20:01.000Z",
      generateExecutionId: () => "gov-003"
    });

    const result = await executor.execute({
      toolId: "mcp__filesystem__write_file",
      rawInput: {
        path: "/workspace/project/docs/notes.md",
        content: "hello\n"
      },
      runtimeContext: createRuntimeContext(),
      workspaceRoot: "/workspace/project",
      handler: async () => ({
        content: [{ type: "text", text: "ok" }]
      })
    });

    expect(result.executionRecord.affected_paths).toEqual(["docs/notes.md"]);

    const rawRow = database.connection
      .prepare(
        `SELECT affected_paths_json
         FROM tool_execution_records
         WHERE execution_id = ?`
      )
      .get("exec-003") as
      | {
          readonly affected_paths_json: string | null;
        }
      | undefined;

    expect(rawRow).toEqual({
      affected_paths_json: JSON.stringify(["docs/notes.md"])
    });

    const completedEntry = (await actualEventLogRepo.queryByRun("run-1")).find(
      (entry) => entry.event_type === "tool_call.completed"
    );
    expect(completedEntry?.payload_json).toMatchObject({
      toolCallId: "exec-003",
      statusKind: "success",
      affected_paths: ["docs/notes.md"]
    });
  });
});

function seedWorkspace(database: ReturnType<typeof initDatabase>): void {
  database.connection
    .prepare(
      `INSERT OR IGNORE INTO workspaces (
        workspace_id, name, root_path, workspace_kind, default_engine_binding, workspace_state, created_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "workspace-1",
      "Workspace 1",
      "/workspace/project",
      "local_repo",
      null,
      "active",
      "2026-04-12T00:00:00.000Z",
      null
    );
}

function seedRun(database: ReturnType<typeof initDatabase>): void {
  database.connection
    .prepare(
      `INSERT INTO runs (
        run_id, workspace_id, title, goal, run_mode, engine_binding_id, run_state, current_surface_id, created_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "run-1",
      "workspace-1",
      "Run 1",
      null,
      "chat",
      null,
      "idle",
      null,
      "2026-04-12T00:00:00.000Z",
      "2026-04-12T00:00:00.000Z"
    );
}

function createRuntimeContext(): ConversationRuntimeContext {
  return {
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    user_message_id: "msg-user-1",
    assistant_message_id: "msg-assistant-1"
  };
}

function createReadFileToolSpec(): ToolSpec {
  return {
    tool_id: "tools.read_file",
    category: "read",
    description: "Read a file in the workspace.",
    scope_guard: "workspace",
    read_only: true,
    destructive: false,
    concurrency_safe: true,
    interrupt_behavior: "continue",
    requires_confirmation: false,
    requires_evidence_reopen: false,
    rollback_support: "none",
    fast_path_eligible: true
  };
}

function createWriteFileToolSpec(): ToolSpec {
  return {
    tool_id: "tools.write_file",
    category: "write",
    description: "Write a file in the workspace.",
    scope_guard: "workspace",
    read_only: false,
    destructive: false,
    concurrency_safe: false,
    interrupt_behavior: "continue",
    requires_confirmation: false,
    requires_evidence_reopen: false,
    rollback_support: "none",
    fast_path_eligible: false
  };
}

function createExternalFilesystemWriteToolSpec(): ToolSpec {
  return {
    tool_id: "mcp__filesystem__write_file",
    category: "write",
    description: "Write a file through filesystem MCP.",
    scope_guard: "workspace",
    read_only: false,
    destructive: false,
    concurrency_safe: false,
    interrupt_behavior: "continue",
    requires_confirmation: false,
    requires_evidence_reopen: false,
    rollback_support: "none",
    fast_path_eligible: false
  };
}

function createExternalFilesystemProvider(): ToolProvider {
  return {
    provider_id: "provider.mcp.filesystem",
    name: "Filesystem MCP Provider",
    source: "mcp_external",
    tool_specs: [
      {
        tool_id: "mcp__filesystem__write_file",
        name: "filesystem.write_file",
        description: "Write a file through filesystem MCP."
      }
    ],
    requires_permission_check: true,
    records_execution: true,
    registered_at: "2026-04-20T10:45:00.000Z"
  };
}
