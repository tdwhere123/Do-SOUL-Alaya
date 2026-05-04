import { afterEach, describe, expect, it } from "vitest";
import { SurfaceEventType, SurfaceAnchorKind, SurfaceStatus, WorkspaceKind, WorkspaceState, type SurfaceAnchor } from "@do-soul/alaya-protocol";
import { initDatabase } from "../db.js";
import { SqliteSurfaceAnchorRepo } from "../repos/surface-anchor-repo.js";
import { SqliteSurfaceIdentityRepo } from "../repos/surface-identity-repo.js";
import { SqliteWorkspaceRepo } from "../repos/workspace-repo.js";

const SURFACE_OBJECT_ID = "11111111-1111-4111-8111-111111111111";
const ANCHOR_OBJECT_ID_1 = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const ANCHOR_OBJECT_ID_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createSurfaceAnchor(overrides: Partial<SurfaceAnchor> = {}): SurfaceAnchor {
  return {
    object_id: ANCHOR_OBJECT_ID_1,
    object_kind: "surface_anchor",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user",
    surface_id: "surface://main",
    anchor_kind: SurfaceAnchorKind.PATH_FRAGMENT,
    anchor_value: "apps/core-daemon/src",
    workspace_id: "workspace-1",
    ...overrides
  };
}

describe("SqliteSurfaceAnchorRepo", () => {
  it("applies migration 012 and creates surface tables", async () => {
    const { database } = await createRepo();

    const migration = database.connection
      .prepare("SELECT version FROM schema_version WHERE version = 12 LIMIT 1")
      .get() as { readonly version: number } | undefined;

    expect(migration?.version).toBe(12);
  });

  it("creates and finds anchor by id", async () => {
    const { anchorRepo } = await createRepo();
    const anchor = createSurfaceAnchor();

    await expect(anchorRepo.create(anchor)).resolves.toEqual(anchor);
    await expect(anchorRepo.findById(anchor.object_id)).resolves.toEqual(anchor);
  });

  it("creates anchor and event atomically with revision allocated in transaction", async () => {
    const { database, anchorRepo } = await createRepo();

    const created = await anchorRepo.createWithEvent(createSurfaceAnchor(), {
      event_type: SurfaceEventType.SOUL_SURFACE_ANCHOR_CREATED,
      entity_type: "surface_anchor",
      entity_id: ANCHOR_OBJECT_ID_1,
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "user",
      payload_json: {
        object_id: ANCHOR_OBJECT_ID_1,
        object_kind: "surface_anchor",
        workspace_id: "workspace-1",
        run_id: null,
        surface_id: "surface://main",
        anchor_kind: SurfaceAnchorKind.PATH_FRAGMENT,
        anchor_value: "apps/core-daemon/src"
      }
    });

    expect(created.event.revision).toBe(0);

    const eventCount = database.connection
      .prepare("SELECT COUNT(*) AS count FROM event_log WHERE entity_id = ?")
      .get(ANCHOR_OBJECT_ID_1) as { readonly count: number };

    expect(eventCount.count).toBe(1);
  });

  it("increments revisions when create and delete events target the same anchor", async () => {
    const { anchorRepo } = await createRepo();

    const created = await anchorRepo.createWithEvent(createSurfaceAnchor(), {
      event_type: SurfaceEventType.SOUL_SURFACE_ANCHOR_CREATED,
      entity_type: "surface_anchor",
      entity_id: ANCHOR_OBJECT_ID_1,
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "user",
      payload_json: {
        object_id: ANCHOR_OBJECT_ID_1,
        object_kind: "surface_anchor",
        workspace_id: "workspace-1",
        run_id: null,
        surface_id: "surface://main",
        anchor_kind: SurfaceAnchorKind.PATH_FRAGMENT,
        anchor_value: "apps/core-daemon/src"
      }
    });

    const deleted = await anchorRepo.deleteWithEvent(ANCHOR_OBJECT_ID_1, {
      event_type: SurfaceEventType.SOUL_SURFACE_ANCHOR_DELETED,
      entity_type: "surface_anchor",
      entity_id: ANCHOR_OBJECT_ID_1,
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "reviewer-1",
      payload_json: {
        anchor_id: ANCHOR_OBJECT_ID_1,
        surface_id: "surface://main",
        workspace_id: "workspace-1"
      }
    });

    expect(created.event.revision).toBe(0);
    expect(deleted.revision).toBe(1);
  });

  it("lists anchors by surface", async () => {
    const { anchorRepo } = await createRepo();

    await anchorRepo.create(createSurfaceAnchor({ object_id: ANCHOR_OBJECT_ID_1 }));
    await anchorRepo.create(
      createSurfaceAnchor({
        object_id: ANCHOR_OBJECT_ID_2,
        anchor_kind: SurfaceAnchorKind.ARTIFACT_REF,
        anchor_value: "proposal://abc",
        created_at: "2026-03-21T00:00:01.000Z",
        updated_at: "2026-03-21T00:00:01.000Z"
      })
    );

    const anchors = await anchorRepo.findBySurfaceId("surface://main", "workspace-1");

    expect(anchors).toHaveLength(2);
    expect(anchors.map((anchor) => anchor.object_id)).toEqual([ANCHOR_OBJECT_ID_1, ANCHOR_OBJECT_ID_2]);
  });

  it("deletes anchor", async () => {
    const { anchorRepo } = await createRepo();

    await anchorRepo.create(createSurfaceAnchor({ object_id: ANCHOR_OBJECT_ID_1 }));
    await anchorRepo.delete(ANCHOR_OBJECT_ID_1);

    await expect(anchorRepo.findById(ANCHOR_OBJECT_ID_1)).resolves.toBeNull();
  });

  it("throws NOT_FOUND when deleting missing anchor", async () => {
    const { anchorRepo } = await createRepo();

    await expect(anchorRepo.delete(ANCHOR_OBJECT_ID_1)).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });

  it("cascades anchor deletion when parent surface is deleted", async () => {
    const { database, anchorRepo } = await createRepo();

    await anchorRepo.create(createSurfaceAnchor({ object_id: ANCHOR_OBJECT_ID_1 }));

    database.connection.prepare("DELETE FROM surface_identities WHERE object_id = ?").run(SURFACE_OBJECT_ID);

    await expect(anchorRepo.findById(ANCHOR_OBJECT_ID_1)).resolves.toBeNull();
  });
});

async function createRepo(): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly anchorRepo: SqliteSurfaceAnchorRepo;
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
    object_id: SURFACE_OBJECT_ID,
    object_kind: "surface_identity",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user",
    surface_id: "surface://main",
    surface_kind: "conversation",
    surface_status: SurfaceStatus.ACTIVE,
    workspace_id: "workspace-1"
  });

  return {
    database,
    anchorRepo: new SqliteSurfaceAnchorRepo(database)
  };
}
