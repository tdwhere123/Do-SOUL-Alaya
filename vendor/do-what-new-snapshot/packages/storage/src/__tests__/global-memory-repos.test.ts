import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryDimension,
  ScopeClass,
  WorkspaceKind,
  WorkspaceState,
  type GlobalMemoryEntry
} from "@do-what/protocol";
import { initDatabase } from "../db.js";
import { SqliteWorkspaceRepo } from "../repos/workspace-repo.js";

type Classification = "included" | "excluded";

interface GlobalMemoryRepoLike {
  upsert(entry: GlobalMemoryEntry): Promise<Readonly<GlobalMemoryEntry>>;
  findByGlobalObjectId(globalObjectId: string): Promise<Readonly<GlobalMemoryEntry> | null>;
  list(filters?: {
    dimension?: GlobalMemoryEntry["dimension"];
    scope_class?: GlobalMemoryEntry["scope_class"];
  }): Promise<readonly Readonly<GlobalMemoryEntry>[]>;
}

interface GlobalMemoryRecallCacheRecord {
  readonly workspace_id: string;
  readonly global_object_id: string;
  readonly classification: Classification;
  readonly updated_at: string;
}

interface GlobalMemoryRecallCacheRepoLike {
  upsert(record: GlobalMemoryRecallCacheRecord): Promise<Readonly<GlobalMemoryRecallCacheRecord>>;
  upsertMany(
    records: readonly GlobalMemoryRecallCacheRecord[]
  ): Promise<readonly Readonly<GlobalMemoryRecallCacheRecord>[]>;
  listByWorkspace(
    workspaceId: string,
    classification?: Classification
  ): Promise<readonly Readonly<GlobalMemoryRecallCacheRecord>[]>;
}

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

describe("Global memory storage repos", () => {
  it("applies migrations 050 and 051, exports the repos, and keeps global entries workspace-agnostic", async () => {
    const { database } = await createRepos();
    const storage = (await import("../index.js")) as Record<string, unknown>;

    expect(storage.SqliteGlobalMemoryRepo).toBeTypeOf("function");
    expect(storage.SqliteGlobalMemoryRecallCacheRepo).toBeTypeOf("function");

    const versions = database.connection
      .prepare("SELECT version FROM schema_version WHERE version IN (50, 51) ORDER BY version ASC")
      .all() as ReadonlyArray<{ readonly version: number }>;
    const globalEntryColumns = getColumnNames(database, "global_memory_entries");
    const recallCacheColumns = getColumnNames(database, "global_memory_recall_cache");

    expect(versions.map((entry) => entry.version)).toEqual([50, 51]);
    expect(globalEntryColumns).toEqual([
      "global_object_id",
      "object_kind",
      "canonical_identity",
      "dimension",
      "scope_class",
      "content",
      "domain_tags",
      "provenance",
      "activation_score",
      "version",
      "created_at",
      "updated_at"
    ]);
    expect(globalEntryColumns).not.toContain("workspace_id");
    expect(recallCacheColumns).toEqual([
      "workspace_id",
      "global_object_id",
      "classification",
      "updated_at"
    ]);
  });

  it("upserts, finds, and lists global memory entries with recall filters", async () => {
    const { globalMemoryRepo } = await createRepos();
    const first = createGlobalMemoryEntry();
    const second = createGlobalMemoryEntry({
      global_object_id: "global-memory-2",
      canonical_identity: "docs::workflow::use-rtk-wrapper",
      dimension: MemoryDimension.CONSTRAINT,
      scope_class: ScopeClass.GLOBAL_DOMAIN,
      content: "Prefix repo shell commands with rtk.",
      domain_tags: ["workflow", "tooling"],
      activation_score: 0.61
    });

    await expect(globalMemoryRepo.upsert(first)).resolves.toEqual(first);
    await expect(globalMemoryRepo.upsert(second)).resolves.toEqual(second);
    await expect(globalMemoryRepo.findByGlobalObjectId(first.global_object_id)).resolves.toEqual(first);

    await expect(globalMemoryRepo.list()).resolves.toEqual([first, second]);
    await expect(globalMemoryRepo.list({ dimension: MemoryDimension.CONSTRAINT })).resolves.toEqual([second]);
    await expect(globalMemoryRepo.list({ scope_class: ScopeClass.GLOBAL_CORE })).resolves.toEqual([first]);
  });

  it("updates existing global entries in place on upsert", async () => {
    const { globalMemoryRepo } = await createRepos();
    const entry = createGlobalMemoryEntry();
    await globalMemoryRepo.upsert(entry);

    const updated = await globalMemoryRepo.upsert({
      ...entry,
      content: "Always run pnpm build before commit.",
      activation_score: 0.92,
      version: 3,
      updated_at: "2026-04-23T01:00:00.000Z"
    });

    expect(updated.content).toBe("Always run pnpm build before commit.");
    expect(updated.activation_score).toBe(0.92);
    expect(updated.version).toBe(3);
    expect(updated.created_at).toBe(entry.created_at);
    expect(updated.updated_at).toBe("2026-04-23T01:00:00.000Z");
    await expect(globalMemoryRepo.findByGlobalObjectId(entry.global_object_id)).resolves.toEqual(updated);
  });

  it("upserts and lists per-workspace recall classifications with final strict states only", async () => {
    const { recallCacheRepo } = await createRepos();

    await expect(
      recallCacheRepo.upsert({
        workspace_id: "workspace-1",
        global_object_id: "global-memory-1",
        classification: "included",
        updated_at: "2026-04-23T00:00:00.000Z"
      })
    ).resolves.toEqual({
      workspace_id: "workspace-1",
      global_object_id: "global-memory-1",
      classification: "included",
      updated_at: "2026-04-23T00:00:00.000Z"
    });
    await recallCacheRepo.upsert({
      workspace_id: "workspace-1",
      global_object_id: "global-memory-2",
      classification: "excluded",
      updated_at: "2026-04-23T00:01:00.000Z"
    });
    await recallCacheRepo.upsert({
      workspace_id: "workspace-2",
      global_object_id: "global-memory-1",
      classification: "excluded",
      updated_at: "2026-04-23T00:02:00.000Z"
    });

    await expect(recallCacheRepo.listByWorkspace("workspace-1")).resolves.toEqual([
      {
        workspace_id: "workspace-1",
        global_object_id: "global-memory-1",
        classification: "included",
        updated_at: "2026-04-23T00:00:00.000Z"
      },
      {
        workspace_id: "workspace-1",
        global_object_id: "global-memory-2",
        classification: "excluded",
        updated_at: "2026-04-23T00:01:00.000Z"
      }
    ]);
    await expect(recallCacheRepo.listByWorkspace("workspace-1", "included")).resolves.toEqual([
      {
        workspace_id: "workspace-1",
        global_object_id: "global-memory-1",
        classification: "included",
        updated_at: "2026-04-23T00:00:00.000Z"
      }
    ]);
  });

  it("updates existing recall-cache rows on upsert", async () => {
    const { recallCacheRepo } = await createRepos();

    await recallCacheRepo.upsert({
      workspace_id: "workspace-1",
      global_object_id: "global-memory-1",
      classification: "excluded",
      updated_at: "2026-04-23T00:00:00.000Z"
    });

    const updated = await recallCacheRepo.upsert({
      workspace_id: "workspace-1",
      global_object_id: "global-memory-1",
      classification: "included",
      updated_at: "2026-04-23T02:00:00.000Z"
    });

    expect(updated).toEqual({
      workspace_id: "workspace-1",
      global_object_id: "global-memory-1",
      classification: "included",
      updated_at: "2026-04-23T02:00:00.000Z"
    });
    await expect(recallCacheRepo.listByWorkspace("workspace-1")).resolves.toEqual([updated]);
  });

  it("persists recall-cache classifications atomically across a batch", async () => {
    const { recallCacheRepo } = await createRepos();

    await expect(
      recallCacheRepo.upsertMany([
        {
          workspace_id: "workspace-1",
          global_object_id: "global-memory-1",
          classification: "included",
          updated_at: "2026-04-23T03:00:00.000Z"
        },
        {
          workspace_id: "workspace-1",
          global_object_id: "missing-global-memory",
          classification: "excluded",
          updated_at: "2026-04-23T03:00:00.000Z"
        }
      ])
    ).rejects.toMatchObject({
      name: "StorageError",
      code: "QUERY_FAILED"
    });

    await expect(recallCacheRepo.listByWorkspace("workspace-1")).resolves.toEqual([]);
  });
});

