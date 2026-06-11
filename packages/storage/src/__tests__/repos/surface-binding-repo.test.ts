import { afterEach, describe, expect, it } from "vitest";
import {
  BindingState,
  SurfaceStatus,
  WorkspaceKind,
  WorkspaceState,
  type SurfaceBinding
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../../db.js";
import { SqliteSurfaceBindingRepo } from "../../repos/surface-binding-repo.js";
import { SqliteSurfaceIdentityRepo } from "../../repos/surface-identity-repo.js";
import { SqliteWorkspaceRepo } from "../../repos/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

const SURFACE_OBJECT_ID_1 = "11111111-1111-4111-8111-111111111111";
const SURFACE_OBJECT_ID_2 = "22222222-2222-4222-8222-222222222222";

const BINDING_ID_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BINDING_ID_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const BINDING_ID_3 = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const BINDING_ID_4 = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createSurfaceBinding(overrides: Partial<SurfaceBinding> = {}): SurfaceBinding {
  return {
    object_id: "claim://object-1",
    object_kind: "surface_binding",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-22T00:00:00.000Z",
    updated_at: "2026-03-22T00:00:00.000Z",
    created_by: "user",
    surface_id: "surface://main",
    is_primary: true,
    binding_state: BindingState.ACTIVE,
    workspace_id: "workspace-1",
    ...overrides
  };
}

describe("SqliteSurfaceBindingRepo", () => {
  it("applies migration 013", async () => {
    const { database } = await createRepo();

    const migration = database.connection
      .prepare("SELECT version FROM schema_version WHERE version = 13 LIMIT 1")
      .get() as { readonly version: number } | undefined;

    expect(migration?.version).toBe(13);
  });

  it("creates and finds surface binding records", async () => {
    const { database, repo } = await createRepo();
    const binding = createSurfaceBinding();

    expect(repo.create(binding, BINDING_ID_1)).toMatchObject({
      binding_id: BINDING_ID_1,
      binding
    });

    await expect(repo.findByBindingId(BINDING_ID_1)).resolves.toMatchObject({
      binding_id: BINDING_ID_1,
      binding
    });

    await expect(repo.findByObjectId(binding.object_id, binding.workspace_id)).resolves.toHaveLength(1);
    await expect(repo.findPrimaryBinding(binding.object_id, binding.workspace_id)).resolves.toMatchObject({
      binding_id: BINDING_ID_1
    });
    expect(countSurfaceBindingEvents(database)).toBe(0);
  });

  it("coerces is_primary INTEGER into boolean", async () => {
    const { database, repo } = await createRepo();

    database.connection
      .prepare(
        `
        INSERT INTO surface_bindings (
          binding_id, object_kind, schema_version, lifecycle_state,
          created_at, updated_at, created_by,
          object_id, surface_id, is_primary, binding_state, workspace_id
        ) VALUES (?, 'surface_binding', 1, 'active', ?, ?, 'user', ?, ?, 1, 'active', ?)
      `
      )
      .run(
        BINDING_ID_1,
        "2026-03-22T00:00:00.000Z",
        "2026-03-22T00:00:00.000Z",
        "claim://object-1",
        "surface://main",
        "workspace-1"
      );

    const found = await repo.findByBindingId(BINDING_ID_1);

    expect(found).not.toBeNull();
    expect(found?.binding.is_primary).toBe(true);
  });

  it("enforces one primary binding per object/workspace", async () => {
    const { repo } = await createRepo();

    await repo.create(createSurfaceBinding({ surface_id: "surface://main", is_primary: true }), BINDING_ID_1);

    expect(() =>
      repo.create(
        createSurfaceBinding({ surface_id: "surface://secondary", is_primary: true }),
        BINDING_ID_2
      )
    ).toThrowError(expect.objectContaining({ code: "QUERY_FAILED" }));
  });

  it("findDetachableBySurfaceId excludes detached bindings", async () => {
    const { repo } = await createRepo();

    await repo.create(createSurfaceBinding({ binding_state: BindingState.ACTIVE }), BINDING_ID_1);
    await repo.create(
      createSurfaceBinding({ object_id: "claim://object-2", is_primary: false, binding_state: BindingState.DETACHED }),
      BINDING_ID_2
    );

    const detachable = await repo.findDetachableBySurfaceId("surface://main", "workspace-1");

    expect(detachable.map((record) => record.binding_id)).toEqual([BINDING_ID_1]);
  });

  it("updates binding state and throws NOT_FOUND for missing binding", async () => {
    const { database, repo } = await createRepo();

    await repo.create(createSurfaceBinding(), BINDING_ID_1);

    const updated = await repo.updateState(
      BINDING_ID_1,
      BindingState.STALE,
      "2026-03-22T01:00:00.000Z"
    );

    expect(updated.binding.binding_state).toBe(BindingState.STALE);
    expect(updated.binding.updated_at).toBe("2026-03-22T01:00:00.000Z");

    expect(() =>
      repo.updateState(BINDING_ID_2, BindingState.ACTIVE, "2026-03-22T01:00:00.000Z")
    ).toThrowError(expect.objectContaining({ code: "NOT_FOUND" }));
    expect(countSurfaceBindingEvents(database)).toBe(0);
  });

  it("cascadeDetachBySurfaceId detaches active/stale bindings only", async () => {
    const { database, repo } = await createRepo();

    await repo.create(
      createSurfaceBinding({ object_id: "claim://object-1", surface_id: "surface://main", binding_state: BindingState.ACTIVE }),
      BINDING_ID_1
    );
    await repo.create(
      createSurfaceBinding({ object_id: "claim://object-2", surface_id: "surface://main", is_primary: false, binding_state: BindingState.STALE }),
      BINDING_ID_2
    );
    await repo.create(
      createSurfaceBinding({ object_id: "claim://object-3", surface_id: "surface://main", is_primary: false, binding_state: BindingState.DETACHED }),
      BINDING_ID_3
    );
    await repo.create(
      createSurfaceBinding({ object_id: "claim://object-4", surface_id: "surface://secondary", is_primary: false, binding_state: BindingState.ACTIVE }),
      BINDING_ID_4
    );

    const detached = await repo.cascadeDetachBySurfaceId(
      "surface://main",
      "workspace-1",
      "2026-03-22T02:00:00.000Z"
    );

    expect(detached).toHaveLength(2);
    expect(detached.map((record) => record.binding_id)).toEqual([BINDING_ID_1, BINDING_ID_2]);
    for (const record of detached) {
      expect(record.binding.binding_state).toBe(BindingState.DETACHED);
      expect(record.binding.updated_at).toBe("2026-03-22T02:00:00.000Z");
    }

    const untouched = await repo.findByBindingId(BINDING_ID_4);
    expect(untouched?.binding.binding_state).toBe(BindingState.ACTIVE);
    expect(countSurfaceBindingEvents(database)).toBe(0);
  });
});

async function createRepo(): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteSurfaceBindingRepo;
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

  const surfaceIdentityRepo = new SqliteSurfaceIdentityRepo(database);

  await surfaceIdentityRepo.create({
    object_id: SURFACE_OBJECT_ID_1,
    object_kind: "surface_identity",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-22T00:00:00.000Z",
    updated_at: "2026-03-22T00:00:00.000Z",
    created_by: "user",
    surface_id: "surface://main",
    surface_kind: "conversation",
    surface_status: SurfaceStatus.ACTIVE,
    workspace_id: "workspace-1"
  });

  await surfaceIdentityRepo.create({
    object_id: SURFACE_OBJECT_ID_2,
    object_kind: "surface_identity",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-22T00:00:00.000Z",
    updated_at: "2026-03-22T00:00:00.000Z",
    created_by: "user",
    surface_id: "surface://secondary",
    surface_kind: "conversation",
    surface_status: SurfaceStatus.ACTIVE,
    workspace_id: "workspace-1"
  });

  return {
    database,
    repo: new SqliteSurfaceBindingRepo(database)
  };
}

function countSurfaceBindingEvents(database: ReturnType<typeof initDatabase>): number {
  return (
    database.connection
      .prepare("SELECT COUNT(*) AS count FROM event_log WHERE entity_type = 'surface_binding'")
      .get() as { readonly count: number }
  ).count;
}
