import { afterEach, describe, expect, it } from "vitest";
import { initDatabase } from "../db.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createDatabase(): ReturnType<typeof initDatabase> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  seedWorkspace(database);
  return database;
}

function seedWorkspace(database: ReturnType<typeof initDatabase>): void {
  database.connection
    .prepare(
      `INSERT OR IGNORE INTO workspaces (
        workspace_id, name, root_path, workspace_kind, default_engine_binding, workspace_state, created_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "ws-a1-runtime",
      "A1 Runtime",
      "/tmp/a1-runtime",
      "local_repo",
      null,
      "active",
      "2026-04-10T00:00:00.000Z",
      null
    );
}

function insertRun(
  database: ReturnType<typeof initDatabase>,
  runId: string,
  title = `Run ${runId}`
): void {
  database.connection
    .prepare(
      `INSERT INTO runs (
        run_id, workspace_id, title, goal, run_mode, engine_binding_id, run_state, current_surface_id, created_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      runId,
      "ws-a1-runtime",
      title,
      null,
      "build",
      null,
      "idle",
      null,
      "2026-04-10T00:00:00.000Z",
      "2026-04-10T00:00:00.000Z"
    );
}

function insertToolSpec(database: ReturnType<typeof initDatabase>, toolId = "tool.read.fs"): void {
  database.connection
    .prepare(
      `INSERT INTO tool_specs (
        tool_id, category, description, scope_guard, read_only, destructive,
        concurrency_safe, interrupt_behavior, requires_confirmation,
        requires_evidence_reopen, rollback_support, fast_path_eligible
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(toolId, "read", "Filesystem read", "workspace", 1, 0, 1, "continue", 0, 0, "none", 1);
}

function insertPathRelation(
  database: ReturnType<typeof initDatabase>,
  overrides: {
    pathId?: string;
    workspaceId?: string;
  } = {}
): void {
  database.connection
    .prepare(
      `INSERT INTO path_relations (
        path_id,
        workspace_id,
        anchors_json,
        constitution_json,
        effect_vector_json,
        plasticity_state_json,
        lifecycle_json,
        legitimacy_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      overrides.pathId ?? "path-1",
      overrides.workspaceId ?? "ws-a1-runtime",
      JSON.stringify({
        source_anchor: { kind: "object", object_id: "object-1" },
        target_anchor: { kind: "object", object_id: "object-2" }
      }),
      JSON.stringify({
        relation_kind: "supports",
        why_this_relation_exists: ["test"]
      }),
      JSON.stringify({
        salience: 0.3,
        recall_bias: 0.4,
        verification_bias: 0.2,
        unfinishedness_bias: 0.1,
        default_manifestation_preference: "stance_bias"
      }),
      JSON.stringify({
        strength: 0.5,
        direction_bias: "source_to_target",
        stability_class: "volatile",
        support_events_count: 1,
        contradiction_events_count: 0,
        last_reinforced_at: "2026-04-10T00:00:00.000Z"
      }),
      JSON.stringify({
        retirement_rule: "retire_after_cooldown"
      }),
      JSON.stringify({
        evidence_basis: ["evidence-1"],
        governance_class: "hint_only"
      }),
      "2026-04-10T00:00:00.000Z",
      "2026-04-10T00:00:00.000Z"
    );
}

function insertPrincipalWorkerRun(
  database: ReturnType<typeof initDatabase>,
  overrides: {
    workerRunId?: string;
    principalRunId?: string;
    requestingPrincipalRunId?: string | null;
    requestingWorkerRunId?: string | null;
    state?: string;
  } = {}
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
      overrides.workerRunId ?? "worker-run-1",
      overrides.principalRunId ?? "principal-run-1",
      "ws-a1-runtime",
      overrides.requestingPrincipalRunId ?? "requestor-principal-run-1",
      overrides.requestingWorkerRunId ?? null,
      "coding_engine",
      overrides.state ?? "suspended",
      "Investigate runtime state",
      "surface://worker/1",
      "evidence://worker/1",
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
        governance_lease_ref: "lease://principal/1",
        hard_constraint_refs: ["constraint://1"],
        denied_tool_categories: ["write"]
      }),
      "2026-04-10T00:00:00.000Z",
      "2026-04-10T00:05:00.000Z"
    );
}

