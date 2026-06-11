import { afterEach, describe, expect, it } from "vitest";
import type { ToolExecutionRecord } from "@do-soul/alaya-protocol";
import { initDatabase } from "../../db.js";
import { SqliteToolExecutionRecordRepo } from "../../index.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteToolExecutionRecordRepo", () => {
  it("round-trips principal-requested records with empty post effects and executed false", async () => {
    const { database, repo } = createRepo();
    const record = createExecutionRecord({
      execution_id: "exec-principal-001",
      requested_by: "principal",
      requesting_run_id: "requestor-principal-run-1",
      executed: false,
      post_effect_refs: []
    });

    await expect(repo.insert(record)).resolves.toEqual(record);

    const rawRow = database.connection
      .prepare(
        `SELECT
          requesting_principal_run_id,
          requesting_worker_run_id,
          executed,
          post_effect_refs_json,
          affected_paths_json
         FROM tool_execution_records
         WHERE execution_id = ?`
      )
      .get(record.execution_id) as
      | {
          readonly requesting_principal_run_id: string | null;
          readonly requesting_worker_run_id: string | null;
          readonly executed: number;
          readonly post_effect_refs_json: string;
          readonly affected_paths_json: string | null;
        }
      | undefined;

    expect(rawRow).toEqual({
      requesting_principal_run_id: "requestor-principal-run-1",
      requesting_worker_run_id: null,
      executed: 0,
      post_effect_refs_json: "[]",
      affected_paths_json: null
    });

    const found = await repo.findById(record.execution_id);

    expect(found).toEqual(record);
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found?.post_effect_refs)).toBe(true);
  });

  it("round-trips worker-requested records and restores executed true from integer storage", async () => {
    const { database, repo } = createRepo();
    const record = createExecutionRecord({
      execution_id: "exec-worker-001",
      requested_by: "worker",
      requesting_run_id: "worker-run-1",
      executed: true,
      node_id: "node-worker-1",
      post_effect_refs: ["effect://worker/1", "effect://worker/2"]
    });

    await expect(repo.insert(record)).resolves.toEqual(record);

    const rawRow = database.connection
      .prepare(
        `SELECT
          requesting_principal_run_id,
          requesting_worker_run_id,
          executed,
          post_effect_refs_json,
          affected_paths_json
         FROM tool_execution_records
         WHERE execution_id = ?`
      )
      .get(record.execution_id) as
      | {
          readonly requesting_principal_run_id: string | null;
          readonly requesting_worker_run_id: string | null;
          readonly executed: number;
          readonly post_effect_refs_json: string;
          readonly affected_paths_json: string | null;
        }
      | undefined;

    expect(rawRow).toEqual({
      requesting_principal_run_id: null,
      requesting_worker_run_id: "worker-run-1",
      executed: 1,
      post_effect_refs_json: JSON.stringify(record.post_effect_refs),
      affected_paths_json: null
    });

    await expect(repo.findById(record.execution_id)).resolves.toEqual(record);
  });

  it("round-trips affected_paths null, empty arrays, and non-empty arrays independently from post effects", async () => {
    const { database, repo } = createRepo();
    const nullRecord = createExecutionRecord({
      execution_id: "exec-affected-null",
      requested_by: "principal",
      requesting_run_id: "requestor-principal-run-1",
      affected_paths: null,
      post_effect_refs: []
    });
    const emptyRecord = createExecutionRecord({
      execution_id: "exec-affected-empty",
      requested_by: "principal",
      requesting_run_id: "requestor-principal-run-1",
      affected_paths: [],
      post_effect_refs: ["effect://empty/1"]
    });
    const nonEmptyRecord = createExecutionRecord({
      execution_id: "exec-affected-non-empty",
      requested_by: "worker",
      requesting_run_id: "worker-run-1",
      affected_paths: ["src/index.ts", "docs/README.md"],
      post_effect_refs: []
    });

    await expect(repo.insert(nullRecord)).resolves.toEqual(nullRecord);
    await expect(repo.insert(emptyRecord)).resolves.toEqual(emptyRecord);
    await expect(repo.insert(nonEmptyRecord)).resolves.toEqual(nonEmptyRecord);

    const rows = database.connection
      .prepare(
        `SELECT execution_id, affected_paths_json
         FROM tool_execution_records
         WHERE execution_id IN (?, ?, ?)
         ORDER BY execution_id ASC`
      )
      .all(
        nullRecord.execution_id,
        emptyRecord.execution_id,
        nonEmptyRecord.execution_id
      ) as Array<{
        readonly execution_id: string;
        readonly affected_paths_json: string | null;
      }>;

    expect(rows).toEqual([
      { execution_id: "exec-affected-empty", affected_paths_json: "[]" },
      {
        execution_id: "exec-affected-non-empty",
        affected_paths_json: JSON.stringify(["src/index.ts", "docs/README.md"])
      },
      { execution_id: "exec-affected-null", affected_paths_json: "null" }
    ]);

    await expect(repo.findById(nullRecord.execution_id)).resolves.toEqual(nullRecord);
    await expect(repo.findById(emptyRecord.execution_id)).resolves.toEqual(emptyRecord);
    await expect(repo.findById(nonEmptyRecord.execution_id)).resolves.toEqual(nonEmptyRecord);
  });

  it("lists records filtered by run id and requested_by", async () => {
    const { repo } = createRepo();
    const principalRunRecord = createExecutionRecord({
      execution_id: "exec-principal-match",
      requested_by: "principal",
      requesting_run_id: "requestor-principal-run-1"
    });
    const otherPrincipalRecord = createExecutionRecord({
      execution_id: "exec-principal-other",
      requested_by: "principal",
      requesting_run_id: "requestor-principal-run-2"
    });
    const workerRunRecord = createExecutionRecord({
      execution_id: "exec-worker-match",
      requested_by: "worker",
      requesting_run_id: "worker-run-1"
    });
    const otherWorkerRecord = createExecutionRecord({
      execution_id: "exec-worker-other",
      requested_by: "worker",
      requesting_run_id: "worker-run-2"
    });

    await repo.insert(principalRunRecord);
    await repo.insert(otherPrincipalRecord);
    await repo.insert(workerRunRecord);
    await repo.insert(otherWorkerRecord);

    await expect(repo.listByRunId("requestor-principal-run-1", "principal")).resolves.toEqual([
      principalRunRecord
    ]);
    await expect(repo.listByRunId("worker-run-1", "worker")).resolves.toEqual([workerRunRecord]);
  });
});

