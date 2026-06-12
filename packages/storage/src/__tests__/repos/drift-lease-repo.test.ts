import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { WorkspaceKind, WorkspaceState, type GovernanceDriftLease } from "@do-soul/alaya-protocol";
import { initDatabase } from "../../sqlite/db.js";
import { SqliteDriftLeaseRepo } from "../../repos/drift-lease-repo.js";
import { SqliteWorkspaceRepo } from "../../repos/runtime/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createLease(overrides: Partial<GovernanceDriftLease> = {}): GovernanceDriftLease {
  return {
    lease_id: "lease-1",
    workspace_id: "workspace-1",
    operation_type: "surface.bind_object",
    granted_to: "user",
    drift_id: "drift-1",
    expires_at: "2026-04-20T08:05:00.000Z",
    granted_at: "2026-04-20T08:00:00.000Z",
    ...overrides
  };
}

describe("SqliteDriftLeaseRepo", () => {
  it("applies drift lease migrations", async () => {
    const { database } = await createRepo();

    const versions = database.connection
      .prepare("SELECT version FROM schema_version WHERE version IN (45, 47) ORDER BY version ASC")
      .all() as Array<{ readonly version: number }>;

    expect(versions.map((row) => row.version)).toEqual([45, 47]);
  });

  it("creates indexes for active lookup and expiry cleanup query shapes", async () => {
    const { database } = await createRepo();

    const indexes = database.connection
      .prepare("PRAGMA index_list('drift_leases')")
      .all() as Array<{ readonly name: string }>;
    const indexNames = indexes.map((index) => index.name);

    expect(indexNames).toEqual(
      expect.arrayContaining([
        "idx_drift_leases_workspace_expires",
        "idx_drift_leases_expires",
        "idx_drift_leases_workspace_operation"
      ])
    );

    const activeLookupPlan = database.connection
      .prepare(
        `
          EXPLAIN QUERY PLAN
          SELECT lease_id
          FROM drift_leases
          WHERE workspace_id = ? AND expires_at > ?
          ORDER BY granted_at ASC, lease_id ASC
        `
      )
      .all("workspace-1", "2026-04-20T08:00:00.000Z") as Array<{ readonly detail: string }>;
    const cleanupPlan = database.connection
      .prepare(
        `
          EXPLAIN QUERY PLAN
          DELETE FROM drift_leases
          WHERE expires_at <= ?
        `
      )
      .all("2026-04-20T08:00:00.000Z") as Array<{ readonly detail: string }>;

    expect(activeLookupPlan.some((row) => row.detail.includes("idx_drift_leases_workspace_expires"))).toBe(true);
    expect(cleanupPlan.some((row) => row.detail.includes("idx_drift_leases_expires"))).toBe(true);
  });

  it("creates and lists active leases for a workspace", async () => {
    const { repo } = await createRepo({
      now: () => "2026-04-20T08:00:00.000Z"
    });

    const created = await repo.create(createLease());
    expect(created.lease_id).toBe("lease-1");

    await repo.create(
      createLease({
        lease_id: "lease-expired",
        operation_type: "surface.rename_object",
        expires_at: "2026-04-20T07:59:59.000Z"
      })
    );

    const active = await repo.findActive("workspace-1");
    expect(active.map((lease) => lease.lease_id)).toEqual(["lease-1"]);
  });

  it("looks up an active lease by workspace and lease id without scanning the full workspace set", async () => {
    const { repo } = await createRepo({
      now: () => "2026-04-20T08:00:00.000Z"
    });

    await repo.create(createLease());
    await repo.create(
      createLease({
        lease_id: "lease-2",
        operation_type: "surface.rename_object",
        granted_to: "other-user"
      })
    );

    await expect(repo.findActiveById("workspace-1", "lease-1")).resolves.toMatchObject({
      lease_id: "lease-1",
      granted_to: "user"
    });
    await expect(repo.findActiveById("workspace-1", "missing")).resolves.toBeNull();
  });

  it("deletes leases by id", async () => {
    const { repo } = await createRepo();
    await repo.create(createLease());

    await repo.delete("lease-1");

    await expect(repo.findActive("workspace-1")).resolves.toEqual([]);
  });

  it("cascades delete when the owning workspace is removed", async () => {
    const { repo, database } = await createRepo();
    await repo.create(createLease());

    const workspaceRepo = new SqliteWorkspaceRepo(database);
    await workspaceRepo.delete("workspace-1");

    const remaining = database.connection
      .prepare("SELECT COUNT(*) AS count FROM drift_leases WHERE workspace_id = ?")
      .get("workspace-1") as { readonly count: number };
    expect(remaining.count).toBe(0);
  });

  it("deleteExpired removes stale rows and returns affected count", async () => {
    const { repo } = await createRepo({
      now: () => "2026-04-20T08:00:00.000Z"
    });
    await repo.create(
      createLease({
        lease_id: "lease-stale",
        expires_at: "2026-04-20T07:55:00.000Z"
      })
    );
    await repo.create(
      createLease({
        lease_id: "lease-fresh",
        operation_type: "surface.rename_object",
        expires_at: "2026-04-20T08:15:00.000Z"
      })
    );

    const deleted = await repo.deleteExpired("2026-04-20T08:00:00.000Z");
    expect(deleted).toBe(1);

    const remaining = await repo.findActive("workspace-1");
    expect(remaining.map((lease) => lease.lease_id)).toEqual(["lease-fresh"]);
  });

  it("rejects concurrent active leases for the same workspace and operation", async () => {
    const { repo } = await createRepo({
      now: () => "2026-04-20T08:00:00.000Z"
    });

    const [firstResult, secondResult] = await Promise.allSettled([
      Promise.resolve().then(() => repo.create(createLease({ lease_id: "lease-1", granted_to: "user-1" }))),
      Promise.resolve().then(() => repo.create(createLease({ lease_id: "lease-2", granted_to: "user-2" })))
    ]);

    expect(firstResult.status).toBe("fulfilled");
    expect(secondResult.status).toBe("rejected");
    if (secondResult.status === "rejected") {
      expect(secondResult.reason).toMatchObject({
        code: "CONFLICT"
      });
    }

    const active = await repo.findActive("workspace-1");
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({
      lease_id: "lease-1",
      operation_type: "surface.bind_object",
      granted_to: "user-1"
    });
  });

  it("migration 047 preserves the active lease when deduping an expired and active duplicate", async () => {
    const { database } = await createRepo();

    database.connection.prepare("DROP INDEX idx_drift_leases_workspace_operation").run();
    database.connection
      .prepare(
        `
          INSERT INTO drift_leases (
            lease_id,
            workspace_id,
            operation_type,
            granted_to,
            drift_id,
            expires_at,
            granted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        "lease-expired",
        "workspace-1",
        "surface.bind_object",
        "user-1",
        "drift-1",
        "2020-04-20T07:55:00.000Z",
        "2020-04-20T07:50:00.000Z"
      );
    database.connection
      .prepare(
        `
          INSERT INTO drift_leases (
            lease_id,
            workspace_id,
            operation_type,
            granted_to,
            drift_id,
            expires_at,
            granted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `
      )
      .run(
        "lease-active",
        "workspace-1",
        "surface.bind_object",
        "user-2",
        "drift-2",
        "2099-04-20T08:05:00.000Z",
        "2099-04-20T08:00:00.000Z"
      );

    database.connection.exec(readFileSync(new URL("../../migrations/047-drift-lease-operation-unique.sql", import.meta.url), "utf8"));

    const remaining = database.connection
      .prepare(
        `
          SELECT lease_id, expires_at
          FROM drift_leases
          WHERE workspace_id = ? AND operation_type = ?
          ORDER BY granted_at ASC, lease_id ASC
        `
      )
      .all("workspace-1", "surface.bind_object") as Array<{
      readonly lease_id: string;
      readonly expires_at: string;
    }>;

    expect(remaining).toEqual([
      {
        lease_id: "lease-active",
        expires_at: "2099-04-20T08:05:00.000Z"
      }
    ]);
  });
});

async function createRepo(options: { readonly now?: () => string } = {}): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteDriftLeaseRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });

  return {
    database,
    repo: new SqliteDriftLeaseRepo(database, options)
  };
}