function getColumnNames(
  database: ReturnType<typeof initDatabase>,
  tableName: string
): string[] {
  return (database.connection
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ readonly name: string }>).map((column) => column.name);
}

function getIndexColumns(
  database: ReturnType<typeof initDatabase>,
  indexName: string
): string[] {
  return (database.connection
    .prepare(`PRAGMA index_info(${indexName})`)
    .all() as Array<{ readonly name: string }>).map((column) => column.name);
}

function getIndexNames(
  database: ReturnType<typeof initDatabase>,
  tableName: string
): string[] {
  return (database.connection
    .prepare(`PRAGMA index_list(${tableName})`)
    .all() as Array<{ readonly name: string }>).map((index) => index.name);
}

function getSchemaObjectSql(
  database: ReturnType<typeof initDatabase>,
  type: "table" | "trigger",
  name: string
): string | null {
  const row = database.connection
    .prepare(
      `
        SELECT sql
        FROM sqlite_master
        WHERE type = ? AND name = ?
        LIMIT 1
      `
    )
    .get(type, name) as { readonly sql: string | null } | undefined;

  return row?.sql ?? null;
}

const SOURCE_ANCHOR_KEY_SQL = `CASE json_extract(anchors_json, '$.source_anchor.kind')
  WHEN 'object' THEN json_array('object', json_extract(anchors_json, '$.source_anchor.object_id'))
  WHEN 'object_facet' THEN json_array(
    'object_facet',
    json_extract(anchors_json, '$.source_anchor.object_id'),
    json_extract(anchors_json, '$.source_anchor.facet_key')
  )
  WHEN 'obligation' THEN json_array(
    'obligation',
    json_extract(anchors_json, '$.source_anchor.source_object_id'),
    json_extract(anchors_json, '$.source_anchor.obligation_digest')
  )
  WHEN 'risk_concern' THEN json_array(
    'risk_concern',
    json_extract(anchors_json, '$.source_anchor.source_object_id'),
    json_extract(anchors_json, '$.source_anchor.concern_digest')
  )
  WHEN 'time_concern' THEN json_array(
    'time_concern',
    json_extract(anchors_json, '$.source_anchor.source_object_id'),
    json_extract(anchors_json, '$.source_anchor.window_digest')
  )
END`;

const TARGET_ANCHOR_KEY_SQL = `CASE json_extract(anchors_json, '$.target_anchor.kind')
  WHEN 'object' THEN json_array('object', json_extract(anchors_json, '$.target_anchor.object_id'))
  WHEN 'object_facet' THEN json_array(
    'object_facet',
    json_extract(anchors_json, '$.target_anchor.object_id'),
    json_extract(anchors_json, '$.target_anchor.facet_key')
  )
  WHEN 'obligation' THEN json_array(
    'obligation',
    json_extract(anchors_json, '$.target_anchor.source_object_id'),
    json_extract(anchors_json, '$.target_anchor.obligation_digest')
  )
  WHEN 'risk_concern' THEN json_array(
    'risk_concern',
    json_extract(anchors_json, '$.target_anchor.source_object_id'),
    json_extract(anchors_json, '$.target_anchor.concern_digest')
  )
  WHEN 'time_concern' THEN json_array(
    'time_concern',
    json_extract(anchors_json, '$.target_anchor.source_object_id'),
    json_extract(anchors_json, '$.target_anchor.window_digest')
  )
END`;

