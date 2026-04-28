import { afterEach, describe, expect, it } from "vitest";
import { Phase2BEventType, SurfaceStatus, WorkspaceKind, WorkspaceState, type SurfaceIdentity } from "@do-soul/alaya-protocol";
import { initDatabase } from "../db.js";
import { SqliteSurfaceIdentityRepo } from "../repos/surface-identity-repo.js";
import { SqliteWorkspaceRepo } from "../repos/workspace-repo.js";

const SURFACE_OBJECT_ID_1 = "11111111-1111-4111-8111-111111111111";
const SURFACE_OBJECT_ID_2 = "22222222-2222-4222-8222-222222222222";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createSurfaceIdentity(overrides: Partial<SurfaceIdentity> = {}): SurfaceIdentity {
  return {
    object_id: SURFACE_OBJECT_ID_1,
    object_kind: "surface_identity",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user",
    surface_id: "surface://main",
    surface_kind: "conversation",
    surface_status: SurfaceStatus.ACTIVE,
    workspace_id: "workspace-1",
    ...overrides
  };
}

describe("SqliteSurfaceIdentityRepo", () => {
  it("applies migration 012 and creates surface tables", async () => {
    const { database } = await createRepo();

    const migration = database.connection
      .prepare("SELECT version FROM schema_version WHERE version = 12 LIMIT 1")
      .get() as { readonly version: number } | undefined;

    expect(migration?.version).toBe(12);
  });

  it("creates and finds surface identity by id", async () => {
    const { repo } = await createRepo();
    const identity = createSurfaceIdentity();

    await expect(repo.create(identity)).resolves.toEqual(identity);
    await expect(repo.findById(identity.object_id)).resolves.toEqual(identity);
  });

  it("creates identity and event atomically with revision allocated in transaction", async () => {
    const { database, repo } = await createRepo();

    const created = await repo.createWithEvent(createSurfaceIdentity(), {
      event_type: Phase2BEventType.SOUL_SURFACE_CREATED,
      entity_type: "surface_identity",
      entity_id: SURFACE_OBJECT_ID_1,
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "user",
      payload_json: {
        object_id: SURFACE_OBJECT_ID_1,
        object_kind: "surface_identity",
        workspace_id: "workspace-1",
        run_id: null,
        surface_id: "surface://main",
        surface_kind: "conversation",
        surface_status: SurfaceStatus.ACTIVE
      }
    });

    expect(created.event.revision).toBe(0);

    const eventCount = database.connection
      .prepare("SELECT COUNT(*) AS count FROM event_log WHERE entity_id = ?")
      .get(SURFACE_OBJECT_ID_1) as { readonly count: number };

    expect(eventCount.count).toBe(1);
  });

  it("increments revisions when multiple events are written for the same surface", async () => {
    const { repo } = await createRepo();

    const created = await repo.createWithEvent(createSurfaceIdentity(), {
      event_type: Phase2BEventType.SOUL_SURFACE_CREATED,
      entity_type: "surface_identity",
      entity_id: SURFACE_OBJECT_ID_1,
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "user",
      payload_json: {
        object_id: SURFACE_OBJECT_ID_1,
        object_kind: "surface_identity",
        workspace_id: "workspace-1",
        run_id: null,
        surface_id: "surface://main",
        surface_kind: "conversation",
        surface_status: SurfaceStatus.ACTIVE
      }
    });

    const updated = await repo.updateStatusWithEvent(
      SURFACE_OBJECT_ID_1,
      SurfaceStatus.WEAKLY_BOUND,
      "2026-03-21T01:00:00.000Z",
      {
        event_type: Phase2BEventType.SOUL_SURFACE_STATUS_CHANGED,
        entity_type: "surface_identity",
        entity_id: SURFACE_OBJECT_ID_1,
        workspace_id: "workspace-1",
        run_id: null,
        caused_by: "system",
        payload_json: {
          object_id: SURFACE_OBJECT_ID_1,
          object_kind: "surface_identity",
          workspace_id: "workspace-1",
          run_id: null,
          surface_id: "surface://main",
          from_status: SurfaceStatus.ACTIVE,
          to_status: SurfaceStatus.WEAKLY_BOUND,
          reason_code: "anchor_degradation",
          caused_by: "system",
          occurred_at: "2026-03-21T01:00:00.000Z"
        }
      }
    );

    expect(created.event.revision).toBe(0);
    expect(updated.event.revision).toBe(1);
  });

  it("finds by surface id and workspace", async () => {
    const { repo } = await createRepo();
    const identity = createSurfaceIdentity();

    await repo.create(identity);

    await expect(repo.findBySurfaceId(identity.surface_id, identity.workspace_id)).resolves.toEqual(identity);
    await expect(repo.findBySurfaceId("surface://missing", identity.workspace_id)).resolves.toBeNull();
  });

  it("enforces unique (surface_id, workspace_id)", async () => {
    const { repo } = await createRepo();

    await repo.create(createSurfaceIdentity({ object_id: SURFACE_OBJECT_ID_1 }));

    await expect(
      repo.create(
        createSurfaceIdentity({
          object_id: SURFACE_OBJECT_ID_2
        })
      )
    ).rejects.toMatchObject({
      code: "QUERY_FAILED"
    });
  });

  it("lists identities by workspace", async () => {
    const { repo } = await createRepo();

    await repo.create(createSurfaceIdentity({ object_id: SURFACE_OBJECT_ID_1, surface_id: "surface://a" }));
    await repo.create(
      createSurfaceIdentity({
        object_id: SURFACE_OBJECT_ID_2,
        surface_id: "surface://b",
        created_at: "2026-03-21T00:00:01.000Z",
        updated_at: "2026-03-21T00:00:01.000Z"
      })
    );

    const identities = await repo.findByWorkspace("workspace-1");

    expect(identities).toHaveLength(2);
    expect(identities.map((identity) => identity.object_id)).toEqual([
      SURFACE_OBJECT_ID_1,
      SURFACE_OBJECT_ID_2
    ]);
  });

  it("updates status", async () => {
    const { repo } = await createRepo();

    await repo.create(createSurfaceIdentity({ object_id: SURFACE_OBJECT_ID_1 }));

    const updated = await repo.updateStatus(
      SURFACE_OBJECT_ID_1,
      SurfaceStatus.WEAKLY_BOUND,
      "2026-03-21T01:00:00.000Z"
    );

    expect(updated.surface_status).toBe(SurfaceStatus.WEAKLY_BOUND);
    expect(updated.updated_at).toBe("2026-03-21T01:00:00.000Z");
  });

  it("throws NOT_FOUND when updateStatus target does not exist", async () => {
    const { repo } = await createRepo();

    await expect(
      repo.updateStatus(SURFACE_OBJECT_ID_1, SurfaceStatus.WEAKLY_BOUND, "2026-03-21T01:00:00.000Z")
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });
});

async function createRepo(): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteSurfaceIdentityRepo;
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
    repo: new SqliteSurfaceIdentityRepo(database)
  };
}