function createGlobalMemoryEntry(overrides: Partial<GlobalMemoryEntry> = {}): GlobalMemoryEntry {
  return {
    global_object_id: "global-memory-1",
    object_kind: "global_memory_entry",
    canonical_identity: "docs::workflow::pnpm-build-before-commit",
    dimension: MemoryDimension.PROCEDURE,
    scope_class: ScopeClass.GLOBAL_CORE,
    content: "Run pnpm build before commit.",
    domain_tags: ["workflow", "build"],
    provenance: "seed://lane-c22/test-fixture",
    activation_score: 0.83,
    version: 2,
    created_at: "2026-04-23T00:00:00.000Z",
    updated_at: "2026-04-23T00:00:00.000Z",
    ...overrides
  };
}

function getColumnNames(
  database: ReturnType<typeof initDatabase>,
  tableName: string
): string[] {
  return (database.connection
    .prepare(`PRAGMA table_info(${tableName})`)
    .all() as Array<{ readonly name: string }>).map((column) => column.name);
}

async function createRepos(): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly globalMemoryRepo: GlobalMemoryRepoLike;
  readonly recallCacheRepo: GlobalMemoryRecallCacheRepoLike;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "Workspace One",
    root_path: "/tmp/workspace-1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    default_engine_class: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await workspaceRepo.create({
    workspace_id: "workspace-2",
    name: "Workspace Two",
    root_path: "/tmp/workspace-2",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    default_engine_class: null,
    workspace_state: WorkspaceState.ACTIVE
  });

  const storage = (await import("../index.js")) as {
    SqliteGlobalMemoryRepo: new (database: ReturnType<typeof initDatabase>) => GlobalMemoryRepoLike;
    SqliteGlobalMemoryRecallCacheRepo: new (database: ReturnType<typeof initDatabase>) => GlobalMemoryRecallCacheRepoLike;
  };

  const globalMemoryRepo = new storage.SqliteGlobalMemoryRepo(database);
  const recallCacheRepo = new storage.SqliteGlobalMemoryRecallCacheRepo(database);

  await globalMemoryRepo.upsert(createGlobalMemoryEntry());
  await globalMemoryRepo.upsert(
    createGlobalMemoryEntry({
      global_object_id: "global-memory-2",
      canonical_identity: "docs::workflow::use-rtk-wrapper",
      dimension: MemoryDimension.CONSTRAINT,
      scope_class: ScopeClass.GLOBAL_DOMAIN,
      content: "Prefix repo shell commands with rtk.",
      domain_tags: ["workflow", "tooling"],
      activation_score: 0.61
    })
  );

  database.connection.prepare("DELETE FROM global_memory_recall_cache").run();

  return {
    database,
    globalMemoryRepo,
    recallCacheRepo
  };
}
