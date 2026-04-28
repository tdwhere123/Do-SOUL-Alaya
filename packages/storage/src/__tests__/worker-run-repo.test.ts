import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import type { DelegatedWorkerRun } from "@do-soul/alaya-protocol";
import { initDatabase, SqliteWorkerRunRepo, StorageDatabase, StorageError } from "../index.js";

const databases = new Set<StorageDatabase>();
const tempDirectories = new Set<string>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();

  for (const directory of tempDirectories) {
    fs.rmSync(directory, { recursive: true, force: true });
  }

  tempDirectories.clear();
});

describe("SqliteWorkerRunRepo", () => {
  it("round-trips delegated worker runs, including JSON columns and requesting principal mapping", async () => {
    const { database, repo } = createRepo();
    const run = createWorkerRun();

    await expect(repo.insert(run)).resolves.toEqual(run);

    const rawRow = database.connection
      .prepare(
        `SELECT
          requesting_principal_run_id,
          requesting_worker_run_id,
          restricted_tool_set_json,
          local_budget_json,
          agreed_return_format_json,
          principal_security_snapshot_json
         FROM worker_runs
         WHERE worker_run_id = ?`
      )
      .get(run.worker_run_id) as
      | {
          readonly requesting_principal_run_id: string | null;
          readonly requesting_worker_run_id: string | null;
          readonly restricted_tool_set_json: string;
          readonly local_budget_json: string;
          readonly agreed_return_format_json: string;
          readonly principal_security_snapshot_json: string;
        }
      | undefined;

    expect(rawRow).toEqual({
      requesting_principal_run_id: run.requesting_run_id,
      requesting_worker_run_id: null,
      restricted_tool_set_json: JSON.stringify(run.restricted_tool_set),
      local_budget_json: JSON.stringify(run.local_budget),
      agreed_return_format_json: JSON.stringify(run.agreed_return_format),
      principal_security_snapshot_json: JSON.stringify(run.principal_security_snapshot)
    });

    const found = await repo.getById(run.worker_run_id);

    expect(found).toEqual(run);
    expect(Object.isFrozen(found)).toBe(true);
    expect(Object.isFrozen(found?.restricted_tool_set)).toBe(true);
    expect(Object.isFrozen(found?.local_budget ?? null)).toBe(true);
    expect(Object.isFrozen(found?.agreed_return_format ?? null)).toBe(true);
    expect(Object.isFrozen(found?.principal_security_snapshot ?? null)).toBe(true);
  });

  it("returns null when the worker run does not exist", async () => {
    const { repo } = createRepo();

    await expect(repo.getById("missing-worker-run")).resolves.toBeNull();
  });

  it("updates state with compare-and-swap semantics and refreshes updated_at", async () => {
    const { repo } = createRepo();
    const run = createWorkerRun({ worker_run_id: "worker-run-cas", state: "init" });

    await repo.insert(run);

    await expect(
      repo.updateState(
        run.worker_run_id,
        "init",
        "active",
        "2026-04-13T10:10:00.000Z"
      )
    ).resolves.toEqual({
      ...run,
      state: "active",
      updated_at: "2026-04-13T10:10:00.000Z"
    });
  });

  it("rejects compare-and-swap updates when the expected state does not match", async () => {
    const { repo } = createRepo();
    const run = createWorkerRun({ worker_run_id: "worker-run-cas-fail", state: "init" });

    await repo.insert(run);

    await expect(
      repo.updateState(
        run.worker_run_id,
        "active",
        "completed",
        "2026-04-13T10:10:00.000Z"
      )
    ).rejects.toMatchObject({
      name: "StorageError",
      code: "CONFLICT"
    });
  });

  it("deletes a worker run only when the expected state matches", async () => {
    const { repo } = createRepo();
    const run = createWorkerRun({ worker_run_id: "worker-run-delete", state: "init" });

    await repo.insert(run);
    await expect(repo.deleteIfState(run.worker_run_id, "init")).resolves.toBeUndefined();
    await expect(repo.getById(run.worker_run_id)).resolves.toBeNull();
  });

  it("rejects compare-and-swap deletes when the expected state does not match", async () => {
    const { repo } = createRepo();
    const run = createWorkerRun({ worker_run_id: "worker-run-delete-fail", state: "active" });

    await repo.insert(run);

    await expect(repo.deleteIfState(run.worker_run_id, "init")).rejects.toMatchObject({
      name: "StorageError",
      code: "CONFLICT"
    });
    await expect(repo.getById(run.worker_run_id)).resolves.toEqual(run);
  });

  it("finds only active workers for a principal run", async () => {
    const { repo } = createRepo();
    const inactiveRun = createWorkerRun({
      worker_run_id: "worker-run-init",
      principal_run_id: "principal-run-2",
      requesting_run_id: "principal-run-2",
      state: "init"
    });
    const activeRun = createWorkerRun({
      worker_run_id: "worker-run-active",
      principal_run_id: "principal-run-2",
      requesting_run_id: "principal-run-2",
      state: "active"
    });

    await repo.insert(inactiveRun);
    await repo.insert(activeRun);

    await expect(repo.findActiveByPrincipalRunId("principal-run-2")).resolves.toEqual(activeRun);
    await expect(repo.findActiveByPrincipalRunId("principal-run-1")).resolves.toBeNull();
  });

  it("atomically inserts when there is no in-flight worker for the principal", async () => {
    const { repo } = createRepo();
    const run = createWorkerRun({
      worker_run_id: "worker-run-serial-ok",
      principal_run_id: "principal-run-2",
      requesting_run_id: "principal-run-2",
      state: "init"
    });

    await expect(repo.insertIfNoActiveForPrincipal("principal-run-2", run)).resolves.toEqual(run);
  });

  it("rejects atomic insert when the principal already has an in-flight worker", async () => {
    const { repo } = createRepo();
    const activeRun = createWorkerRun({
      worker_run_id: "worker-run-existing-active",
      principal_run_id: "principal-run-2",
      requesting_run_id: "principal-run-2",
      state: "active"
    });
    const nextRun = createWorkerRun({
      worker_run_id: "worker-run-conflict",
      principal_run_id: "principal-run-2",
      requesting_run_id: "principal-run-2",
      state: "init"
    });

    await repo.insert(activeRun);

    await expect(repo.insertIfNoActiveForPrincipal("principal-run-2", nextRun)).rejects.toMatchObject({
      name: "StorageError",
      code: "CONFLICT"
    });
  });

  it("rejects atomic insert when the principal already has an init worker", async () => {
    const { repo } = createRepo();
    const initRun = createWorkerRun({
      worker_run_id: "worker-run-existing-init",
      principal_run_id: "principal-run-2",
      requesting_run_id: "principal-run-2",
      state: "init"
    });
    const nextRun = createWorkerRun({
      worker_run_id: "worker-run-conflict-init",
      principal_run_id: "principal-run-2",
      requesting_run_id: "principal-run-2",
      state: "init"
    });

    await repo.insert(initRun);

    await expect(repo.insertIfNoActiveForPrincipal("principal-run-2", nextRun)).rejects.toMatchObject({
      name: "StorageError",
      code: "CONFLICT"
    });
  });

  it("rejects atomic insert when the principal already has a suspended worker", async () => {
    const { repo } = createRepo();
    const suspendedRun = createWorkerRun({
      worker_run_id: "worker-run-existing-suspended",
      principal_run_id: "principal-run-2",
      requesting_run_id: "principal-run-2",
      state: "suspended"
    });
    const nextRun = createWorkerRun({
      worker_run_id: "worker-run-conflict-suspended",
      principal_run_id: "principal-run-2",
      requesting_run_id: "principal-run-2",
      state: "init"
    });

    await repo.insert(suspendedRun);

    await expect(
      repo.insertIfNoActiveForPrincipal("principal-run-2", nextRun)
    ).rejects.toMatchObject({
      name: "StorageError",
      code: "CONFLICT"
    });
  });

  it("rejects atomic insert when a raw SQLite suspended row already exists for the principal", async () => {
    const { database, repo } = createRepo();
    const insertedRun = createWorkerRun({
      worker_run_id: "worker-run-existing-active-raw",
      principal_run_id: "principal-run-2",
      requesting_run_id: "principal-run-2",
      state: "active"
    });
    const nextRun = createWorkerRun({
      worker_run_id: "worker-run-conflict-suspended-raw",
      principal_run_id: "principal-run-2",
      requesting_run_id: "principal-run-2",
      state: "init"
    });

    await repo.insert(insertedRun);
    database.connection
      .prepare(`UPDATE worker_runs SET state = 'suspended' WHERE worker_run_id = ?`)
      .run(insertedRun.worker_run_id);

    await expect(
      repo.insertIfNoActiveForPrincipal("principal-run-2", nextRun)
    ).rejects.toMatchObject({
      name: "StorageError",
      code: "CONFLICT"
    });
  });

  it("allows only one competing atomic insert for the same principal", async () => {
    const { repoA, repoB, close } = createConcurrentRepos();
    const firstRun = createWorkerRun({
      worker_run_id: "worker-run-race-1",
      principal_run_id: "principal-run-2",
      requesting_run_id: "principal-run-2",
      state: "init"
    });
    const secondRun = createWorkerRun({
      worker_run_id: "worker-run-race-2",
      principal_run_id: "principal-run-2",
      requesting_run_id: "principal-run-2",
      state: "init"
    });

    try {
      const results = await Promise.allSettled([
        repoA.insertIfNoActiveForPrincipal("principal-run-2", firstRun),
        repoB.insertIfNoActiveForPrincipal("principal-run-2", secondRun)
      ]);

      expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);

      const rejected = results.find(
        (result): result is PromiseRejectedResult => result.status === "rejected"
      );
      expect(rejected?.reason).toMatchObject<Partial<StorageError>>({
        name: "StorageError",
        code: "CONFLICT"
      });
    } finally {
      close();
    }
  });
});