function insertBootstrappingRecord(
  database: ReturnType<typeof initDatabase>,
  overrides: {
    recordId?: string;
    workspaceId?: string;
  } = {}
): void {
  database.connection
    .prepare(
      `INSERT INTO bootstrapping_records (
        record_id,
        workspace_id,
        paths_planted,
        template_ids_json,
        planted_at
      ) VALUES (?, ?, ?, ?, ?)`
    )
    .run(
      overrides.recordId ?? "bootstrap-1",
      overrides.workspaceId ?? "ws-a1-runtime",
      2,
      JSON.stringify(["bootstrap.workspace", "bootstrap.constraints"]),
      "2026-04-10T00:00:00.000Z"
    );
}

describe("A1 runtime foundation migrations", () => {
  it("applies the runtime foundation migration chain and creates only the intended tables", () => {
    const database = createDatabase();

    const versions = (database.connection
      .prepare("SELECT version FROM schema_version WHERE version >= 30 ORDER BY version ASC")
      .all() as Array<{ readonly version: number }>).map((row) => row.version);
    const tables = (database.connection
      .prepare(
        `SELECT name FROM sqlite_master
         WHERE type = 'table' AND name IN (
           'tool_specs',
           'worker_runs',
           'tool_execution_records',
           'node_instances',
           'consolidation_trigger_budgets',
           'deferred_obligations',
           'dirty_state_dossiers',
           'strong_refs',
           'path_relations',
           'path_graph_snapshots',
           'bootstrapping_records',
           'drift_leases',
           'extension_descriptors',
           'global_memory_entries',
           'global_memory_recall_cache',
           'memory_embeddings',
           'principal_runs'
         )
         ORDER BY name ASC`
      )
      .all() as Array<{ readonly name: string }>).map((row) => row.name);
    const memoryFtsTriggers = (database.connection
      .prepare(
        `
          SELECT name
          FROM sqlite_master
          WHERE type = 'trigger'
            AND name IN ('memory_content_fts_ad', 'memory_content_fts_ai', 'memory_content_fts_au')
          ORDER BY name ASC
        `
      )
      .all() as Array<{ readonly name: string }>).map((row) => row.name);
    const memoryFtsTableSql = getSchemaObjectSql(database, "table", "memory_content_fts");

    expect(versions).toEqual([
      30, 31, 32, 33, 34, 35, 36, 37, 38, 39, 40, 41, 42, 43, 44, 45, 46, 47, 48, 49, 50, 51, 52, 53, 54, 55
    ]);
    expect(getColumnNames(database, "workspaces")).toContain("default_engine_class");
    expect(getColumnNames(database, "workspaces")).toContain("repo_path");
    expect(tables).toEqual([
      "bootstrapping_records",
      "consolidation_trigger_budgets",
      "deferred_obligations",
      "dirty_state_dossiers",
      "drift_leases",
      "extension_descriptors",
      "global_memory_entries",
      "global_memory_recall_cache",
      "memory_embeddings",
      "node_instances",
      "path_graph_snapshots",
      "path_relations",
      "strong_refs",
      "tool_execution_records",
      "tool_specs",
      "worker_runs"
    ]);
    expect(memoryFtsTableSql).toContain("object_id UNINDEXED");
    expect(memoryFtsTableSql).toContain("workspace_id UNINDEXED");
    expect(memoryFtsTableSql).toContain("content");
    expect(memoryFtsTableSql).toContain("tokenize = 'trigram'");
    expect(memoryFtsTriggers).toEqual([
      "memory_content_fts_ad",
      "memory_content_fts_ai",
      "memory_content_fts_au"
    ]);
    expect(getIndexNames(database, "global_memory_recall_cache")).toContain(
      "idx_global_memory_recall_cache_global_object_id"
    );
    expect(getIndexColumns(database, "idx_global_memory_recall_cache_global_object_id")).toEqual([
      "global_object_id"
    ]);
    expect(getColumnNames(database, "worker_runs")).toEqual([
      "worker_run_id",
      "principal_run_id",
      "workspace_id",
      "requesting_principal_run_id",
      "requesting_worker_run_id",
      "engine_class",
      "state",
      "subtask_description",
      "local_surface_ref",
      "local_evidence_pointer",
      "restricted_tool_set_json",
      "local_budget_json",
      "agreed_return_format_json",
      "principal_security_snapshot_json",
      "created_at",
      "updated_at"
    ]);
    expect(getColumnNames(database, "tool_execution_records")).toEqual([
      "execution_id",
      "tool_id",
      "requested_by",
      "requesting_principal_run_id",
      "requesting_worker_run_id",
      "node_id",
      "governance_decision_ref",
      "permission_result",
      "executed",
      "started_at",
      "ended_at",
      "result_summary",
      "rollback_status",
      "post_effect_refs_json",
      "affected_paths_json"
    ]);
    expect(getColumnNames(database, "node_instances")).toEqual([
      "node_id",
      "principal_run_id",
      "node_template",
      "state",
      "task_surface_ref",
      "stance_resolution_ref",
      "created_at",
      "updated_at"
    ]);
    expect(getColumnNames(database, "path_relations")).toEqual([
      "path_id",
      "workspace_id",
      "anchors_json",
      "constitution_json",
      "effect_vector_json",
      "plasticity_state_json",
      "lifecycle_json",
      "legitimacy_json",
      "created_at",
      "updated_at"
    ]);
    expect(getColumnNames(database, "path_graph_snapshots")).toEqual([
      "snapshot_id",
      "workspace_id",
      "metrics_json",
      "snapshot_at"
    ]);
    expect(getColumnNames(database, "extension_descriptors")).toEqual([
      "descriptor_id",
      "descriptor_type",
      "name",
      "source",
      "metadata_json",
      "registered_at"
    ]);
    const strongRefForeignKeys = database.connection
      .prepare("PRAGMA foreign_key_list(strong_refs)")
      .all() as Array<{ readonly from: string; readonly table: string; readonly on_delete: string }>;
    const pathRelationForeignKeys = database.connection
      .prepare("PRAGMA foreign_key_list(path_relations)")
      .all() as Array<{ readonly from: string; readonly table: string; readonly on_delete: string }>;
    const strongRefIndexes = database.connection
      .prepare("PRAGMA index_list(strong_refs)")
      .all() as Array<{
      readonly name: string;
      readonly unique: 0 | 1;
      readonly origin: "c" | "pk" | "u";
    }>;

    expect(strongRefForeignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "workspace_id",
          table: "workspaces",
          on_delete: "CASCADE"
        })
      ])
    );
    expect(pathRelationForeignKeys).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: "workspace_id",
          table: "workspaces",
          on_delete: "CASCADE"
        })
      ])
    );
    expect(strongRefIndexes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          name: "idx_strong_refs_target_compound",
          unique: 0
        }),
        expect.objectContaining({
          name: "idx_strong_refs_workspace_id",
          unique: 0
        }),
        expect.objectContaining({
          unique: 1,
          origin: "u"
        })
      ])
    );
    expect(getIndexColumns(database, "idx_strong_refs_target_compound")).toEqual([
      "workspace_id",
      "target_entity_type",
      "target_entity_id"
    ]);
    const compoundUniqueIndex = strongRefIndexes.find((index) => index.unique === 1 && index.origin === "u");
    expect(compoundUniqueIndex).toBeDefined();
    expect(getIndexColumns(database, compoundUniqueIndex!.name)).toEqual([
      "workspace_id",
      "source_entity_id",
      "target_entity_id",
      "reason"
    ]);
    expect(getIndexColumns(database, "idx_path_relations_workspace")).toEqual(["workspace_id"]);
    expect(getIndexColumns(database, "idx_path_relations_updated")).toEqual(["updated_at"]);
    expect(getIndexNames(database, "path_relations")).toEqual(
      expect.arrayContaining([
        "idx_path_relations_source_anchor_key",
        "idx_path_relations_target_anchor_key"
      ])
    );
    expect(getIndexNames(database, "event_log")).toContain("idx_event_log_workspace_id");
    expect(getIndexColumns(database, "idx_event_log_workspace_id")).toEqual(["workspace_id"]);
    expect(getIndexColumns(database, "idx_ext_descriptors_type")).toEqual(["descriptor_type"]);
    expect(getIndexColumns(database, "idx_ext_descriptors_source")).toEqual(["source"]);
  });

  it("adds indexed filtering for workspace replay and anchor lookups while SQLite still sorts separately", () => {
    const database = createDatabase();
    insertPathRelation(database);

    const workspaceReplayPlan = database.connection
      .prepare(
        `
          EXPLAIN QUERY PLAN
          SELECT event_id
          FROM event_log
          WHERE workspace_id = ?
          ORDER BY created_at ASC, rowid ASC
        `
      )
      .all("ws-a1-runtime") as Array<{ readonly detail: string }>;
    const sourceAnchorLookupPlan = database.connection
      .prepare(
        `
          EXPLAIN QUERY PLAN
          SELECT path_id
          FROM path_relations
          WHERE workspace_id = ?
            AND ${SOURCE_ANCHOR_KEY_SQL} = ?
          ORDER BY created_at ASC, path_id ASC
        `
      )
      .all("ws-a1-runtime", '["object","object-1"]') as Array<{ readonly detail: string }>;
    const targetAnchorLookupPlan = database.connection
      .prepare(
        `
          EXPLAIN QUERY PLAN
          SELECT path_id
          FROM path_relations
          WHERE workspace_id = ?
            AND ${TARGET_ANCHOR_KEY_SQL} = ?
          ORDER BY created_at ASC, path_id ASC
        `
      )
      .all("ws-a1-runtime", '["object","object-2"]') as Array<{ readonly detail: string }>;

    expect(
      workspaceReplayPlan.some((row) =>
        row.detail.includes("SEARCH event_log USING INDEX idx_event_log_workspace_id")
      )
    ).toBe(true);
    expect(workspaceReplayPlan.some((row) => row.detail.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(true);
    expect(
      sourceAnchorLookupPlan.some((row) =>
        row.detail.includes("SEARCH path_relations USING INDEX idx_path_relations_source_anchor_key")
      )
    ).toBe(true);
    expect(sourceAnchorLookupPlan.some((row) => row.detail.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(true);
    expect(
      targetAnchorLookupPlan.some((row) =>
        row.detail.includes("SEARCH path_relations USING INDEX idx_path_relations_target_anchor_key")
      )
    ).toBe(true);
    expect(targetAnchorLookupPlan.some((row) => row.detail.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(true);
  });

  it("enforces path relation workspace integrity and cascades on workspace deletion", () => {
    const database = createDatabase();

    expect(() => insertPathRelation(database, { pathId: "path-missing-workspace", workspaceId: "ws-missing" }))
      .toThrow(/FOREIGN KEY constraint failed/i);

    insertPathRelation(database, { pathId: "path-cascade" });

    expect(
      database.connection.prepare("SELECT COUNT(*) AS count FROM path_relations").get()
    ).toEqual({ count: 1 });

    database.connection
      .prepare("DELETE FROM workspaces WHERE workspace_id = ?")
      .run("ws-a1-runtime");

    expect(
      database.connection.prepare("SELECT COUNT(*) AS count FROM path_relations").get()
    ).toEqual({ count: 0 });
  });

  it("keeps bootstrapping_records keyed by workspace without a planted_at cleanup index", () => {
    const database = createDatabase();

    expect(getIndexNames(database, "bootstrapping_records")).not.toContain(
      "idx_bootstrapping_records_planted_at"
    );

    insertBootstrappingRecord(database);

    expect(
      database.connection.prepare("SELECT COUNT(*) AS count FROM bootstrapping_records").get()
    ).toEqual({ count: 1 });

    database.connection
      .prepare("DELETE FROM workspaces WHERE workspace_id = ?")
      .run("ws-a1-runtime");

    expect(
      database.connection.prepare("SELECT COUNT(*) AS count FROM bootstrapping_records").get()
    ).toEqual({ count: 0 });
  });

  it("accepts valid tool spec categories and rejects values outside the protocol enum", () => {
    const database = createDatabase();

    expect(() => insertToolSpec(database, "tool.read.allowed")).not.toThrow();
    expect(() =>
      database.connection
        .prepare(
          `INSERT INTO tool_specs (
            tool_id, category, description, scope_guard, read_only, destructive,
            concurrency_safe, interrupt_behavior, requires_confirmation,
            requires_evidence_reopen, rollback_support, fast_path_eligible
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "tool.shell.invalid",
          "shell",
          "Invalid category",
          "workspace",
          0,
          1,
          0,
          "abort",
          1,
          1,
          "best_effort",
          0
        )
    ).toThrow(/CHECK constraint failed/i);
  });

  it("accepts principal-requested and worker-requested tool execution records with the correct requestor anchor", () => {
    const database = createDatabase();
    insertRun(database, "principal-run-1");
    insertRun(database, "requestor-principal-run-1");
    insertRun(database, "principal-run-2");
    insertRun(database, "requestor-principal-run-2");
    insertToolSpec(database);
    insertPrincipalWorkerRun(database, {
      workerRunId: "worker-run-2",
      principalRunId: "principal-run-2",
      requestingPrincipalRunId: "requestor-principal-run-2"
    });

    expect(() =>
      database.connection
        .prepare(
          `INSERT INTO tool_execution_records (
            execution_id,
            tool_id,
            requested_by,
            requesting_principal_run_id,
            requesting_worker_run_id,
            node_id,
            governance_decision_ref,
            permission_result,
            executed,
            started_at,
            ended_at,
            result_summary,
            rollback_status,
            post_effect_refs_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "execution-principal-1",
          "tool.read.fs",
          "principal",
          "requestor-principal-run-1",
          null,
          "node-1",
          "governance://decision/principal-1",
          "allow",
          1,
          "2026-04-10T00:00:00.000Z",
          "2026-04-10T00:00:01.000Z",
          "Success",
          "none",
          JSON.stringify(["effect://1"])
        )
    ).not.toThrow();

    expect(() =>
      database.connection
        .prepare(
          `INSERT INTO tool_execution_records (
            execution_id,
            tool_id,
            requested_by,
            requesting_principal_run_id,
            requesting_worker_run_id,
            node_id,
            governance_decision_ref,
            permission_result,
            executed,
            started_at,
            ended_at,
            result_summary,
            rollback_status,
            post_effect_refs_json
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "execution-worker-1",
          "tool.read.fs",
          "worker",
          null,
          "worker-run-2",
          "node-2",
          "governance://decision/worker-1",
          "allow",
          1,
          "2026-04-10T00:02:00.000Z",
          "2026-04-10T00:02:02.000Z",
          "Worker success",
          "attempted",
          JSON.stringify([])
        )
    ).not.toThrow();
  });

  it("rejects tool execution records with invalid tool ids or mismatched requestor state", () => {
    const database = createDatabase();
    insertRun(database, "principal-run-1");
    insertRun(database, "requestor-principal-run-1");
    insertRun(database, "principal-run-2");
    insertRun(database, "requestor-principal-run-2");
    insertToolSpec(database);
    insertPrincipalWorkerRun(database, {
      workerRunId: "worker-run-2",
      principalRunId: "principal-run-2",
      requestingPrincipalRunId: "requestor-principal-run-2"
    });

    const insertExecution = database.connection.prepare(
      `INSERT INTO tool_execution_records (
        execution_id,
        tool_id,
        requested_by,
        requesting_principal_run_id,
        requesting_worker_run_id,
        node_id,
        governance_decision_ref,
        permission_result,
        executed,
        started_at,
        ended_at,
        result_summary,
        rollback_status,
        post_effect_refs_json
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    expect(() =>
      insertExecution.run(
        "execution-invalid-tool",
        "tool.read.missing",
        "principal",
        "requestor-principal-run-1",
        null,
        null,
        "governance://decision/invalid-tool",
        "deny",
        0,
        null,
        null,
        null,
        "none",
        JSON.stringify([])
      )
    ).toThrow(/FOREIGN KEY constraint failed/i);

    expect(() =>
      insertExecution.run(
        "execution-invalid-requestor-fk",
        "tool.read.fs",
        "worker",
        null,
        "worker-run-missing",
        null,
        "governance://decision/missing-worker",
        "ask",
        0,
        null,
        null,
        null,
        "none",
        JSON.stringify([])
      )
    ).toThrow(/FOREIGN KEY constraint failed/i);

    expect(() =>
      insertExecution.run(
        "execution-double-requestor",
        "tool.read.fs",
        "principal",
        "requestor-principal-run-1",
        "worker-run-2",
        null,
        "governance://decision/double-requestor",
        "allow",
        1,
        null,
        null,
        null,
        "none",
        JSON.stringify([])
      )
    ).toThrow(/CHECK constraint failed/i);

    expect(() =>
      insertExecution.run(
        "execution-mismatched-requested-by",
        "tool.read.fs",
        "worker",
        "requestor-principal-run-1",
        null,
        null,
        "governance://decision/mismatch",
        "allow",
        1,
        null,
        null,
        null,
        "none",
        JSON.stringify([])
      )
    ).toThrow(/CHECK constraint failed/i);
  });

  it("accepts the suspended worker state with the full durable snapshot and rejects invalid requestor combinations", () => {
    const database = createDatabase();
    insertRun(database, "principal-run-1");
    insertRun(database, "requestor-principal-run-1");
    insertRun(database, "principal-run-2");
    insertRun(database, "requestor-principal-run-2");
    insertPrincipalWorkerRun(database);

    const row = database.connection
      .prepare(
        `SELECT
          state,
          restricted_tool_set_json,
          local_budget_json,
          agreed_return_format_json,
          principal_security_snapshot_json
        FROM worker_runs
        WHERE worker_run_id = ?`
      )
      .get("worker-run-1") as
      | {
          readonly state: string;
          readonly restricted_tool_set_json: string;
          readonly local_budget_json: string;
          readonly agreed_return_format_json: string;
          readonly principal_security_snapshot_json: string;
        }
      | undefined;

    expect(row?.state).toBe("suspended");
    expect(row?.restricted_tool_set_json).toContain("tool.read.fs");
    expect(row?.local_budget_json).toContain("max_wall_time_ms");
    expect(row?.agreed_return_format_json).toContain("analysis_note");
    expect(row?.principal_security_snapshot_json).toContain("governance_lease_ref");

    const insertWorkerRun = database.connection.prepare(
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
    );

    expect(() =>
      insertWorkerRun.run(
        "worker-run-paused",
        "principal-run-1",
        "ws-a1-runtime",
        "requestor-principal-run-1",
        null,
        "coding_engine",
        "paused",
        "Invalid state",
        "surface://worker/paused",
        null,
        JSON.stringify([]),
        JSON.stringify({
          max_worker_delegations: 0,
          max_tool_calls: 0,
          max_output_tokens: 128,
          max_wall_time_ms: 1000
        }),
        JSON.stringify({
          allowed_return_kinds: ["analysis_note"],
          requires_structured_summary: false
        }),
        JSON.stringify({
          governance_lease_ref: "lease://principal/paused",
          hard_constraint_refs: [],
          denied_tool_categories: []
        }),
        "2026-04-10T00:00:00.000Z",
        "2026-04-10T00:00:00.000Z"
      )
    ).toThrow(/CHECK constraint failed/i);

    expect(() =>
      insertWorkerRun.run(
        "worker-run-both-requestors",
        "principal-run-1",
        "ws-a1-runtime",
        "requestor-principal-run-1",
        "worker-run-1",
        "coding_engine",
        "init",
        "Too many requestors",
        "surface://worker/both",
        null,
        JSON.stringify([]),
        JSON.stringify({
          max_worker_delegations: 0,
          max_tool_calls: 0,
          max_output_tokens: 128,
          max_wall_time_ms: 1000
        }),
        JSON.stringify({
          allowed_return_kinds: ["analysis_note"],
          requires_structured_summary: false
        }),
        JSON.stringify({
          governance_lease_ref: "lease://principal/both",
          hard_constraint_refs: [],
          denied_tool_categories: []
        }),
        "2026-04-10T00:00:00.000Z",
        "2026-04-10T00:00:00.000Z"
      )
    ).toThrow(/CHECK constraint failed/i);

    expect(() =>
      insertWorkerRun.run(
        "worker-run-no-requestor",
        "principal-run-1",
        "ws-a1-runtime",
        null,
        null,
        "coding_engine",
        "init",
        "Missing requestor",
        "surface://worker/none",
        null,
        JSON.stringify([]),
        JSON.stringify({
          max_worker_delegations: 0,
          max_tool_calls: 0,
          max_output_tokens: 128,
          max_wall_time_ms: 1000
        }),
        JSON.stringify({
          allowed_return_kinds: ["analysis_note"],
          requires_structured_summary: false
        }),
        JSON.stringify({
          governance_lease_ref: "lease://principal/none",
          hard_constraint_refs: [],
          denied_tool_categories: []
        }),
        "2026-04-10T00:00:00.000Z",
        "2026-04-10T00:00:00.000Z"
      )
    ).toThrow(/CHECK constraint failed/i);
  });

  it("accepts only the frozen node template kinds", () => {
    const database = createDatabase();
    insertRun(database, "principal-run-1");

    expect(() =>
      database.connection
        .prepare(
          `INSERT INTO node_instances (
            node_id,
            principal_run_id,
            node_template,
            state,
            task_surface_ref,
            stance_resolution_ref,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "node-review-1",
          "principal-run-1",
          "review",
          "active",
          "surface://node/review",
          "stance://review/1",
          "2026-04-10T00:00:00.000Z",
          "2026-04-10T00:00:01.000Z"
        )
    ).not.toThrow();

    expect(() =>
      database.connection
        .prepare(
          `INSERT INTO node_instances (
            node_id,
            principal_run_id,
            node_template,
            state,
            task_surface_ref,
            stance_resolution_ref,
            created_at,
            updated_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "node-deploy-1",
          "principal-run-1",
          "deploy",
          "active",
          "surface://node/deploy",
          null,
          "2026-04-10T00:00:00.000Z",
          "2026-04-10T00:00:01.000Z"
        )
    ).toThrow(/CHECK constraint failed/i);
  });

  it("rejects consolidation budgets that exceed the allowed attempt window", () => {
    const database = createDatabase();

    expect(() =>
      database.connection
        .prepare(
          `INSERT INTO consolidation_trigger_budgets (
            trigger_id,
            trigger_source,
            governance_subject,
            source_object_ref,
            max_attempts_within_window,
            attempts_used,
            cooldown_until
          ) VALUES (?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          "trigger-budget-1",
          "verification_failure",
          "subject://verification",
          "object://verification/1",
          2,
          3,
          "2026-04-10T01:00:00.000Z"
        )
    ).toThrow(/CHECK constraint failed/i);
  });
});
