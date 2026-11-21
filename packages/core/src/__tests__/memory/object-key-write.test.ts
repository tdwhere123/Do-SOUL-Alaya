import { afterEach, describe, expect, it } from "vitest";
import {
  FormationKind,
  GreenGovernanceEventType,
  MemoryDimension,
  MemoryGovernanceEventType,
  ScopeClass,
  SourceKind,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import {
  SqliteEventLogRepo,
  SqliteFieldEraseBarrierRepo,
  SqliteMemoryObjectKeyRepo,
  readObjectKeyEvidenceSources,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { MemoryService, type MemoryServiceDependencies } from "../../memory/memory-service.js";
import { createMemoryObjectKeyWriter } from "../../memory/object-keys/write-service.js";
import { fieldContractSha256 } from "../../shared/field-hash.js";
import {
  REAL_SQLITE_TEST_RUN_ID,
  REAL_SQLITE_TEST_WORKSPACE_ID,
  createRecallRealStorage
} from "../shared/real-sqlite.test-support.js";

const databases = new Set<StorageDatabase>();
const EVIDENCE_ID = "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9";
const MEMORY_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

describe("MemoryService object-key materialization", () => {
  it("rolls back create and audit when SQLite cannot insert an object key", async () => {
    const notifications: string[] = [];
    const { database, eventLogRepo, memoryEntryRepo, service } = await setupKeyWrite({
      runtimeNotifier: { notifyEntry: (event) => { notifications.push(event.event_type); } }
    });
    database.connection.exec(`CREATE TRIGGER reject_key_insert BEFORE INSERT ON memory_object_keys
      BEGIN SELECT RAISE(ABORT, 'key insert failed'); END`);

    await expect(service.create(keyedInput())).rejects.toThrow("key insert failed");

    await expect(memoryEntryRepo.findById(MEMORY_ID)).resolves.toBeNull();
    await expect(eventLogRepo.queryByEntity("memory_entry", MEMORY_ID)).resolves.toEqual([]);
    expect(notifications).toEqual([]);
  });

  it("rolls back a failed key rewrite and notifies the committed retry before Green revocation", async () => {
    const order: string[] = [];
    const { database, eventLogRepo, keys, memoryEntryRepo, service } = await setupKeyWrite({
      runtimeNotifier: { notifyEntry: (event) => { order.push(event.event_type); } },
      greenService: {
        reevaluate: async () => {},
        pierce: async () => { order.push(GreenGovernanceEventType.SOUL_GREEN_PIERCED); }
      }
    });
    await service.create(keyedInput());
    const before = await memoryEntryRepo.findById(MEMORY_ID);
    expect(before).not.toBeNull();
    const originalKeys = keys.listByOwner(REAL_SQLITE_TEST_WORKSPACE_ID, MEMORY_ID);
    expect(originalKeys.length).toBeGreaterThan(0);
    order.length = 0;
    database.connection.exec(`CREATE TRIGGER reject_key_delete BEFORE DELETE ON memory_object_keys
      BEGIN SELECT RAISE(ABORT, 'key delete failed'); END`);
    const update = () => service.update(MEMORY_ID, { evidence_refs: [] }, "manual_update");

    await expect(update()).rejects.toThrow("key delete failed");
    await expect(memoryEntryRepo.findById(MEMORY_ID)).resolves.toEqual(before);
    expect(keys.listByOwner(REAL_SQLITE_TEST_WORKSPACE_ID, MEMORY_ID)).toEqual(originalKeys);
    expect((await eventLogRepo.queryByEntity("memory_entry", MEMORY_ID)).map((event) => event.event_type))
      .toEqual([MemoryGovernanceEventType.SOUL_MEMORY_CREATED]);
    expect(order).toEqual([]);

    database.connection.exec("DROP TRIGGER reject_key_delete");
    await expect(update()).resolves.toMatchObject({ evidence_refs: [] });
    expect(keys.listByOwner(REAL_SQLITE_TEST_WORKSPACE_ID, MEMORY_ID)).toEqual([]);
    expect(order).toEqual([
      MemoryGovernanceEventType.SOUL_MEMORY_UPDATED,
      GreenGovernanceEventType.SOUL_GREEN_PIERCED
    ]);
  });

  it.each([false, true])("persists gist-remainder keys on create with notify failure=%s", async (notifyFails) => {
    const { keys, service } = await setupKeyWrite({
      runtimeNotifier: { notifyEntry: async () => {
        if (notifyFails) throw new Error("notification interrupted");
      } }
    });

    const creation = service.create(keyedInput());
    if (notifyFails) await expect(creation).rejects.toThrow("notification interrupted");
    else await creation;

    const persisted = keys.listByOwner(REAL_SQLITE_TEST_WORKSPACE_ID, MEMORY_ID);
    expect(persisted.map((key) => key.surface)).toEqual(
      expect.arrayContaining(["Golden Retriever"])
    );
    expect(persisted.every((key) => key.source_ref.includes(EVIDENCE_ID))).toBe(true);
  });

  it("does not write keys from a snapshot erased while notification was delayed", async () => {
    const { database, memoryEntryRepo, evidenceCapsuleRepo } = await createRecallRealStorage(db => databases.add(db));
    await evidenceCapsuleRepo.create(capsule());
    database.connection.prepare(`INSERT INTO source_records (
      workspace_id, record_id, source_id, source_version, content_digest, evidence_object_id,
      recorded_at, event_time, valid_from, valid_to, operator_id, source_body
    ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, NULL, NULL, ?, ?)`)
      .run(REAL_SQLITE_TEST_WORKSPACE_ID, "private-source", "turn", "1", "digest", EVIDENCE_ID,
        "2026-06-01T00:00:00Z", "capture", "private source");
    database.connection.prepare(`INSERT INTO source_record_evidence_refs (workspace_id, record_id, evidence_object_id)
      VALUES (?, ?, ?)`).run(REAL_SQLITE_TEST_WORKSPACE_ID, "private-source", EVIDENCE_ID);
    let release!: () => void;
    let entered!: () => void;
    const delayed = new Promise<void>(resolve => { release = resolve; });
    const notified = new Promise<void>(resolve => { entered = resolve; });
    const keys = new SqliteMemoryObjectKeyRepo(database);
    const service = new MemoryService({
      generateObjectId: () => MEMORY_ID, now: () => "2026-06-01T00:00:00.000Z",
      evidenceService: { findById: id => evidenceCapsuleRepo.findById(id),
        findByIds: (workspace, ids) => evidenceCapsuleRepo.findByIds(workspace, ids) },
      eventLogRepo: new SqliteEventLogRepo(database), memoryEntryRepo,
      runtimeNotifier: { notifyEntry: async () => { entered(); await delayed; } },
      objectKeyWriter: createMemoryObjectKeyWriter({
        readEvidenceSources: (workspace, ids) => readObjectKeyEvidenceSources(database, workspace, ids),
        replaceOwnerKeys: (workspace, owner, minted, expected) => keys.replaceOwnerKeys(workspace, owner, minted, expected)
      })
    });
    const creation = service.create({ created_by: "user_action", dimension: MemoryDimension.FACT,
      source_kind: SourceKind.USER, formation_kind: FormationKind.EXPLICIT, scope_class: ScopeClass.PROJECT,
      content: "The private appointment is 2026-05-30.", domain_tags: [], evidence_refs: [EVIDENCE_ID],
      workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID, run_id: REAL_SQLITE_TEST_RUN_ID, surface_id: null });
    await notified;
    new SqliteFieldEraseBarrierRepo(database, fieldContractSha256).apply({ barrier_id: "erase-private",
      workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID, generation_id: null, subject_kind: "source_record",
      subject_id: "private-source", erased_at: "2026-06-02T00:00:00.000Z" });
    release();
    await creation;
    expect(keys.listByOwner(REAL_SQLITE_TEST_WORKSPACE_ID, MEMORY_ID)).toEqual([]);
    expect((await memoryEntryRepo.findById(MEMORY_ID))?.lifecycle_state).toBe("tombstone");
  });
});

async function setupKeyWrite(
  effects: Pick<MemoryServiceDependencies, "runtimeNotifier" | "greenService">
) {
  const { database, memoryEntryRepo, evidenceCapsuleRepo } = await createRecallRealStorage(db => databases.add(db));
  await evidenceCapsuleRepo.create(capsule());
  const keys = new SqliteMemoryObjectKeyRepo(database);
  const eventLogRepo = new SqliteEventLogRepo(database);
  const service = new MemoryService({
    ...effects, eventLogRepo, memoryEntryRepo,
    now: () => "2026-06-01T00:00:00.000Z",
    generateObjectId: () => MEMORY_ID,
    evidenceService: {
      findById: id => evidenceCapsuleRepo.findById(id),
      findByIds: (workspaceId, ids) => evidenceCapsuleRepo.findByIds(workspaceId, ids)
    },
    objectKeyWriter: createMemoryObjectKeyWriter({
      readEvidenceSources: (workspaceId, ids) => readObjectKeyEvidenceSources(database, workspaceId, ids),
      replaceOwnerKeys: (workspaceId, owner, minted, expected) => keys.replaceOwnerKeys(workspaceId, owner, minted, expected)
    })
  });
  return { database, eventLogRepo, keys, memoryEntryRepo, service };
}

function keyedInput() {
  return {
    created_by: "user_action",
    dimension: MemoryDimension.FACT,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "I took my niece to the museum.",
    domain_tags: ["smoke"],
    evidence_refs: [EVIDENCE_ID],
    workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID,
    run_id: REAL_SQLITE_TEST_RUN_ID,
    surface_id: null
  };
}

function capsule(): EvidenceCapsule {
  return {
    object_id: EVIDENCE_ID,
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "user",
    evidence_kind: "tool_output",
    semantic_anchor: {
      topic: "museum visit",
      keywords: ["museum"],
      summary: "Niece museum visit"
    },
    event_anchor: null,
    physical_anchor: null,
    evidence_health_state: "verified",
    gist: "By the way, I took my niece to the Natural History Museum. She loves her Golden Retriever.",
    excerpt: "She loves her Golden Retriever.",
    source_hash: "sha256:abc",
    run_id: REAL_SQLITE_TEST_RUN_ID,
    workspace_id: REAL_SQLITE_TEST_WORKSPACE_ID,
    surface_id: null
  };
}