function createRepo(): {
  readonly database: StorageDatabase;
  readonly repo: SqliteWorkerRunRepo;
} {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  seedWorkspace(database);
  insertRun(database, "principal-run-1");
  insertRun(database, "principal-run-2");

  return {
    database,
    repo: new SqliteWorkerRunRepo(database)
  };
}

function createConcurrentRepos(): {
  readonly repoA: SqliteWorkerRunRepo;
  readonly repoB: SqliteWorkerRunRepo;
  readonly close: () => void;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "worker-run-repo-"));
  const filename = path.join(directory, "worker-runs.db");
  tempDirectories.add(directory);

  const seedDatabase = initDatabase({ filename });
  seedWorkspace(seedDatabase);
  insertRun(seedDatabase, "principal-run-1");
  insertRun(seedDatabase, "principal-run-2");
  seedDatabase.close();

  const connectionA = new BetterSqlite3(filename);
  connectionA.pragma("foreign_keys = ON");
  const databaseA = new StorageDatabase(filename, connectionA);

  const connectionB = new BetterSqlite3(filename);
  connectionB.pragma("foreign_keys = ON");
  const databaseB = new StorageDatabase(filename, connectionB);

  return {
    repoA: new SqliteWorkerRunRepo(databaseA),
    repoB: new SqliteWorkerRunRepo(databaseB),
    close: () => {
      databaseA.close();
      databaseB.close();
    }
  };
}

