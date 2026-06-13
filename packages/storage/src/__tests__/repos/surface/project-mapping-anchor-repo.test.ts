import { afterEach, describe, expect, it } from "vitest";
import {
  ProjectMappingState,
  WorkspaceKind,
  WorkspaceState,
  type ProjectMappingAnchor
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../../../sqlite/db.js";
import { SqliteWorkspaceRepo } from "../../../repos/runtime/workspace-repo.js";

type AcceptedByValue = "user" | "review" | "deterministic_rule";
type ProjectMappingStateValue = (typeof ProjectMappingState)[keyof typeof ProjectMappingState];
type ProjectMappingAnchorRecord = ProjectMappingAnchor & {
  readonly accepted_by: AcceptedByValue | null;
  readonly last_transition_at: string;
};

interface ProjectMappingAnchorRepoLike {
  create(anchor: ProjectMappingAnchorRecord): Promise<void>;
  findById(objectId: string): Promise<Readonly<ProjectMappingAnchorRecord> | null>;
  findByIds(objectIds: readonly string[]): Promise<readonly Readonly<ProjectMappingAnchorRecord>[]>;
  findByWorkspace(
    workspaceId: string,
    state?: ProjectMappingStateValue
  ): Promise<readonly Readonly<ProjectMappingAnchorRecord>[]>;
  findByGlobalObjectId(
    globalObjectId: string,
    workspaceId: string
  ): Promise<Readonly<ProjectMappingAnchorRecord> | null>;
  updateState(
    objectId: string,
    newState: ProjectMappingStateValue,
    acceptedBy: AcceptedByValue | null,
    transitionedAt: string
  ): Promise<void>;
  listPending(workspaceId: string): Promise<readonly Readonly<ProjectMappingAnchorRecord>[]>;
}

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("SqliteProjectMappingAnchorRepo", () => {
  it("applies migrations 020 and 021, exports the repo, and removes the redundant index", async () => {
    const { database } = await createRepo();
    const storage = (await import("../../../index.js")) as Record<string, unknown>;

    expect(storage.SqliteProjectMappingAnchorRepo).toBeTypeOf("function");

    const versions = database.connection
      .prepare("SELECT version FROM schema_version WHERE version IN (20, 21) ORDER BY version ASC")
      .all() as ReadonlyArray<{ readonly version: number }>;
    const indexes = database.connection
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'project_mapping_anchors'")
      .all() as ReadonlyArray<{ readonly name: string }>;

    expect(versions.map((entry) => entry.version)).toEqual([20, 21]);
    expect(indexes.map((entry) => entry.name)).toContain("idx_pma_unique");
    expect(indexes.map((entry) => entry.name)).toContain("idx_pma_workspace");
    expect(indexes.map((entry) => entry.name)).not.toContain("idx_pma_global_obj");
  });

  it("creates and finds anchors by id and global object id", async () => {
    const { repo } = await createRepo();
    const anchor = createAnchor();

    await expect(repo.create(anchor)).resolves.toBeUndefined();
    await expect(repo.findById(anchor.object_id)).resolves.toEqual(anchor);
    await expect(repo.findByGlobalObjectId(anchor.global_object_id, anchor.workspace_id)).resolves.toEqual(anchor);
  });

  it("enforces one anchor per global object and workspace", async () => {
    const { repo } = await createRepo();

    await repo.create(createAnchor());

    await expect(
      repo.create(
        createAnchor({
          object_id: "22222222-2222-4222-8222-222222222222"
        })
      )
    ).rejects.toMatchObject({
      code: "QUERY_FAILED"
    });
  });

  it("lists anchors by workspace and optional state filter", async () => {
    const { repo } = await createRepo();

    const suggested = createAnchor({
      object_id: "11111111-1111-4111-8111-111111111111",
      global_object_id: "global-1",
      last_transition_at: "2026-03-29T01:00:00.000Z"
    });
    const accepted = createAnchor({
      object_id: "22222222-2222-4222-8222-222222222222",
      global_object_id: "global-2",
      mapping_state: ProjectMappingState.ACCEPTED,
      accepted_by: "user",
      updated_at: "2026-03-29T02:00:00.000Z",
      last_transition_at: "2026-03-29T02:00:00.000Z"
    });
    const otherWorkspace = createAnchor({
      object_id: "33333333-3333-4333-8333-333333333333",
      global_object_id: "global-3",
      workspace_id: "workspace-2",
      project_id: "workspace-2",
      last_transition_at: "2026-03-29T03:00:00.000Z"
    });

    await repo.create(suggested);
    await repo.create(accepted);
    await repo.create(otherWorkspace);

    const allForWorkspace = await repo.findByWorkspace("workspace-1");
    expect(allForWorkspace.map((anchor) => anchor.object_id)).toEqual([
      accepted.object_id,
      suggested.object_id
    ]);

    const acceptedOnly = await repo.findByWorkspace("workspace-1", ProjectMappingState.ACCEPTED);
    expect(acceptedOnly).toEqual([accepted]);
  });

  it("finds anchors by ids without duplicates and ignores missing ids", async () => {
    const { repo } = await createRepo();
    const first = createAnchor({
      object_id: "11111111-1111-4111-8111-111111111111",
      global_object_id: "global-1"
    });
    const second = createAnchor({
      object_id: "22222222-2222-4222-8222-222222222222",
      global_object_id: "global-2",
      updated_at: "2026-03-29T01:00:00.000Z",
      last_transition_at: "2026-03-29T01:00:00.000Z"
    });

    await repo.create(first);
    await repo.create(second);

    const rows = await repo.findByIds([second.object_id, "missing-anchor", first.object_id, second.object_id]);

    expect(rows).toHaveLength(2);
    expect(rows.map((anchor) => anchor.object_id).sort()).toEqual([first.object_id, second.object_id].sort());
  });

  it("lists suggested and probationary anchors as pending", async () => {
    const { repo } = await createRepo();

    const suggested = createAnchor({
      object_id: "11111111-1111-4111-8111-111111111111",
      global_object_id: "global-1",
      last_transition_at: "2026-03-29T01:00:00.000Z"
    });
    const probationary = createAnchor({
      object_id: "22222222-2222-4222-8222-222222222222",
      global_object_id: "global-2",
      mapping_state: ProjectMappingState.PROBATIONARY,
      updated_at: "2026-03-29T02:00:00.000Z",
      last_transition_at: "2026-03-29T02:00:00.000Z"
    });
    const adapted = createAnchor({
      object_id: "33333333-3333-4333-8333-333333333333",
      global_object_id: "global-3",
      mapping_state: ProjectMappingState.ADAPTED,
      accepted_by: "review",
      updated_at: "2026-03-29T03:00:00.000Z",
      last_transition_at: "2026-03-29T03:00:00.000Z"
    });

    await repo.create(suggested);
    await repo.create(probationary);
    await repo.create(adapted);

    const pending = await repo.listPending("workspace-1");
    expect(pending).toEqual([probationary, suggested]);
  });

  it("updates anchor state, acceptance source, and transition timestamp", async () => {
    const { repo } = await createRepo();
    const anchor = createAnchor();

    await repo.create(anchor);
    await repo.updateState(
      anchor.object_id,
      ProjectMappingState.ACCEPTED,
      "deterministic_rule",
      "2026-03-29T04:00:00.000Z"
    );

    await expect(repo.findById(anchor.object_id)).resolves.toEqual(
      createAnchor({
        mapping_state: ProjectMappingState.ACCEPTED,
        accepted_by: "deterministic_rule",
        updated_at: "2026-03-29T04:00:00.000Z",
        last_transition_at: "2026-03-29T04:00:00.000Z"
      })
    );
  });

  it("throws not found when updating a missing anchor", async () => {
    const { repo } = await createRepo();

    await expect(
      repo.updateState(
        "missing-anchor",
        ProjectMappingState.REJECTED,
        null,
        "2026-03-29T04:00:00.000Z"
      )
    ).rejects.toMatchObject({
      code: "NOT_FOUND"
    });
  });

  it("returns immutable anchors", async () => {
    const { repo } = await createRepo();
    const anchor = createAnchor();

    await repo.create(anchor);
    const stored = await repo.findById(anchor.object_id);

    expect(stored).not.toBeNull();
    expect(() => {
      (stored as { mapping_state: string }).mapping_state = ProjectMappingState.REJECTED;
    }).toThrow(TypeError);
  });
});

function createAnchor(overrides: Partial<ProjectMappingAnchorRecord> = {}): ProjectMappingAnchorRecord {
  return {
    object_id: "11111111-1111-4111-8111-111111111111",
    object_kind: "project_mapping_anchor",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-29T00:00:00.000Z",
    updated_at: "2026-03-29T00:00:00.000Z",
    created_by: "user",
    global_object_id: "global-1",
    project_id: "workspace-1",
    mapping_state: ProjectMappingState.SUGGESTED,
    workspace_id: "workspace-1",
    accepted_by: null,
    last_transition_at: "2026-03-29T00:00:00.000Z",
    ...overrides
  };
}

async function createRepo(): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: ProjectMappingAnchorRepoLike;
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
  await workspaceRepo.create({
    workspace_id: "workspace-2",
    name: "workspace two",
    root_path: "/tmp/ws2",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });

  const module = (await import("../../../repos/surface/project-mapping-anchor-repo.js")) as {
    SqliteProjectMappingAnchorRepo: new (database: ReturnType<typeof initDatabase>) => ProjectMappingAnchorRepoLike;
  };

  return {
    database,
    repo: new module.SqliteProjectMappingAnchorRepo(database)
  };
}
