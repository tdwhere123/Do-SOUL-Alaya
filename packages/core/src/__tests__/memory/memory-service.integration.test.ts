import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryDimension,
  MemoryGovernanceEventType,
  ScopeClass,
  SourceKind,
  FormationKind,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import {
  SqliteEventLogRepo,
  SqliteMemoryEntryRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { MemoryService } from "../../memory/memory-service.js";
import {
  REAL_SQLITE_TEST_RUN_ID,
  REAL_SQLITE_TEST_WORKSPACE_ID,
  createRecallRealStorage
} from "../shared/real-sqlite.test-support.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

// anti-patterns-lint-allow: real-DB smoke mirrors recall integration precedents on purpose.
async function createMemoryServiceFixture(): Promise<{
  readonly database: StorageDatabase;
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly service: MemoryService;
  readonly notifySpy: ReturnType<typeof vi.fn>;
}> {
  const { database, memoryEntryRepo } = await createRecallRealStorage((db) => {
    databases.add(db);
  });
  const eventLogRepo = new SqliteEventLogRepo(database);
  const notifySpy = vi.fn(async (_entry: EventLogEntry) => {});

  const service = new MemoryService({
    now: () => "2026-06-01T00:00:00.000Z",
    generateObjectId: () => "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    evidenceService: {
      findById: async () => null,
      findByIds: async () => []
    },
    eventLogRepo,
    memoryEntryRepo,
    runtimeNotifier: { notifyEntry: notifySpy }
  });

  return { database, memoryEntryRepo, eventLogRepo, service, notifySpy };
}

describe("MemoryService integration (:memory:)", () => {
  it("creates a memory row and audit event through real sqlite repos", async () => {
    const { service, memoryEntryRepo, eventLogRepo, notifySpy } = await createMemoryServiceFixture();

    const created = await service.create({
      created_by: "user_action",
      dimension: MemoryDimension.FACT,
      source_kind: SourceKind.USER,
      formation_kind: FormationKind.EXPLICIT,
      scope_class: ScopeClass.PROJECT,
      content: "Integration smoke memory.",
      domain_tags: ["smoke"],
      evidence_refs: [],
      workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID,
      run_id: REAL_SQLITE_TEST_RUN_ID,
      surface_id: null
    });

    expect(created.object_id).toBe("aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa");
    expect(created.workspace_id).toBe(REAL_SQLITE_TEST_WORKSPACE_ID);

    const persisted = await memoryEntryRepo.findById(created.object_id);
    expect(persisted).toMatchObject({
      object_id: created.object_id,
      content: "Integration smoke memory.",
      workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID
    });

    const audit = await eventLogRepo.queryByEntity("memory_entry", created.object_id);
    expect(audit).toHaveLength(1);
    expect(audit[0]?.event_type).toBe(MemoryGovernanceEventType.SOUL_MEMORY_CREATED);
    expect(notifySpy).toHaveBeenCalledTimes(1);
  });

  it("findByIdScoped returns null for a row stored in another workspace", async () => {
    const { service, memoryEntryRepo } = await createMemoryServiceFixture();

    await memoryEntryRepo.create({
      object_id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      object_kind: "memory_entry",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
      created_by: "user_action",
      dimension: MemoryDimension.FACT,
      source_kind: SourceKind.USER,
      formation_kind: FormationKind.EXPLICIT,
      scope_class: ScopeClass.PROJECT,
      content: "Foreign workspace memory.",
      domain_tags: [],
      evidence_refs: [],
      workspace_id: "workspace-other",
      run_id: REAL_SQLITE_TEST_RUN_ID,
      surface_id: null,
      storage_tier: "hot",
      activation_score: null,
      retention_score: null,
      manifestation_state: null,
      retention_state: null,
      decay_profile: null,
      confidence: null,
      last_used_at: null,
      last_hit_at: null,
      reinforcement_count: null,
      contradiction_count: null,
      superseded_by: null
    });

    await expect(
      service.findByIdScoped("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", REAL_SQLITE_TEST_WORKSPACE_ID)
    ).resolves.toBeNull();
    await expect(
      service.findByIdScoped("bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", "workspace-other")
    ).resolves.toMatchObject({ workspace_id: "workspace-other" });
  });

  it("lists only memories for the requested workspace", async () => {
    const { service, memoryEntryRepo } = await createMemoryServiceFixture();

    await memoryEntryRepo.create({
      object_id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
      object_kind: "memory_entry",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
      created_by: "user_action",
      dimension: MemoryDimension.FACT,
      source_kind: SourceKind.USER,
      formation_kind: FormationKind.EXPLICIT,
      scope_class: ScopeClass.PROJECT,
      content: "Workspace-one memory.",
      domain_tags: [],
      evidence_refs: [],
      workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID,
      run_id: REAL_SQLITE_TEST_RUN_ID,
      surface_id: null,
      storage_tier: "hot",
      activation_score: null,
      retention_score: null,
      manifestation_state: null,
      retention_state: null,
      decay_profile: null,
      confidence: null,
      last_used_at: null,
      last_hit_at: null,
      reinforcement_count: null,
      contradiction_count: null,
      superseded_by: null
    });
    await memoryEntryRepo.create({
      object_id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
      object_kind: "memory_entry",
      schema_version: 1,
      lifecycle_state: "active",
      created_at: "2026-06-01T00:00:00.000Z",
      updated_at: "2026-06-01T00:00:00.000Z",
      created_by: "user_action",
      dimension: MemoryDimension.FACT,
      source_kind: SourceKind.USER,
      formation_kind: FormationKind.EXPLICIT,
      scope_class: ScopeClass.PROJECT,
      content: "Workspace-two memory.",
      domain_tags: [],
      evidence_refs: [],
      workspace_id: "workspace-2",
      run_id: REAL_SQLITE_TEST_RUN_ID,
      surface_id: null,
      storage_tier: "hot",
      activation_score: null,
      retention_score: null,
      manifestation_state: null,
      retention_state: null,
      decay_profile: null,
      confidence: null,
      last_used_at: null,
      last_hit_at: null,
      reinforcement_count: null,
      contradiction_count: null,
      superseded_by: null
    });

    const listed = await service.findByWorkspaceId(REAL_SQLITE_TEST_WORKSPACE_ID);
    expect(listed.map((entry) => entry.object_id)).toEqual(["cccccccc-cccc-4ccc-8ccc-cccccccccccc"]);
  });
});
