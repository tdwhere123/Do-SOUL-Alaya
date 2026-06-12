import { afterEach, describe, expect, it } from "vitest";
import type { DirtyStateDossier } from "@do-soul/alaya-protocol";
import { initDatabase } from "../../sqlite/db.js";
import { SqliteDirtyStateDossierRepo } from "../../repos/health/dirty-state-dossier-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createDossier(overrides: Partial<DirtyStateDossier> = {}): DirtyStateDossier {
  return {
    dossier_id: overrides.dossier_id ?? "dossier-1",
    worker_run_id: overrides.worker_run_id ?? "worker-run-1",
    principal_run_id: overrides.principal_run_id ?? "run-1",
    workspace_id: overrides.workspace_id ?? "workspace-1",
    trigger: overrides.trigger ?? "state_inconsistency",
    panic_source: overrides.panic_source ?? "integration_gate",
    panic_summary:
      overrides.panic_summary ??
      "supports_streaming_updates expected=true actual=false",
    affected_data_scope:
      overrides.affected_data_scope ?? [{ entity_type: "worker_capability", entity_id: "supports_streaming_updates" }],
    created_at: overrides.created_at ?? "2026-04-15T00:00:00.000Z"
  };
}

describe("SqliteDirtyStateDossierRepo", () => {
  it("persists and round-trips a dossier with JSON affected_data_scope", async () => {
    const { database, repo } = createRepo();
    const dossier = createDossier();

    expect(repo.create(dossier)).toEqual(dossier);

    const rawRow = database.connection
      .prepare(
        `SELECT affected_data_scope
         FROM dirty_state_dossiers
         WHERE dossier_id = ?`
      )
      .get(dossier.dossier_id) as { readonly affected_data_scope: string } | undefined;

    expect(rawRow).toEqual({
      affected_data_scope: JSON.stringify(dossier.affected_data_scope)
    });

    const byWorkspace = await repo.findByWorkspace("workspace-1");
    const byRun = await repo.findByWorkerRun("worker-run-1");

    expect(byWorkspace).toEqual([dossier]);
    expect(byRun).toEqual([dossier]);
    expect(Object.isFrozen(byWorkspace)).toBe(true);
    expect(Object.isFrozen(byWorkspace[0])).toBe(true);
    expect(Object.isFrozen(byWorkspace[0]?.affected_data_scope)).toBe(true);
  });

  it("filters dossiers by workspace and worker run", async () => {
    const { repo } = createRepo();
    const workspaceOneRunOne = createDossier({
      dossier_id: "dossier-1",
      workspace_id: "workspace-1",
      principal_run_id: "run-1",
      worker_run_id: "worker-run-1",
      created_at: "2026-04-15T00:00:00.000Z"
    });
    const workspaceOneRunTwo = createDossier({
      dossier_id: "dossier-2",
      workspace_id: "workspace-1",
      principal_run_id: "run-2",
      worker_run_id: "worker-run-2",
      created_at: "2026-04-15T00:00:01.000Z"
    });
    const workspaceTwoRunThree = createDossier({
      dossier_id: "dossier-3",
      workspace_id: "workspace-2",
      principal_run_id: "run-3",
      worker_run_id: "worker-run-3",
      created_at: "2026-04-15T00:00:02.000Z"
    });

    await repo.create(workspaceOneRunOne);
    await repo.create(workspaceOneRunTwo);
    await repo.create(workspaceTwoRunThree);

    await expect(repo.findByWorkspace("workspace-1")).resolves.toEqual([
      workspaceOneRunOne,
      workspaceOneRunTwo
    ]);
    await expect(repo.findByWorkspace("workspace-2")).resolves.toEqual([workspaceTwoRunThree]);
    await expect(repo.findByWorkerRun("worker-run-1")).resolves.toEqual([workspaceOneRunOne]);
    await expect(repo.findByWorkerRun("worker-run-2")).resolves.toEqual([workspaceOneRunTwo]);
    await expect(repo.findByWorkerRun("worker-run-3")).resolves.toEqual([workspaceTwoRunThree]);
    await expect(repo.findByWorkspace("workspace-missing")).resolves.toEqual([]);
    await expect(repo.findByWorkerRun("run-missing")).resolves.toEqual([]);

    await repo.deleteById("dossier-2");
    await expect(repo.findByWorkerRun("worker-run-2")).resolves.toEqual([]);
  });
});

function createRepo(): {
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteDirtyStateDossierRepo;
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  seedWorkspaceAndRuns(database);

  return {
    database,
    repo: new SqliteDirtyStateDossierRepo(database)
  };
}

function seedWorkspaceAndRuns(database: ReturnType<typeof initDatabase>): void {
  database.connection
    .prepare(
      `INSERT INTO workspaces (
        workspace_id, name, root_path, workspace_kind, default_engine_binding, workspace_state, created_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "workspace-1",
      "Workspace One",
      "/tmp/workspace-one",
      "local_repo",
      null,
      "active",
      "2026-04-15T00:00:00.000Z",
      null
    );
  database.connection
    .prepare(
      `INSERT INTO workspaces (
        workspace_id, name, root_path, workspace_kind, default_engine_binding, workspace_state, created_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "workspace-2",
      "Workspace Two",
      "/tmp/workspace-two",
      "local_repo",
      null,
      "active",
      "2026-04-15T00:00:00.000Z",
      null
    );

  insertRun(database, "run-1", "workspace-1");
  insertRun(database, "run-2", "workspace-1");
  insertRun(database, "run-3", "workspace-2");
  insertWorkerRun(database, "worker-run-1", "run-1", "workspace-1");
  insertWorkerRun(database, "worker-run-2", "run-2", "workspace-1");
  insertWorkerRun(database, "worker-run-3", "run-3", "workspace-2");
}

function insertRun(
  database: ReturnType<typeof initDatabase>,
  runId: string,
  workspaceId: string
): void {
  database.connection
    .prepare(
      `INSERT INTO runs (
        run_id, workspace_id, title, goal, run_mode, engine_binding_id, run_state, current_surface_id, created_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      runId,
      workspaceId,
      `Run ${runId}`,
      null,
      "build",
      null,
      "idle",
      null,
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z"
    );
}

function insertWorkerRun(
  database: ReturnType<typeof initDatabase>,
  workerRunId: string,
  principalRunId: string,
  workspaceId: string
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
      workerRunId,
      principalRunId,
      workspaceId,
      principalRunId,
      null,
      "coding_engine",
      "init",
      "Investigate worker panic",
      "surface://worker/1",
      null,
      JSON.stringify(["tools.read_file"]),
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
        governance_lease_ref: "lease://1",
        hard_constraint_refs: ["constraint://1"],
        denied_tool_categories: ["network"]
      }),
      "2026-04-15T00:00:00.000Z",
      "2026-04-15T00:00:00.000Z"
    );
}
