import { afterEach, describe, expect, it } from "vitest";
import {
  FormationKind,
  MemoryDimension,
  ScopeClass,
  SourceKind,
  type EvidenceCapsule
} from "@do-soul/alaya-protocol";
import {
  SqliteEventLogRepo,
  SqliteMemoryObjectKeyRepo,
  scanObjectKeyRetrofitSources,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { MemoryService } from "../../memory/memory-service.js";
import { retrofitMemoryObjectKeys } from "../../memory/object-keys/retrofit.js";
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

describe("retrofitMemoryObjectKeys", () => {
  it("mints complementary Keys onto existing memories that were written without a Key writer", async () => {
    const { database, memoryEntryRepo, evidenceCapsuleRepo } = await createRecallRealStorage(
      (db) => databases.add(db)
    );
    await evidenceCapsuleRepo.create(capsule());
    const keys = new SqliteMemoryObjectKeyRepo(database);
    const service = new MemoryService({
      now: () => "2026-06-01T00:00:00.000Z",
      generateObjectId: () => MEMORY_ID,
      evidenceService: {
        findById: (objectId) => evidenceCapsuleRepo.findById(objectId),
        findByIds: (workspaceId, objectIds) => evidenceCapsuleRepo.findByIds(workspaceId, objectIds)
      },
      eventLogRepo: new SqliteEventLogRepo(database),
      memoryEntryRepo,
      runtimeNotifier: { notifyEntry: async () => undefined }
    });

    await service.create({
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
    });
    expect(keys.listByOwner(REAL_SQLITE_TEST_WORKSPACE_ID, MEMORY_ID)).toEqual([]);

    const scan = scanObjectKeyRetrofitSources(database);
    const report = retrofitMemoryObjectKeys({
      owners: scan.owners,
      evidence: scan.evidence,
      replaceOwnerKeys: (workspaceId, ownerId, minted) =>
        keys.replaceOwnerKeys(workspaceId, ownerId, minted)
    });

    expect(report.owner_count).toBe(1);
    expect(report.objects_with_keys).toBe(1);
    expect(report.key_count).toBeGreaterThan(0);
    const persisted = keys.listByOwner(REAL_SQLITE_TEST_WORKSPACE_ID, MEMORY_ID);
    expect(persisted.map((key) => key.surface)).toEqual(
      expect.arrayContaining(["Golden Retriever"])
    );

    const again = retrofitMemoryObjectKeys({
      owners: scan.owners,
      evidence: scan.evidence,
      replaceOwnerKeys: (workspaceId, ownerId, minted) =>
        keys.replaceOwnerKeys(workspaceId, ownerId, minted)
    });
    expect(again.key_count).toBe(report.key_count);
    expect(keys.listByOwner(REAL_SQLITE_TEST_WORKSPACE_ID, MEMORY_ID).map((key) => key.surface))
      .toEqual(persisted.map((key) => key.surface));
  });
});

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