function createRepo(): {
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteToolExecutionRecordRepo;
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  seedWorkspace(database);
  insertRun(database, "principal-run-1");
  insertRun(database, "requestor-principal-run-1");
  insertRun(database, "requestor-principal-run-2");
  insertRun(database, "principal-run-2");
  insertToolSpec(database);
  insertWorkerRun(database, {
    workerRunId: "worker-run-1",
    principalRunId: "principal-run-1",
    requestingPrincipalRunId: "requestor-principal-run-1"
  });
  insertWorkerRun(database, {
    workerRunId: "worker-run-2",
    principalRunId: "principal-run-2",
    requestingPrincipalRunId: "requestor-principal-run-2"
  });

  return {
    database,
    repo: new SqliteToolExecutionRecordRepo(database)
  };
}

function createExecutionRecord(overrides: Partial<ToolExecutionRecord> = {}): ToolExecutionRecord {
  return {
    execution_id: overrides.execution_id ?? "exec-001",
    tool_id: overrides.tool_id ?? "tool.read.fs",
    requested_by: overrides.requested_by ?? "principal",
    requesting_run_id:
      overrides.requesting_run_id ??
      (overrides.requested_by === "worker" ? "worker-run-1" : "requestor-principal-run-1"),
    node_id: overrides.node_id,
    governance_decision_ref: overrides.governance_decision_ref ?? "governance://decision/1",
    permission_result: overrides.permission_result ?? "allow",
    executed: overrides.executed ?? true,
    started_at: overrides.started_at ?? "2026-04-12T10:00:00.000Z",
    ended_at: overrides.ended_at ?? "2026-04-12T10:00:01.000Z",
    result_summary: overrides.result_summary ?? "Filesystem read completed.",
    rollback_status: overrides.rollback_status ?? "none",
    post_effect_refs: overrides.post_effect_refs ?? ["effect://default/1"],
    affected_paths: overrides.affected_paths
  };
}

function seedWorkspace(database: ReturnType<typeof initDatabase>): void {
  database.connection
    .prepare(
      `INSERT OR IGNORE INTO workspaces (
        workspace_id, name, root_path, workspace_kind, default_engine_binding, workspace_state, created_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "ws-a2-fast-path",
      "A2 Fast Path",
      "/tmp/a2-fast-path",
      "local_repo",
      null,
      "active",
      "2026-04-12T00:00:00.000Z",
      null
    );
}

function insertRun(database: ReturnType<typeof initDatabase>, runId: string): void {
  database.connection
    .prepare(
      `INSERT INTO runs (
        run_id, workspace_id, title, goal, run_mode, engine_binding_id, run_state, current_surface_id, created_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      runId,
      "ws-a2-fast-path",
      `Run ${runId}`,
      null,
      "build",
      null,
      "idle",
      null,
      "2026-04-12T00:00:00.000Z",
      "2026-04-12T00:00:00.000Z"
    );
}

function insertToolSpec(database: ReturnType<typeof initDatabase>): void {
  database.connection
    .prepare(
      `INSERT INTO tool_specs (
        tool_id, category, description, scope_guard, read_only, destructive,
        concurrency_safe, interrupt_behavior, requires_confirmation,
        requires_evidence_reopen, rollback_support, fast_path_eligible
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run("tool.read.fs", "read", "Filesystem read", "workspace", 1, 0, 1, "continue", 0, 0, "none", 1);
}

function insertWorkerRun(
  database: ReturnType<typeof initDatabase>,
  options: {
    readonly workerRunId: string;
    readonly principalRunId: string;
    readonly requestingPrincipalRunId: string;
  }
): void {
  database.connection
    .prepare(
      `INSERT INTO worker_runs (
        worker_run_id,
        principal_run_id,
        workspace_id,
        requesting_principal_run_id,
        requesting_worker_run_id,
        engine_class,
        state,
        subtask_description,
        local_surface_ref,
        local_evidence_pointer,
        restricted_tool_set_json,
        local_budget_json,
        agreed_return_format_json,
        principal_security_snapshot_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      options.workerRunId,
      options.principalRunId,
      "ws-a2-fast-path",
      options.requestingPrincipalRunId,
      null,
      "coding_engine",
      "suspended",
      "Investigate fast-path state",
      `surface://${options.workerRunId}`,
      `evidence://${options.workerRunId}`,
      JSON.stringify(["tool.read.fs"]),
      JSON.stringify({
        max_worker_delegations: 1,
        max_tool_calls: 3,
        max_output_tokens: 512,
        max_wall_time_ms: 60000
      }),
      JSON.stringify({
        allowed_return_kinds: ["analysis_note"],
        requires_structured_summary: true
      }),
      JSON.stringify({
        governance_lease_ref: `lease://${options.workerRunId}`,
        hard_constraint_refs: [],
        denied_tool_categories: []
      }),
      "2026-04-12T00:00:00.000Z",
      "2026-04-12T00:05:00.000Z"
    );
}
