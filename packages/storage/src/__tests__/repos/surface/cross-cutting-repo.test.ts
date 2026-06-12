import { afterEach, describe, expect, it } from "vitest";
import {
  CrossCuttingState,
  SurfaceEventType,
  SurfaceStatus,
  WorkspaceKind,
  WorkspaceState,
  type CrossCuttingPermission
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../../../sqlite/db.js";
import { SqliteCrossCuttingPermissionRepo } from "../../../repos/surface/cross-cutting-repo.js";
import { SqliteSurfaceIdentityRepo } from "../../../repos/surface/surface-identity-repo.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

const SURFACE_OBJECT_ID_1 = "11111111-1111-4111-8111-111111111111";

const PERMISSION_ID_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const PERMISSION_ID_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createPermission(overrides: Partial<CrossCuttingPermission> = {}): CrossCuttingPermission {
  return {
    object_id: "claim://object-1",
    object_kind: "cross_cutting_permission",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-22T00:00:00.000Z",
    updated_at: "2026-03-22T00:00:00.000Z",
    created_by: "user",
    cross_cutting_state: CrossCuttingState.NONE,
    allowed_surfaces: [],
    workspace_id: "workspace-1",
    ...overrides
  };
}

describe("SqliteCrossCuttingPermissionRepo", () => {
  it("applies migration 013", async () => {
    const { database } = await createRepo();

    const migration = database.connection
      .prepare("SELECT version FROM schema_version WHERE version = 13 LIMIT 1")
      .get() as { readonly version: number } | undefined;

    expect(migration?.version).toBe(13);
  });

  it("creates and finds permission by object_id and permission_id", async () => {
    const { repo } = await createRepo();
    const permission = createPermission();

    await expect(repo.create(permission, PERMISSION_ID_1)).resolves.toMatchObject({
      permission_id: PERMISSION_ID_1,
      permission
    });

    await expect(repo.findByObjectId(permission.object_id, permission.workspace_id)).resolves.toMatchObject({
      permission_id: PERMISSION_ID_1,
      permission
    });

    await expect(repo.findByPermissionId(PERMISSION_ID_1)).resolves.toMatchObject({
      permission_id: PERMISSION_ID_1,
      permission
    });
  });

  it("enforces one permission per object/workspace", async () => {
    const { repo } = await createRepo();

    await repo.create(createPermission({ object_id: "claim://object-1" }), PERMISSION_ID_1);

    await expect(
      repo.create(createPermission({ object_id: "claim://object-1" }), PERMISSION_ID_2)
    ).rejects.toMatchObject({ code: "QUERY_FAILED" });
  });

  it("updates state and allowed_surfaces", async () => {
    const { repo } = await createRepo();

    await repo.create(createPermission(), PERMISSION_ID_1);

    const updated = await repo.updateState(
      PERMISSION_ID_1,
      CrossCuttingState.ACTIVE,
      ["surface://main", "surface://secondary"],
      "2026-03-22T01:00:00.000Z"
    );

    expect(updated.permission.cross_cutting_state).toBe(CrossCuttingState.ACTIVE);
    expect(updated.permission.allowed_surfaces).toEqual(["surface://main", "surface://secondary"]);
    expect(updated.permission.updated_at).toBe("2026-03-22T01:00:00.000Z");
  });

  it("creates permission and event atomically with revision allocated in transaction", async () => {
    const { database, repo } = await createRepo();

    const result = await repo.createWithEvent(createPermission(), PERMISSION_ID_1, {
      event_type: SurfaceEventType.SOUL_CROSS_CUTTING_STATE_CHANGED,
      entity_type: "cross_cutting_permission",
      entity_id: PERMISSION_ID_1,
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "user",
      payload_json: {
        permission_id: PERMISSION_ID_1,
        object_id: "claim://object-1",
        from_state: null,
        to_state: CrossCuttingState.NONE,
        allowed_surfaces: [],
        reason: "initialized",
        occurred_at: "2026-03-22T00:00:00.000Z",
        workspace_id: "workspace-1"
      }
    });

    expect(result.record.permission_id).toBe(PERMISSION_ID_1);
    expect(result.event.event_type).toBe(SurfaceEventType.SOUL_CROSS_CUTTING_STATE_CHANGED);
    expect(result.event.revision).toBe(0);

    const eventCount = database.connection
      .prepare("SELECT COUNT(*) AS count FROM event_log WHERE entity_id = ?")
      .get(PERMISSION_ID_1) as { readonly count: number };

    expect(eventCount.count).toBe(1);
  });

  it("increments revisions when multiple events are written for the same permission", async () => {
    const { repo } = await createRepo();

    const created = await repo.createWithEvent(createPermission(), PERMISSION_ID_1, {
      event_type: SurfaceEventType.SOUL_CROSS_CUTTING_STATE_CHANGED,
      entity_type: "cross_cutting_permission",
      entity_id: PERMISSION_ID_1,
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "user",
      payload_json: {
        permission_id: PERMISSION_ID_1,
        object_id: "claim://object-1",
        from_state: null,
        to_state: CrossCuttingState.NONE,
        allowed_surfaces: [],
        reason: "initialized",
        occurred_at: "2026-03-22T00:00:00.000Z",
        workspace_id: "workspace-1"
      }
    });

    const updated = await repo.updateStateWithEvent(
      PERMISSION_ID_1,
      CrossCuttingState.ACTIVE,
      ["surface://main"],
      "2026-03-22T01:00:00.000Z",
      {
        event_type: SurfaceEventType.SOUL_CROSS_CUTTING_STATE_CHANGED,
        entity_type: "cross_cutting_permission",
        entity_id: PERMISSION_ID_1,
        workspace_id: "workspace-1",
        run_id: null,
        caused_by: "reviewer-1",
        payload_json: {
          permission_id: PERMISSION_ID_1,
          object_id: "claim://object-1",
          from_state: CrossCuttingState.NONE,
          to_state: CrossCuttingState.ACTIVE,
          allowed_surfaces: ["surface://main"],
          reason: "review_accepted",
          occurred_at: "2026-03-22T01:00:00.000Z",
          workspace_id: "workspace-1"
        }
      }
    );

    expect(created.event.revision).toBe(0);
    expect(updated.event.revision).toBe(1);
  });

  it("rolls back event_log insert when createWithEvent fails", async () => {
    const { database, repo } = await createRepo();

    await repo.create(createPermission({ object_id: "claim://object-1" }), PERMISSION_ID_1);

    await expect(
      repo.createWithEvent(createPermission({ object_id: "claim://object-1" }), PERMISSION_ID_2, {
        event_type: SurfaceEventType.SOUL_CROSS_CUTTING_STATE_CHANGED,
        entity_type: "cross_cutting_permission",
        entity_id: PERMISSION_ID_2,
        workspace_id: "workspace-1",
        run_id: null,
        caused_by: "user",
        payload_json: {
          permission_id: PERMISSION_ID_2,
          object_id: "claim://object-1",
          from_state: null,
          to_state: CrossCuttingState.NONE,
          allowed_surfaces: [],
          reason: "initialized",
          occurred_at: "2026-03-22T00:00:00.000Z",
          workspace_id: "workspace-1"
        }
      })
    ).rejects.toMatchObject({ code: "QUERY_FAILED" });

    const eventCount = database.connection
      .prepare("SELECT COUNT(*) AS count FROM event_log WHERE entity_id = ?")
      .get(PERMISSION_ID_2) as { readonly count: number };

    expect(eventCount.count).toBe(0);
  });

  it("rejects malformed allowed_surfaces JSON when reading rows", async () => {
    const { database, repo } = await createRepo();

    database.connection
      .prepare(
        `
        INSERT INTO cross_cutting_permissions (
          permission_id, object_kind, schema_version, lifecycle_state,
          created_at, updated_at, created_by,
          object_id, cross_cutting_state, allowed_surfaces, workspace_id
        ) VALUES (?, 'cross_cutting_permission', 1, 'active', ?, ?, 'user', ?, 'none', ?, ?)
      `
      )
      .run(
        PERMISSION_ID_1,
        "2026-03-22T00:00:00.000Z",
        "2026-03-22T00:00:00.000Z",
        "claim://object-1",
        "{",
        "workspace-1"
      );

    await expect(repo.findByPermissionId(PERMISSION_ID_1)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Failed to parse allowed_surfaces JSON."
    });
  });

  it("rejects invalid allowed_surfaces URI values when reading rows", async () => {
    const { database, repo } = await createRepo();

    database.connection
      .prepare(
        `
        INSERT INTO cross_cutting_permissions (
          permission_id, object_kind, schema_version, lifecycle_state,
          created_at, updated_at, created_by,
          object_id, cross_cutting_state, allowed_surfaces, workspace_id
        ) VALUES (?, 'cross_cutting_permission', 1, 'active', ?, ?, 'user', ?, 'active', ?, ?)
      `
      )
      .run(
        PERMISSION_ID_1,
        "2026-03-22T00:00:00.000Z",
        "2026-03-22T00:00:00.000Z",
        "claim://object-1",
        '["not-a-surface-uri"]',
        "workspace-1"
      );

    await expect(repo.findByPermissionId(PERMISSION_ID_1)).rejects.toMatchObject({
      code: "VALIDATION_FAILED",
      message: "Failed to validate allowed_surfaces."
    });
  });

  it("lists permissions by workspace", async () => {
    const { repo } = await createRepo();

    await repo.create(createPermission({ object_id: "claim://object-1" }), PERMISSION_ID_1);
    await repo.create(
      createPermission({
        object_id: "claim://object-2",
        created_at: "2026-03-22T00:00:01.000Z",
        updated_at: "2026-03-22T00:00:01.000Z"
      }),
      PERMISSION_ID_2
    );

    const permissions = await repo.findByWorkspace("workspace-1");

    expect(permissions).toHaveLength(2);
    expect(permissions.map((record) => record.permission_id)).toEqual([PERMISSION_ID_1, PERMISSION_ID_2]);
  });

  it("throws NOT_FOUND when updating missing permission", async () => {
    const { repo } = await createRepo();

    await expect(
      repo.updateState(
        PERMISSION_ID_1,
        CrossCuttingState.CANDIDATE,
        [],
        "2026-03-22T01:00:00.000Z"
      )
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

async function createRepo(): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteCrossCuttingPermissionRepo;
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

  return {
    database,
    repo: new SqliteCrossCuttingPermissionRepo(database)
  };
}