function createWorkerRun(overrides: Partial<DelegatedWorkerRun> = {}): DelegatedWorkerRun {
  return {
    worker_run_id: overrides.worker_run_id ?? "worker-run-1",
    principal_run_id: overrides.principal_run_id ?? "principal-run-1",
    workspace_id: overrides.workspace_id ?? "ws-serial-delegation",
    requesting_run_id: overrides.requesting_run_id ?? overrides.principal_run_id ?? "principal-run-1",
    engine_class: overrides.engine_class ?? "coding_engine",
    state: overrides.state ?? "active",
    subtask_description: overrides.subtask_description ?? "Inspect the failing subtask.",
    local_surface_ref: overrides.local_surface_ref ?? "surface://principal/1",
    local_evidence_pointer: overrides.local_evidence_pointer ?? "evidence://principal/1",
    restricted_tool_set: overrides.restricted_tool_set ?? ["read_file", "exec_shell"],
    local_budget: overrides.local_budget ?? {
      max_worker_delegations: 1,
      max_tool_calls: 4,
      max_output_tokens: 2048,
      max_wall_time_ms: 120000
    },
    agreed_return_format: overrides.agreed_return_format ?? {
      allowed_return_kinds: ["analysis_note", "verification_result"],
      requires_structured_summary: true
    },
    principal_security_snapshot: overrides.principal_security_snapshot ?? {
      governance_lease_ref: "lease://principal/1",
      hard_constraint_refs: ["constraint://1"],
      denied_tool_categories: ["network"]
    },
    created_at: overrides.created_at ?? "2026-04-13T10:00:00.000Z",
    updated_at: overrides.updated_at ?? "2026-04-13T10:00:00.000Z"
  };
}

function seedWorkspace(database: StorageDatabase): void {
  database.connection
    .prepare(
      `INSERT OR IGNORE INTO workspaces (
        workspace_id, name, root_path, workspace_kind, default_engine_binding, workspace_state, created_at, archived_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      "ws-serial-delegation",
      "Serial Delegation",
      "/tmp/serial-delegation",
      "local_repo",
      null,
      "active",
      "2026-04-13T00:00:00.000Z",
      null
    );
}

function insertRun(database: StorageDatabase, runId: string): void {
  database.connection
    .prepare(
      `INSERT INTO runs (
        run_id, workspace_id, title, goal, run_mode, engine_binding_id, run_state, current_surface_id, created_at, last_active_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      runId,
      "ws-serial-delegation",
      `Run ${runId}`,
      null,
      "build",
      null,
      "idle",
      null,
      "2026-04-13T00:00:00.000Z",
      "2026-04-13T00:00:00.000Z"
    );
}
