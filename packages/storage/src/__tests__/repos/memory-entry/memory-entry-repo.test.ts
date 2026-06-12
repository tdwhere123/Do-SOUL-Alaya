import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  FormationKind,
  MemoryDimension,
  MemoryGovernanceEventType,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  SynthesisStatus,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../../../sqlite/db.js";
import { StorageError } from "../../../shared/errors.js";
import { SqliteEnrichPendingRepo } from "../../../repos/enrich-pending-repo.js";
import { SqliteEventLogRepo } from "../../../repos/event-log-repo.js";
import {
  FIND_BY_EVIDENCE_REFS_INPUT_CAP,
  SqliteMemoryEntryRepo,
  type MemoryEntryRepoDiagnosticSink
} from "../../../repos/memory-entry/index.js";
import { SqliteRunRepo } from "../../../repos/run-repo.js";
import { SqliteSynthesisCapsuleRepo } from "../../../repos/synthesis-capsule-repo.js";
import { SqliteWorkspaceRepo } from "../../../repos/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "user_action",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for all workspace commands.",
    domain_tags: ["tooling", "workflow"],
    evidence_refs: ["evidence-1", "evidence-2"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
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
    superseded_by: null,
    forget_disposition: null,
    forget_disposition_ref: null,
    ...overrides
  };
}

function createMemoryCreatedEventInput(
  entry: MemoryEntry
): Parameters<SqliteEventLogRepo["append"]>[0] {
  return {
    event_type: MemoryGovernanceEventType.SOUL_MEMORY_CREATED,
    entity_type: "memory_entry",
    entity_id: entry.object_id,
    workspace_id: entry.workspace_id,
    run_id: entry.run_id,
    caused_by: entry.created_by,
    payload_json: {
      object_id: entry.object_id,
      object_kind: entry.object_kind,
      workspace_id: entry.workspace_id,
      run_id: entry.run_id
    }
  };
}

describe("SqliteMemoryEntryRepo", () => {
  it("creates and loads a memory entry by id", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry();

    await expect(repo.create(entry)).resolves.toEqual(entry);
    await expect(repo.findById(entry.object_id)).resolves.toEqual(entry);
  });

  it("createWithinTransaction commits EventLog-first, row, and co-write atomically", async () => {
    const { repo, database } = await createRepo();
    const enrichRepo = new SqliteEnrichPendingRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const entry = createMemoryEntry();
    const order: string[] = [];

    const returned = repo.createWithinTransaction(entry, {
      beforeCreate: () => {
        order.push("event_log");
        eventLogRepo.append(createMemoryCreatedEventInput(entry));
      },
      afterCreate: () => {
        order.push("enqueue");
        enrichRepo.enqueue({
          workspaceId: entry.workspace_id,
          memoryId: entry.object_id,
          runId: entry.run_id,
          sourceSignalId: "signal-1",
          enqueuedAt: "2026-03-21T00:00:00.000Z"
        });
      }
    });

    expect(returned).toEqual(entry);
    expect(order).toEqual(["event_log", "enqueue"]);
    await expect(repo.findById(entry.object_id)).resolves.toEqual(entry);
    await expect(eventLogRepo.queryByEntity("memory_entry", entry.object_id)).resolves.toHaveLength(1);
    expect(enrichRepo.countPending(entry.workspace_id)).toBe(1);
  });

  it("createWithinTransaction rolls back the EventLog row and memory row when the co-write throws", async () => {
    // invariant pinned: a created memory ALWAYS carries its enrich_pending
    // marker and audit row, or NONE land. A throw in the co-write rolls the
    // EventLog row and memory row back, so the originating signal can replay
    // rather than leave durable truth with no enrichment marker.
    const { repo, database } = await createRepo();
    const enrichRepo = new SqliteEnrichPendingRepo(database);
    const eventLogRepo = new SqliteEventLogRepo(database);
    const entry = createMemoryEntry();

    expect(() =>
      repo.createWithinTransaction(entry, {
        beforeCreate: () => {
          eventLogRepo.append(createMemoryCreatedEventInput(entry));
        },
        afterCreate: () => {
          enrichRepo.enqueue({
            workspaceId: entry.workspace_id,
            memoryId: entry.object_id,
            runId: entry.run_id,
            sourceSignalId: "signal-1",
            enqueuedAt: "2026-03-21T00:00:00.000Z"
          });
          throw new Error("co-write failed");
        }
      })
    ).toThrow("co-write failed");

    await expect(repo.findById(entry.object_id)).resolves.toBeNull();
    await expect(eventLogRepo.queryByEntity("memory_entry", entry.object_id)).resolves.toEqual([]);
    expect(enrichRepo.countPending(entry.workspace_id)).toBe(0);
  });

  it("createWithinTransaction does not insert the row or marker when the EventLog-first callback throws", async () => {
    const { repo, database } = await createRepo();
    const enrichRepo = new SqliteEnrichPendingRepo(database);
    const entry = createMemoryEntry();

    expect(() =>
      repo.createWithinTransaction(entry, {
        beforeCreate: () => {
          throw new Error("event append failed");
        },
        afterCreate: () => {
          enrichRepo.enqueue({
            workspaceId: entry.workspace_id,
            memoryId: entry.object_id,
            runId: entry.run_id,
            sourceSignalId: "signal-1",
            enqueuedAt: "2026-03-21T00:00:00.000Z"
          });
        }
      })
    ).toThrow("event append failed");

    await expect(repo.findById(entry.object_id)).resolves.toBeNull();
    expect(enrichRepo.countPending(entry.workspace_id)).toBe(0);
  });

  it("finds memory entries by ids without duplicates and skips missing ids", async () => {
    const { repo } = await createRepo();
    const first = createMemoryEntry({
      object_id: "7ab81ca8-9425-4e18-ad4a-81ab6406db55",
      run_id: "run-1"
    });
    const second = createMemoryEntry({
      object_id: "ca648194-c03c-4932-b103-3ec4d318732a",
      run_id: "run-2",
      created_at: "2026-03-21T00:00:01.000Z",
      updated_at: "2026-03-21T00:00:01.000Z"
    });

    await repo.create(first);
    await repo.create(second);

    const rows = await repo.findByIds([second.object_id, "missing-memory", first.object_id, second.object_id]);

    expect(rows).toHaveLength(2);
    expect(rows.map((row) => row.object_id).sort()).toEqual([first.object_id, second.object_id].sort());
  });

  it("returns hot-tier records by default in findByWorkspaceId", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "7ab81ca8-9425-4e18-ad4a-81ab6406db55",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-1"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "ca648194-c03c-4932-b103-3ec4d318732a",
        storage_tier: StorageTier.COLD,
        workspace_id: "workspace-1",
        run_id: "run-2"
      })
    );

    const rows = await repo.findByWorkspaceId("workspace-1");
    expect(rows.map((row) => row.object_id)).toEqual(["7ab81ca8-9425-4e18-ad4a-81ab6406db55"]);
  });

  it("returns explicit cold-tier records when tier is provided", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "2501b5fa-3bc0-4759-a0da-219f805ef03f",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-1"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "6406be93-cfed-43d3-90ac-e287facc9ed4",
        storage_tier: StorageTier.COLD,
        workspace_id: "workspace-1",
        run_id: "run-2"
      })
    );

    const rows = await repo.findByWorkspaceId("workspace-1", StorageTier.COLD);
    expect(rows.map((row) => row.object_id)).toEqual(["6406be93-cfed-43d3-90ac-e287facc9ed4"]);
  });

  it("returns explicit warm-tier records when tier is provided", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "2501b5fa-3bc0-4759-a0da-219f805ef03f",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-1"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "4a2f07c4-371f-41eb-a9cb-6e842e2c2ca9",
        storage_tier: StorageTier.WARM,
        workspace_id: "workspace-1",
        run_id: "run-2"
      })
    );

    const rows = await repo.findByWorkspaceId("workspace-1", StorageTier.WARM);
    expect(rows.map((row) => row.object_id)).toEqual(["4a2f07c4-371f-41eb-a9cb-6e842e2c2ca9"]);
  });

  it("excludes tombstoned rows when explicit HOT tier is requested", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "7ab81ca8-9425-4e18-ad4a-81ab6406db55",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-1",
        retention_state: null
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "ca648194-c03c-4932-b103-3ec4d318732a",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-2",
        retention_state: "tombstoned"
      })
    );

    const rows = await repo.findByWorkspaceId("workspace-1", StorageTier.HOT);
    expect(rows.map((row) => row.object_id)).toEqual(["7ab81ca8-9425-4e18-ad4a-81ab6406db55"]);
  });

  it("excludes tombstoned rows when non-hot tiers are requested", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "4a2f07c4-371f-41eb-a9cb-6e842e2c2ca9",
        storage_tier: StorageTier.WARM,
        workspace_id: "workspace-1",
        run_id: "run-1",
        retention_state: null
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "ca648194-c03c-4932-b103-3ec4d318732a",
        storage_tier: StorageTier.COLD,
        workspace_id: "workspace-1",
        run_id: "run-2",
        retention_state: "tombstoned"
      })
    );

    const warmRows = await repo.findByWorkspaceId("workspace-1", StorageTier.WARM);
    const coldRows = await repo.findByWorkspaceId("workspace-1", StorageTier.COLD);
    expect(warmRows.map((row) => row.object_id)).toEqual(["4a2f07c4-371f-41eb-a9cb-6e842e2c2ca9"]);
    expect(coldRows).toEqual([]);
  });

  it("excludes dormant rows from the recall candidate load but keeps them fetchable by id (REVERSIBLE)", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "7ab81ca8-9425-4e18-ad4a-81ab6406db55",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-1",
        lifecycle_state: "active"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "ca648194-c03c-4932-b103-3ec4d318732a",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-2",
        lifecycle_state: "dormant"
      })
    );

    // invariant: dormant drops out of the recall candidate load (recall-silent).
    const rows = await repo.findByWorkspaceId("workspace-1", StorageTier.HOT);
    expect(rows.map((row) => row.object_id)).toEqual(["7ab81ca8-9425-4e18-ad4a-81ab6406db55"]);

    // invariant: dormant is NOT deleted — findById still returns it and it
    // transitions back to active (reversible).
    const dormant = await repo.findById("ca648194-c03c-4932-b103-3ec4d318732a");
    expect(dormant?.lifecycle_state).toBe("dormant");
    const revived = await repo.transitionLifecycle(
      "ca648194-c03c-4932-b103-3ec4d318732a",
      "active",
      new Date().toISOString()
    );
    expect(revived.lifecycle_state).toBe("active");
    const afterRevival = await repo.findByWorkspaceId("workspace-1", StorageTier.HOT);
    expect(afterRevival.map((row) => row.object_id).sort()).toEqual([
      "7ab81ca8-9425-4e18-ad4a-81ab6406db55",
      "ca648194-c03c-4932-b103-3ec4d318732a"
    ]);
  });

  it("excludes dormant rows from keyword (FTS) recall search", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "7ab81ca8-9425-4e18-ad4a-81ab6406db55",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-1",
        content: "alpha bravo charlie keyword match",
        lifecycle_state: "active"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "ca648194-c03c-4932-b103-3ec4d318732a",
        storage_tier: StorageTier.HOT,
        workspace_id: "workspace-1",
        run_id: "run-2",
        content: "alpha bravo charlie keyword match",
        lifecycle_state: "dormant"
      })
    );

    const results = await repo.searchByKeyword("workspace-1", "keyword", 10);
    expect(results.map((result) => result.object_id)).toEqual([
      "7ab81ca8-9425-4e18-ad4a-81ab6406db55"
    ]);
  });

  it("lists entries by run id across both tiers while excluding dormant and tombstoned rows", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "5b32be7d-dfc7-4746-9c7d-d70c6d8f8193",
        run_id: "run-1",
        storage_tier: StorageTier.HOT
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "89debe8f-cf95-4304-8a04-77f44e40be8e",
        run_id: "run-1",
        storage_tier: StorageTier.COLD,
        created_at: "2026-03-21T00:00:01.000Z",
        updated_at: "2026-03-21T00:00:01.000Z"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "b1e2d23b-7afb-4817-bf8e-fac7ed5ee854",
        run_id: "run-1",
        storage_tier: StorageTier.HOT,
        lifecycle_state: "dormant",
        created_at: "2026-03-21T00:00:02.000Z",
        updated_at: "2026-03-21T00:00:02.000Z"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "2d6bbf09-a1d1-4262-9495-8317a3781b44",
        run_id: "run-1",
        storage_tier: StorageTier.HOT,
        retention_state: "tombstoned",
        created_at: "2026-03-21T00:00:03.000Z",
        updated_at: "2026-03-21T00:00:03.000Z"
      })
    );

    const rows = await repo.findByRunId("run-1");
    expect(rows.map((row) => row.object_id)).toEqual([
      "5b32be7d-dfc7-4746-9c7d-d70c6d8f8193",
      "89debe8f-cf95-4304-8a04-77f44e40be8e"
    ]);
  });

  it("filters by dimension for hot-tier workspace records", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "f8f8ad43-f5a5-4d9e-ad2f-0133dba13c53",
        workspace_id: "workspace-1",
        run_id: "run-1",
        dimension: MemoryDimension.PREFERENCE,
        storage_tier: StorageTier.HOT
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "0bf75435-4c30-4fd1-aaf0-f005f00c88e0",
        workspace_id: "workspace-1",
        run_id: "run-2",
        dimension: MemoryDimension.CONSTRAINT,
        storage_tier: StorageTier.HOT
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "a3ab8a66-fb28-4f54-bc77-5b6a18144d82",
        workspace_id: "workspace-1",
        run_id: "run-2",
        dimension: MemoryDimension.PREFERENCE,
        storage_tier: StorageTier.COLD
      })
    );

    const rows = await repo.findByDimension("workspace-1", MemoryDimension.PREFERENCE);
    expect(rows.map((row) => row.object_id)).toEqual(["f8f8ad43-f5a5-4d9e-ad2f-0133dba13c53"]);
  });

  it("filters by scope class for hot-tier workspace records", async () => {
    const { repo } = await createRepo();

    await repo.create(
      createMemoryEntry({
        object_id: "88a0ec01-9d8a-4c89-a63b-32a07b4d8442",
        workspace_id: "workspace-1",
        run_id: "run-1",
        scope_class: ScopeClass.PROJECT,
        storage_tier: StorageTier.HOT
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "b5c41156-37f4-4ca5-87ec-00e6bd970744",
        workspace_id: "workspace-1",
        run_id: "run-1",
        scope_class: ScopeClass.GLOBAL_CORE,
        storage_tier: StorageTier.HOT
      })
    );

    const rows = await repo.findByScopeClass("workspace-1", ScopeClass.PROJECT);
    expect(rows.map((row) => row.object_id)).toEqual(["88a0ec01-9d8a-4c89-a63b-32a07b4d8442"]);
  });

  it("updates mutable fields", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry();
    await repo.create(entry);

    const updated = await repo.update(entry.object_id, {
      content: "Always run pnpm build before commit.",
      domain_tags: ["build", "workflow"],
      evidence_refs: ["evidence-3"],
      storage_tier: StorageTier.COLD,
      updated_at: "2026-03-21T03:00:00.000Z"
    });

    expect(updated.content).toBe("Always run pnpm build before commit.");
    expect(updated.domain_tags).toEqual(["build", "workflow"]);
    expect(updated.evidence_refs).toEqual(["evidence-3"]);
    expect(updated.storage_tier).toBe(StorageTier.COLD);
    expect(updated.updated_at).toBe("2026-03-21T03:00:00.000Z");
  });

  it("updates tier and access timestamps in the same mutable update", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry({
      storage_tier: StorageTier.COLD,
      last_used_at: "2026-03-01T00:00:00.000Z",
      last_hit_at: "2026-03-01T00:00:00.000Z"
    });
    await repo.create(entry);

    const updated = await repo.update(entry.object_id, {
      storage_tier: StorageTier.HOT,
      last_used_at: "2026-03-21T03:30:00.000Z",
      last_hit_at: "2026-03-21T03:30:00.000Z",
      updated_at: "2026-03-21T03:30:00.000Z"
    });

    expect(updated.storage_tier).toBe(StorageTier.HOT);
    expect(updated.last_used_at).toBe("2026-03-21T03:30:00.000Z");
    expect(updated.last_hit_at).toBe("2026-03-21T03:30:00.000Z");
    expect(updated.updated_at).toBe("2026-03-21T03:30:00.000Z");
  });

  it("updates tier and access timestamps only in the requested workspace", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry({
      storage_tier: StorageTier.COLD,
      last_used_at: "2026-03-01T00:00:00.000Z",
      last_hit_at: "2026-03-01T00:00:00.000Z"
    });
    await repo.create(entry);

    await expect(
      repo.updateScoped(entry.object_id, "workspace-2", {
        storage_tier: StorageTier.HOT,
        last_used_at: "2026-03-21T03:30:00.000Z",
        last_hit_at: "2026-03-21T03:30:00.000Z",
        updated_at: "2026-03-21T03:30:00.000Z"
      })
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(repo.findById(entry.object_id)).resolves.toMatchObject({
      storage_tier: StorageTier.COLD,
      last_used_at: "2026-03-01T00:00:00.000Z",
      last_hit_at: "2026-03-01T00:00:00.000Z"
    });

    const updated = await repo.updateScoped(entry.object_id, "workspace-1", {
      storage_tier: StorageTier.HOT,
      last_used_at: "2026-03-21T03:30:00.000Z",
      last_hit_at: "2026-03-21T03:30:00.000Z",
      updated_at: "2026-03-21T03:30:00.000Z"
    });

    expect(updated.storage_tier).toBe(StorageTier.HOT);
    expect(updated.last_used_at).toBe("2026-03-21T03:30:00.000Z");
    expect(updated.last_hit_at).toBe("2026-03-21T03:30:00.000Z");
  });

  it("updates dynamics fields", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry();
    await repo.create(entry);

    const updated = await repo.updateDynamics(
      entry.object_id,
      {
        activation_score: 0.7,
        retention_score: 0.8,
        manifestation_state: "full_eligible",
        last_used_at: "2026-03-21T05:00:00.000Z",
        last_hit_at: "2026-03-21T05:00:00.000Z",
        reinforcement_count: 3,
        contradiction_count: 1,
        superseded_by: "memory-2"
      },
      "2026-03-21T05:00:00.000Z"
    );

    expect(updated.activation_score).toBe(0.7);
    expect(updated.retention_score).toBe(0.8);
    expect(updated.manifestation_state).toBe("full_eligible");
    expect(updated.last_used_at).toBe("2026-03-21T05:00:00.000Z");
    expect(updated.last_hit_at).toBe("2026-03-21T05:00:00.000Z");
    expect(updated.reinforcement_count).toBe(3);
    expect(updated.contradiction_count).toBe(1);
    expect(updated.superseded_by).toBe("memory-2");
    expect(updated.updated_at).toBe("2026-03-21T05:00:00.000Z");
  });
  it("updates retention_state alongside dynamics fields", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry();
    await repo.create(entry);

    const updated = await repo.updateDynamics(
      entry.object_id,
      {
        activation_score: 0.7,
        retention_score: 0.8,
        manifestation_state: "full_eligible",
        retention_state: "canon"
      } as any,
      "2026-03-21T05:00:00.000Z"
    );

    expect(updated.retention_state).toBe("canon");
  });

  it("searches memory content through the FTS supplement index", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "11111111-1111-4111-8111-111111111111",
        content: "Implement recall via FTS keyword supplement."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "22222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Archive unused memories after decay."
      })
    );

    const matches = await (repo as any).searchByKeyword("workspace-1", "recall", 5);

    expect(matches).toEqual([
      expect.objectContaining({
        object_id: "11111111-1111-4111-8111-111111111111",
        normalized_rank: 1
      })
    ]);
  });

  it("normalizes bm25-ordered rows into a meaningful ordinal ladder", async () => {
    const { database, repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "99999999-1111-4111-8111-111111111111",
        content: "Stable review evidence needs exact witness lines."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "aaaaaaaa-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Stable review evidence matters, but exact witnesses matter more."
      })
    );

    const rawMatches = database.connection
      .prepare(
        `
          SELECT object_id, bm25(memory_content_fts) AS raw_rank
          FROM memory_content_fts
          WHERE workspace_id = ? AND memory_content_fts MATCH ?
          ORDER BY raw_rank ASC, object_id ASC
        `
      )
      .all("workspace-1", '"stable"') as Array<{ readonly object_id: string; readonly raw_rank: number }>;
    const normalizedMatches = await repo.searchByKeyword("workspace-1", "stable", 5);

    expect(normalizedMatches.map((match) => match.object_id)).toEqual(
      rawMatches.map((match) => match.object_id)
    );
    expect(normalizedMatches).toHaveLength(2);
    expect(normalizedMatches[0]!.normalized_rank).toBe(1);
    expect(normalizedMatches[1]!.normalized_rank).toBe(0.5);
  });

  it("restores short exact-token matches that trigram MATCH cannot satisfy", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "33333333-1111-4111-8111-111111111111",
        content: "Go build before review."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "44444444-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Rust build before review."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "55555555-3333-4333-8333-333333333333",
        run_id: "run-2",
        content: "Governance reviews need evidence."
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "go", 5)).resolves.toEqual([
      {
        object_id: "33333333-1111-4111-8111-111111111111",
        normalized_rank: 1
      }
    ]);
  });

  it("can filter short-token keyword fallback results to a hot candidate set before the limit bites", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "11111111-1111-4111-8111-111111111111",
        content: "Go archive the oldest report."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "22222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Go prune the stale cache row."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "99999999-9999-4999-8999-999999999999",
        content: "Go keep the hot supplement candidate alive."
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "go", 2)).resolves.toEqual([
      expect.objectContaining({
        object_id: "11111111-1111-4111-8111-111111111111"
      }),
      expect.objectContaining({
        object_id: "22222222-2222-4222-8222-222222222222"
      })
    ]);
    await expect(
      repo.searchByKeywordWithinObjectIds!(
        "workspace-1",
        "go",
        2,
        ["99999999-9999-4999-8999-999999999999"]
      )
    ).resolves.toEqual([
      {
        object_id: "99999999-9999-4999-8999-999999999999",
        normalized_rank: 1
      }
    ]);
  });

  it("excludes tombstoned hot rows from hot-tier recall and short-token keyword fallback", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "11111111-1111-4111-8111-111111111111",
        content: "Go keep the live recall candidate.",
        retention_state: null
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "22222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Go drop the tombstoned recall candidate.",
        retention_state: "tombstoned"
      })
    );

    await expect(repo.findByWorkspaceId("workspace-1")).resolves.toEqual([
      expect.objectContaining({
        object_id: "11111111-1111-4111-8111-111111111111"
      })
    ]);
    await expect(repo.searchByKeyword("workspace-1", "go", 5)).resolves.toEqual([
      {
        object_id: "11111111-1111-4111-8111-111111111111",
        normalized_rank: 1
      }
    ]);
    await expect(
      repo.searchByKeywordWithinObjectIds!(
        "workspace-1",
        "go",
        5,
        [
          "11111111-1111-4111-8111-111111111111",
          "22222222-2222-4222-8222-222222222222"
        ]
      )
    ).resolves.toEqual([
      {
        object_id: "11111111-1111-4111-8111-111111111111",
        normalized_rank: 1
      }
    ]);
  });

  it("matches mid-token substrings after the trigram upgrade", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "55555555-1111-4111-8111-111111111111",
        content: "Canonicalization keeps memory lookup stable across review waves."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "66666666-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Stable reviews still need exact evidence."
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "nicaliza", 5)).resolves.toEqual([
      {
        object_id: "55555555-1111-4111-8111-111111111111",
        normalized_rank: 1,
        trigram_rank: 1
      }
    ]);
  });

  it("matches CJK substrings through the trigram-backed FTS path", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "77777777-3333-4333-8333-333333333333",
        content: "请记住中文路径需要逐字保留，避免命名漂移。"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "88888888-4444-4444-8444-444444444444",
        run_id: "run-2",
        content: "英文路径在这个用例里不重要。"
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "路径需要", 5)).resolves.toEqual([
      {
        object_id: "77777777-3333-4333-8333-333333333333",
        normalized_rank: 1,
        trigram_rank: 1
      }
    ]);
  });

  it("restores short CJK span matches below the trigram boundary", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "99999999-3333-4333-8333-333333333333",
        content: "请记住路径规则必须逐字校验。"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "aaaaaaaa-4444-4444-8444-444444444444",
        run_id: "run-2",
        content: "这条规则与界面布局无关。"
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "路径", 5)).resolves.toEqual([
      {
        object_id: "99999999-3333-4333-8333-333333333333",
        normalized_rank: 1
      }
    ]);
  });

  it("sanitizes FTS special operators before searching", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "33333333-3333-4333-8333-333333333333",
        content: "Use the contentsecret fallback token for recall ranking."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "44444444-4444-4444-8444-444444444444",
        run_id: "run-2",
        content: "A plain secret token should not match the sanitized literal."
      })
    );

    await expect(repo.searchByKeyword("workspace-1", 'content:secret*', 5)).resolves.toEqual([
      {
        object_id: "33333333-3333-4333-8333-333333333333",
        normalized_rank: 1,
        trigram_rank: 1
      }
    ]);
  });

  it("strips NUL bytes from keyword query tokens before FTS matching", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "bbbbbbbb-1111-4111-8111-111111111111",
        content: "The alphabeta token should survive NUL sanitization."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "cccccccc-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "The alpha token alone must not match the sanitized query."
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "alpha\0beta", 5)).resolves.toEqual([
      {
        object_id: "bbbbbbbb-1111-4111-8111-111111111111",
        normalized_rank: 1,
        trigram_rank: 1
      }
    ]);
  });

  it("caps keyword query tokens before building an FTS MATCH expression", async () => {
    const { repo } = await createRepo();
    const boundedTokens = Array.from({ length: 32 }, (_, index) => `absent${index + 1}`);
    await repo.create(
      createMemoryEntry({
        object_id: "dddddddd-3333-4333-8333-333333333333",
        content: "The overlimitmatch token appears only past the bounded query token set."
      })
    );

    await expect(
      repo.searchByKeyword("workspace-1", `${boundedTokens.join(" ")} overlimitmatch`, 5)
    ).resolves.toEqual([]);
  });

  it("only treats retention_state tombstoned entries as GC-eligible", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "55555555-5555-4555-8555-555555555555",
        retention_state: "tombstoned",
        lifecycle_state: "active"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "66666666-6666-4666-8666-666666666666",
        run_id: "run-2",
        retention_state: "canon",
        lifecycle_state: "tombstone"
      })
    );

    await expect(repo.findTombstonedMemories("workspace-1")).resolves.toEqual([
      expect.objectContaining({
        object_id: "55555555-5555-4555-8555-555555555555"
      })
    ]);
    await expect(repo.hardDeleteTombstoned("66666666-6666-4666-8666-666666666666")).rejects.toMatchObject({
      name: "StorageError",
      code: "NOT_FOUND"
    });

    await expect(repo.hardDeleteTombstoned("55555555-5555-4555-8555-555555555555")).resolves.toBeUndefined();
    await expect(repo.findById("55555555-5555-4555-8555-555555555555")).resolves.toBeNull();
  });

  it("autonomousTombstone only fires on a dormant row and writes the durable disposition", async () => {
    const { repo } = await createRepo();
    const dormant = createMemoryEntry({
      object_id: "aaaaaaaa-0000-4000-8000-000000000001",
      lifecycle_state: "dormant"
    });
    await repo.create(dormant);

    const tombstoned = await repo.autonomousTombstone({
      objectId: dormant.object_id,
      disposition: "judged_useless",
      dispositionRef: null,
      updatedAt: "2026-03-22T00:00:00.000Z"
    });
    expect(tombstoned.forget_disposition).toBe("judged_useless");
    expect(tombstoned.forget_disposition_ref).toBeNull();
    expect(tombstoned.retention_state).toBe("tombstoned");
    expect(tombstoned.lifecycle_state).toBe("tombstone");
  });

  it.each([
    ["became pinned", { decay_profile: "pinned" } satisfies Partial<MemoryEntry>],
    ["became hazard", { decay_profile: "hazard" } satisfies Partial<MemoryEntry>],
    ["became canon", { retention_state: "canon" } satisfies Partial<MemoryEntry>],
    ["became consolidated", { retention_state: "consolidated" } satisfies Partial<MemoryEntry>]
  ])("autonomousTombstone atomically REFUSES when a dormant row %s", async (_label, overrides) => {
    const { repo } = await createRepo();
    const protectedDormant = createMemoryEntry({
      object_id: "aaaaaaaa-0000-4000-8000-000000000005",
      lifecycle_state: "dormant",
      evidence_refs: [],
      reinforcement_count: 0,
      ...overrides
    });
    await repo.create(protectedDormant);
    const onTransition = vi.fn();

    await expect(
      repo.autonomousTombstone(
        {
          objectId: protectedDormant.object_id,
          disposition: "judged_useless",
          dispositionRef: null,
          updatedAt: "2026-03-22T00:00:00.000Z"
        },
        { onTransition }
      )
    ).rejects.toMatchObject({ name: "StorageError", code: "NOT_FOUND" });
    expect(onTransition).not.toHaveBeenCalled();
    await expect(repo.findById(protectedDormant.object_id)).resolves.toEqual(
      expect.objectContaining({
        lifecycle_state: "dormant",
        forget_disposition: null,
        forget_disposition_ref: null,
        ...overrides
      })
    );
  });

  it("autonomousTombstone rolls the tombstone update back when the transition audit callback throws", async () => {
    const { repo } = await createRepo();
    const dormant = createMemoryEntry({
      object_id: "aaaaaaaa-0000-4000-8000-000000000004",
      lifecycle_state: "dormant"
    });
    await repo.create(dormant);
    const onTransition = vi.fn(() => {
      throw new Error("audit append failed mid-transaction");
    });

    await expect(
      repo.autonomousTombstone(
        {
          objectId: dormant.object_id,
          disposition: "judged_useless",
          dispositionRef: null,
          updatedAt: "2026-03-22T00:00:00.000Z"
        },
        { onTransition }
      )
    ).rejects.toThrow(StorageError);
    expect(onTransition).toHaveBeenCalledTimes(1);
    await expect(repo.findById(dormant.object_id)).resolves.toEqual(
      expect.objectContaining({
        lifecycle_state: "dormant",
        retention_state: null,
        forget_disposition: null,
        forget_disposition_ref: null
      })
    );
  });

  it("autonomousTombstone refuses a non-dormant (active) row — recallable memory is never silently tombstoned", async () => {
    const { repo } = await createRepo();
    const active = createMemoryEntry({
      object_id: "aaaaaaaa-0000-4000-8000-000000000002",
      lifecycle_state: "active"
    });
    await repo.create(active);

    await expect(
      repo.autonomousTombstone({
        objectId: active.object_id,
        disposition: "judged_useless",
        dispositionRef: null,
        updatedAt: "2026-03-22T00:00:00.000Z"
      })
    ).rejects.toMatchObject({ name: "StorageError", code: "NOT_FOUND" });

    const reloaded = await repo.findById(active.object_id);
    expect(reloaded?.lifecycle_state).toBe("active");
    expect(reloaded?.forget_disposition ?? null).toBeNull();
  });

  it("autonomousTombstone rejects a malformed compressed marker without a capsule ref", async () => {
    const { repo } = await createRepo();
    const dormant = createMemoryEntry({
      object_id: "aaaaaaaa-0000-4000-8000-000000000003",
      lifecycle_state: "dormant"
    });
    await repo.create(dormant);

    await expect(
      repo.autonomousTombstone({
        objectId: dormant.object_id,
        disposition: "compressed",
        dispositionRef: null,
        updatedAt: "2026-03-22T00:00:00.000Z"
      })
    ).rejects.toMatchObject({ name: "StorageError", code: "VALIDATION_FAILED" });
  });

  it("hardDeleteTombstonedWithDisposition refuses a tombstoned row that has NO disposition (defense in depth)", async () => {
    const { repo } = await createRepo();
    // A human-Inspector-style tombstone: retention_state tombstoned, past grace,
    // but no forget_disposition. The autonomous GC authority must refuse it.
    const humanTombstoned = createMemoryEntry({
      object_id: "bbbbbbbb-0000-4000-8000-000000000001",
      retention_state: "tombstoned",
      lifecycle_state: "tombstone"
    });
    await repo.create(humanTombstoned);

    await expect(
      repo.hardDeleteTombstonedWithDisposition(humanTombstoned.object_id)
    ).rejects.toMatchObject({ name: "StorageError", code: "NOT_FOUND" });
    await expect(repo.findById(humanTombstoned.object_id)).resolves.not.toBeNull();
  });

  it("hardDeleteTombstonedWithDisposition removes a tombstoned+past-grace row that carries a disposition", async () => {
    const { repo } = await createRepo();
    const disposed = createMemoryEntry({
      object_id: "bbbbbbbb-0000-4000-8000-000000000002",
      retention_state: "tombstoned",
      lifecycle_state: "tombstone",
      forget_disposition: "judged_useless",
      forget_disposition_ref: null
    });
    await repo.create(disposed);

    await expect(
      repo.findTombstonedMemoriesWithDisposition("workspace-1")
    ).resolves.toEqual([expect.objectContaining({ object_id: disposed.object_id })]);
    await expect(
      repo.hardDeleteTombstonedWithDisposition(disposed.object_id)
    ).resolves.toBe(true);
    await expect(repo.findById(disposed.object_id)).resolves.toBeNull();
  });

  it("hardDeleteTombstonedWithDisposition (judged_useless-guarded) deletes only while the verdict still holds", async () => {
    const { repo } = await createRepo();
    const disposed = createMemoryEntry({
      object_id: "bbbbbbbb-0000-4000-8000-000000000003",
      retention_state: "tombstoned",
      lifecycle_state: "tombstone",
      forget_disposition: "judged_useless",
      forget_disposition_ref: null,
      evidence_refs: [],
      reinforcement_count: 0,
      decay_profile: null
    });
    await repo.create(disposed);
    const onDeleted = vi.fn();

    await expect(
      repo.hardDeleteTombstonedWithDisposition(disposed.object_id, {
        requireJudgedUselessVerdict: true,
        onDeleted
      })
    ).resolves.toBe(true);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    await expect(repo.findById(disposed.object_id)).resolves.toBeNull();
  });

  it.each([
    ["gained evidence", { evidence_refs: ["late-evidence"] } satisfies Partial<MemoryEntry>],
    ["gained reinforcement", { reinforcement_count: 1 } satisfies Partial<MemoryEntry>],
    ["became pinned", { decay_profile: "pinned" } satisfies Partial<MemoryEntry>],
    ["became hazard", { decay_profile: "hazard" } satisfies Partial<MemoryEntry>],
    ["became canon", { retention_state: "canon" } satisfies Partial<MemoryEntry>],
    ["became consolidated", { retention_state: "consolidated" } satisfies Partial<MemoryEntry>]
  ])(
    "hardDeleteTombstonedWithDisposition (judged_useless-guarded) atomically REFUSES when the row %s",
    async (_label, overrides) => {
      const { repo } = await createRepo();
      const disposed = createMemoryEntry({
        object_id: "bbbbbbbb-0000-4000-8000-000000000004",
        retention_state: "tombstoned",
        lifecycle_state: "tombstone",
        forget_disposition: "judged_useless",
        forget_disposition_ref: null,
        evidence_refs: [],
        reinforcement_count: 0,
        decay_profile: null,
        ...overrides
      });
      await repo.create(disposed);
      const onDeleted = vi.fn();

      await expect(
        repo.hardDeleteTombstonedWithDisposition(disposed.object_id, {
          requireJudgedUselessVerdict: true,
          onDeleted
        })
      ).resolves.toBe(false);
      expect(onDeleted).not.toHaveBeenCalled();
      await expect(repo.findById(disposed.object_id)).resolves.not.toBeNull();
    }
  );

  it("hardDeleteTombstonedWithDisposition (judged_useless-guarded) rolls back the physical delete when onDeleted throws", async () => {
    const { repo } = await createRepo();
    const disposed = createMemoryEntry({
      object_id: "bbbbbbbb-0000-4000-8000-000000000005",
      retention_state: "tombstoned",
      lifecycle_state: "tombstone",
      forget_disposition: "judged_useless",
      forget_disposition_ref: null,
      evidence_refs: [],
      reinforcement_count: 0,
      decay_profile: null
    });
    await repo.create(disposed);
    const onDeleted = vi.fn(() => {
      throw new Error("audit append failed mid-transaction");
    });

    await expect(
      repo.hardDeleteTombstonedWithDisposition(disposed.object_id, {
        requireJudgedUselessVerdict: true,
        onDeleted
      })
    ).rejects.toThrow(StorageError);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    await expect(repo.findById(disposed.object_id)).resolves.not.toBeNull();
  });

  // invariant: the compressed delete (requireLiveCapsuleRef) re-asserts capsule
  // liveness + membership ATOMICALLY in the DELETE statement, so there is no
  // window between a re-check and the physical removal. A capsule that archived /
  // tombstoned / dropped the member / was deleted makes the guard match 0 rows,
  // and the member survives (recoverable). see also:
  // packages/core/src/memory/memory-service/service.ts:MemoryService.autonomousHardDeleteTombstoned.
  async function seedCompressedMember(input: {
    readonly memoryId: string;
    readonly capsule: Partial<SynthesisCapsule> | null;
    readonly capsuleId: string;
    readonly memory?: Partial<MemoryEntry>;
  }): Promise<{ readonly repo: SqliteMemoryEntryRepo }> {
    const { repo, database } = await createRepo();
    if (input.capsule !== null) {
      const capsuleRepo = new SqliteSynthesisCapsuleRepo(database);
      await capsuleRepo.create({
        object_id: input.capsuleId,
        object_kind: "synthesis_capsule",
        schema_version: 1,
        lifecycle_state: "active",
        created_at: "2026-03-21T00:00:00.000Z",
        updated_at: "2026-03-21T00:00:00.000Z",
        created_by: "consolidation-executor",
        topic_key: "tooling/pnpm",
        synthesis_type: "phase_synthesis",
        summary: "Use pnpm for workspace commands.",
        evidence_refs: ["evidence-1"],
        source_memory_refs: [input.memoryId],
        workspace_id: "workspace-1",
        run_id: "run-1",
        synthesis_status: SynthesisStatus.STABLE,
        ...input.capsule
      });
    }
    await repo.create(
      createMemoryEntry({
        object_id: input.memoryId,
        retention_state: "tombstoned",
        lifecycle_state: "tombstone",
        forget_disposition: "compressed",
        forget_disposition_ref: input.capsuleId,
        ...input.memory
      })
    );
    return { repo };
  }

  it("hardDeleteTombstonedWithDisposition (compressed-guarded) removes the member only when a live capsule STILL references it", async () => {
    const memoryId = "dddddddd-0000-4000-8000-000000000001";
    const capsuleId = "dddddddd-1111-4000-8000-000000000001";
    const { repo } = await seedCompressedMember({ memoryId, capsuleId, capsule: {} });

    await expect(
      repo.hardDeleteTombstonedWithDisposition(memoryId, { requireLiveCapsuleRef: true })
    ).resolves.toBe(true);
    await expect(repo.findById(memoryId)).resolves.toBeNull();
  });

  it.each([
    ["capsule archived", { synthesis_status: SynthesisStatus.ARCHIVED } satisfies Partial<SynthesisCapsule>],
    ["capsule tombstoned/superseded", { lifecycle_state: "tombstone" } satisfies Partial<SynthesisCapsule>],
    ["capsule dropped the member", { source_memory_refs: [] } satisfies Partial<SynthesisCapsule>]
  ])(
    "hardDeleteTombstonedWithDisposition (compressed-guarded) atomically REFUSES (0 rows, member survives) when %s",
    async (_label, capsule) => {
      const memoryId = "dddddddd-0000-4000-8000-000000000002";
      const capsuleId = "dddddddd-1111-4000-8000-000000000002";
      const { repo } = await seedCompressedMember({ memoryId, capsuleId, capsule });

      await expect(
        repo.hardDeleteTombstonedWithDisposition(memoryId, { requireLiveCapsuleRef: true })
      ).resolves.toBe(false);
      await expect(repo.findById(memoryId)).resolves.not.toBeNull();
    }
  );

  it("hardDeleteTombstonedWithDisposition (compressed-guarded) atomically REFUSES when the preserving capsule was cascade-deleted", async () => {
    const memoryId = "dddddddd-0000-4000-8000-000000000003";
    const capsuleId = "dddddddd-1111-4000-8000-000000000003";
    const { repo } = await seedCompressedMember({ memoryId, capsuleId, capsule: null });

    await expect(
      repo.hardDeleteTombstonedWithDisposition(memoryId, { requireLiveCapsuleRef: true })
    ).resolves.toBe(false);
    await expect(repo.findById(memoryId)).resolves.not.toBeNull();
  });

  it.each([
    ["member became pinned", { decay_profile: "pinned" } satisfies Partial<MemoryEntry>],
    ["member became hazard", { decay_profile: "hazard" } satisfies Partial<MemoryEntry>],
    ["member became canon", { retention_state: "canon" } satisfies Partial<MemoryEntry>],
    ["member became consolidated", { retention_state: "consolidated" } satisfies Partial<MemoryEntry>]
  ])(
    "hardDeleteTombstonedWithDisposition (compressed-guarded) atomically REFUSES when %s",
    async (_label, memory) => {
      const memoryId = "dddddddd-0000-4000-8000-000000000007";
      const capsuleId = "dddddddd-1111-4000-8000-000000000007";
      const { repo } = await seedCompressedMember({ memoryId, capsuleId, capsule: {}, memory });

      await expect(
        repo.hardDeleteTombstonedWithDisposition(memoryId, { requireLiveCapsuleRef: true })
      ).resolves.toBe(false);
      await expect(repo.findById(memoryId)).resolves.not.toBeNull();
    }
  );

  // invariant (I-2): the caller's deleted-audit append (onDeleted) shares the
  // delete transaction, so the physical removal and the audit commit or roll
  // back together. onDeleted runs ONLY on changes>0 and a throw inside it undoes
  // the physical delete.
  it("hardDeleteTombstonedWithDisposition (compressed-guarded) fires onDeleted exactly once when a row is removed", async () => {
    const memoryId = "dddddddd-0000-4000-8000-000000000004";
    const capsuleId = "dddddddd-1111-4000-8000-000000000004";
    const { repo } = await seedCompressedMember({ memoryId, capsuleId, capsule: {} });
    const onDeleted = vi.fn();

    await expect(
      repo.hardDeleteTombstonedWithDisposition(memoryId, { requireLiveCapsuleRef: true, onDeleted })
    ).resolves.toBe(true);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    await expect(repo.findById(memoryId)).resolves.toBeNull();
  });

  it("hardDeleteTombstonedWithDisposition (compressed-guarded) does NOT fire onDeleted on a 0-row preservation-revoked race", async () => {
    const memoryId = "dddddddd-0000-4000-8000-000000000005";
    const capsuleId = "dddddddd-1111-4000-8000-000000000005";
    const { repo } = await seedCompressedMember({
      memoryId,
      capsuleId,
      capsule: { source_memory_refs: [] }
    });
    const onDeleted = vi.fn();

    await expect(
      repo.hardDeleteTombstonedWithDisposition(memoryId, { requireLiveCapsuleRef: true, onDeleted })
    ).resolves.toBe(false);
    expect(onDeleted).not.toHaveBeenCalled();
    await expect(repo.findById(memoryId)).resolves.not.toBeNull();
  });

  it("hardDeleteTombstonedWithDisposition (compressed-guarded) rolls the physical delete back when onDeleted throws (one transaction)", async () => {
    const memoryId = "dddddddd-0000-4000-8000-000000000006";
    const capsuleId = "dddddddd-1111-4000-8000-000000000006";
    const { repo } = await seedCompressedMember({ memoryId, capsuleId, capsule: {} });
    const onDeleted = vi.fn(() => {
      throw new Error("audit append failed mid-transaction");
    });

    await expect(
      repo.hardDeleteTombstonedWithDisposition(memoryId, { requireLiveCapsuleRef: true, onDeleted })
    ).rejects.toThrow(StorageError);
    expect(onDeleted).toHaveBeenCalledTimes(1);
    // The audit-append throw rolled the whole transaction back: the row survives.
    await expect(repo.findById(memoryId)).resolves.not.toBeNull();
  });

  it("findTombstonedMemoriesWithDisposition excludes tombstoned rows lacking a disposition", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "cccccccc-0000-4000-8000-000000000001",
        retention_state: "tombstoned",
        lifecycle_state: "tombstone"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "cccccccc-0000-4000-8000-000000000002",
        retention_state: "tombstoned",
        lifecycle_state: "tombstone",
        forget_disposition: "compressed",
        forget_disposition_ref: "capsule-9"
      })
    );

    await expect(
      repo.findTombstonedMemoriesWithDisposition("workspace-1")
    ).resolves.toEqual([
      expect.objectContaining({ object_id: "cccccccc-0000-4000-8000-000000000002" })
    ]);
  });

  it("I3: transitionLifecycle to a NON-tombstone state clears the forget marker", async () => {
    const { repo } = await createRepo();
    // A row that carries a stale terminal-removal marker (e.g. import-carried, or
    // tombstoned then revived). Any non-tombstone transition must strip it so the
    // autonomous GC can never physically delete a revived/active row.
    const marked = createMemoryEntry({
      object_id: "dddddddd-0000-4000-8000-000000000001",
      lifecycle_state: "dormant",
      forget_disposition: "compressed",
      forget_disposition_ref: "capsule-stale"
    });
    await repo.create(marked);

    const revived = await repo.transitionLifecycle(marked.object_id, "active", "2026-03-22T00:00:00.000Z");
    expect(revived.lifecycle_state).toBe("active");
    expect(revived.forget_disposition).toBeNull();
    expect(revived.forget_disposition_ref).toBeNull();
  });

  it("I3: transitionLifecycle to tombstone KEEPS the forget marker (GC authorization)", async () => {
    const { repo } = await createRepo();
    const marked = createMemoryEntry({
      object_id: "dddddddd-0000-4000-8000-000000000002",
      lifecycle_state: "dormant",
      forget_disposition: "judged_useless",
      forget_disposition_ref: null
    });
    await repo.create(marked);

    const tombstoned = await repo.transitionLifecycle(marked.object_id, "tombstone", "2026-03-22T00:00:00.000Z");
    expect(tombstoned.lifecycle_state).toBe("tombstone");
    expect(tombstoned.forget_disposition).toBe("judged_useless");
  });

  it("N1: reviveDormant flips a dormant row to active and clears the forget marker", async () => {
    const { repo } = await createRepo();
    const dormant = createMemoryEntry({
      object_id: "eeeeeeee-0000-4000-8000-000000000001",
      lifecycle_state: "dormant",
      forget_disposition: "compressed",
      forget_disposition_ref: "capsule-y"
    });
    await repo.create(dormant);

    const revived = await repo.reviveDormant(dormant.object_id, "2026-03-22T00:00:00.000Z");
    expect(revived?.lifecycle_state).toBe("active");
    expect(revived?.forget_disposition).toBeNull();
    expect(revived?.forget_disposition_ref).toBeNull();
  });

  it("N1: reviveDormant is a guarded no-op (returns null) for an already-active row", async () => {
    const { repo } = await createRepo();
    const active = createMemoryEntry({
      object_id: "eeeeeeee-0000-4000-8000-000000000002",
      lifecycle_state: "active"
    });
    await repo.create(active);

    await expect(repo.reviveDormant(active.object_id, "2026-03-22T00:00:00.000Z")).resolves.toBeNull();
    expect((await repo.findById(active.object_id))?.lifecycle_state).toBe("active");
  });

  // invariant (I-1): guarded active -> dormant demotion. onTransition (the
  // active->dormant audit append) shares the UPDATE transaction; a 0-row guard
  // (row not active) is a benign no-op skip, never an audit and never a throw.
  it("transitionToDormantIfActive demotes an active row, clears the forget marker, and fires onTransition once", async () => {
    const { repo } = await createRepo();
    const active = createMemoryEntry({
      object_id: "ffffffff-0000-4000-8000-000000000001",
      lifecycle_state: "active",
      forget_disposition: "compressed",
      forget_disposition_ref: "capsule-z"
    });
    await repo.create(active);
    const onTransition = vi.fn();

    const demoted = await repo.transitionToDormantIfActive(
      active.object_id,
      "2026-03-22T00:00:00.000Z",
      onTransition
    );
    expect(onTransition).toHaveBeenCalledTimes(1);
    expect(demoted?.lifecycle_state).toBe("dormant");
    expect(demoted?.forget_disposition).toBeNull();
    expect(demoted?.forget_disposition_ref).toBeNull();
  });

  it("transitionToDormantIfActive is a guarded no-op (null, no onTransition) for a row that is not active", async () => {
    const { repo } = await createRepo();
    const dormant = createMemoryEntry({
      object_id: "ffffffff-0000-4000-8000-000000000002",
      lifecycle_state: "dormant"
    });
    await repo.create(dormant);
    const onTransition = vi.fn();

    await expect(
      repo.transitionToDormantIfActive(dormant.object_id, "2026-03-22T00:00:00.000Z", onTransition)
    ).resolves.toBeNull();
    expect(onTransition).not.toHaveBeenCalled();
    expect((await repo.findById(dormant.object_id))?.lifecycle_state).toBe("dormant");
  });

  it("transitionToDormantIfActive rolls the demotion back when onTransition throws (one transaction)", async () => {
    const { repo } = await createRepo();
    const active = createMemoryEntry({
      object_id: "ffffffff-0000-4000-8000-000000000003",
      lifecycle_state: "active"
    });
    await repo.create(active);
    const onTransition = vi.fn(() => {
      throw new Error("active->dormant audit append failed mid-transaction");
    });

    await expect(
      repo.transitionToDormantIfActive(active.object_id, "2026-03-22T00:00:00.000Z", onTransition)
    ).rejects.toThrow(StorageError);
    expect(onTransition).toHaveBeenCalledTimes(1);
    // The audit-append throw rolled the UPDATE back: the row stays active.
    expect((await repo.findById(active.object_id))?.lifecycle_state).toBe("active");
  });


  it("throws NOT_FOUND when updating dynamics for a missing entry", async () => {
    const { repo } = await createRepo();

    await expect(
      repo.updateDynamics(
        "missing-memory-id",
        {
          activation_score: 0.4,
          retention_score: 0.6,
          manifestation_state: "hint"
        },
        "2026-03-21T06:00:00.000Z"
      )
    ).rejects.toMatchObject({
      name: "StorageError",
      code: "NOT_FOUND"
    });
  });

  it("archives an entry by setting lifecycle_state to archived", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry();
    await repo.create(entry);

    const archived = await repo.archive(entry.object_id, "2026-03-21T04:00:00.000Z");
    expect(archived.lifecycle_state).toBe("archived");
    expect(archived.updated_at).toBe("2026-03-21T04:00:00.000Z");
  });

  it("keeps all dynamics fields null in phase 1B", async () => {
    const { repo } = await createRepo();
    const created = await repo.create(createMemoryEntry());

    expect(created.activation_score).toBeNull();
    expect(created.retention_score).toBeNull();
    expect(created.manifestation_state).toBeNull();
    expect(created.retention_state).toBeNull();
    expect(created.decay_profile).toBeNull();
    expect(created.confidence).toBeNull();
    expect(created.last_used_at).toBeNull();
    expect(created.last_hit_at).toBeNull();
    expect(created.reinforcement_count).toBeNull();
    expect(created.contradiction_count).toBeNull();
    expect(created.superseded_by).toBeNull();
  });

  it("round-trips domain_tags and evidence_refs JSON fields", async () => {
    const { repo } = await createRepo();
    const entry = createMemoryEntry({
      object_id: "4f5af11e-03be-4248-8a89-2180b99c7158",
      domain_tags: ["a", "b"],
      evidence_refs: ["e1", "e2", "e3"]
    });

    await repo.create(entry);
    const loaded = await repo.findById(entry.object_id);

    expect(loaded?.domain_tags).toEqual(["a", "b"]);
    expect(loaded?.evidence_refs).toEqual(["e1", "e2", "e3"]);
  });

  it("returns immutable entries", async () => {
    const { repo } = await createRepo();
    const created = await repo.create(createMemoryEntry());

    expect(() => {
      (created as any).content = "mutated";
    }).toThrow(TypeError);
  });

  it("matches an English query through the porter word-stemmed FTS index", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "e1111111-1111-4111-8111-111111111111",
        content: "The team agreed to refactor the recall ranking pipeline."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "e2222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "Governance reviews need durable evidence."
      })
    );

    // "agree" / "refactoring" only match via porter stemming of the stored
    // "agreed" / "refactor"; the trigram table cannot bridge these.
    // "agree" is a literal substring of stored "agreed", so the trigram lane
    // also hits and surfaces a trigram_rank alongside the porter rank.
    await expect(repo.searchByKeyword("workspace-1", "agree", 5)).resolves.toEqual([
      { object_id: "e1111111-1111-4111-8111-111111111111", normalized_rank: 1, trigram_rank: 1 }
    ]);
    // "refactoring" only bridges via porter stemming of stored "refactor";
    // the trigram lane cannot match it, so no trigram_rank is surfaced.
    await expect(repo.searchByKeyword("workspace-1", "refactoring", 5)).resolves.toEqual([
      { object_id: "e1111111-1111-4111-8111-111111111111", normalized_rank: 1 }
    ]);
  });

  it("matches a Chinese query through the trigram index in the dual-index setup", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "c1111111-1111-4111-8111-111111111111",
        content: "请记住中文路径需要逐字保留，避免命名漂移。"
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "c2222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "英文路径在这个用例里不重要。"
      })
    );

    await expect(repo.searchByKeyword("workspace-1", "中文路径", 5)).resolves.toEqual([
      { object_id: "c1111111-1111-4111-8111-111111111111", normalized_rank: 1, trigram_rank: 1 }
    ]);
  });

  it("routes a mixed Chinese-and-English query across both FTS indexes", async () => {
    const { repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "d1111111-1111-4111-8111-111111111111",
        content: "The migration agreed to keep 中文路径 stable."
      })
    );
    await repo.create(
      createMemoryEntry({
        object_id: "d2222222-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "An unrelated note about deployment scripts."
      })
    );

    const matches = await repo.searchByKeyword("workspace-1", "agreed 中文路径", 5);
    expect(matches.map((match) => match.object_id)).toEqual([
      "d1111111-1111-4111-8111-111111111111"
    ]);
  });

  it("backfills the porter FTS index from rows that pre-date the porter table", async () => {
    const { database, repo } = await createRepo();
    await repo.create(
      createMemoryEntry({
        object_id: "f1111111-1111-4111-8111-111111111111",
        content: "Indexing reconciliation collapses duplicated facts."
      })
    );

    // Simulate an existing database that pre-dates migration 077: drop the
    // porter table and its triggers, then re-run the migration's backfill +
    // trigger SQL. A correct migration must reindex the pre-existing row.
    database.connection.exec(`
      DROP TRIGGER IF EXISTS memory_content_fts_porter_ai;
      DROP TRIGGER IF EXISTS memory_content_fts_porter_ad;
      DROP TRIGGER IF EXISTS memory_content_fts_porter_au;
      DROP TABLE IF EXISTS memory_content_fts_porter;
    `);

    const migrationsDir = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../../../migrations"
    );
    const migrationSql = fs.readFileSync(
      path.join(migrationsDir, "077-memory-content-fts-dual.sql"),
      "utf8"
    );
    database.connection.exec(migrationSql);

    const porterRows = database.connection
      .prepare(
        `SELECT object_id FROM memory_content_fts_porter
         WHERE workspace_id = ? AND memory_content_fts_porter MATCH ?`
      )
      .all("workspace-1", '"duplicate"') as Array<{ readonly object_id: string }>;

    expect(porterRows.map((row) => row.object_id)).toEqual([
      "f1111111-1111-4111-8111-111111111111"
    ]);
  });

  it("keeps the porter FTS index live on delete and content update", async () => {
    const { database, repo } = await createRepo();
    const entry = await repo.create(
      createMemoryEntry({
        object_id: "a9999999-1111-4111-8111-111111111111",
        content: "The scheduler retried the stalled task."
      })
    );

    const porterMatch = (token: string): readonly string[] =>
      (
        database.connection
          .prepare(
            `SELECT object_id FROM memory_content_fts_porter
             WHERE workspace_id = ? AND memory_content_fts_porter MATCH ?`
          )
          .all("workspace-1", `"${token}"`) as Array<{ readonly object_id: string }>
      ).map((row) => row.object_id);

    expect(porterMatch("retry")).toEqual(["a9999999-1111-4111-8111-111111111111"]);

    await repo.update(entry.object_id, {
      content: "The scheduler cancelled the queued job.",
      updated_at: "2026-03-21T01:00:00.000Z"
    });
    expect(porterMatch("retry")).toEqual([]);
    expect(porterMatch("cancel")).toEqual(["a9999999-1111-4111-8111-111111111111"]);

    await repo.hardDeleteTombstoned(entry.object_id).catch(() => undefined);
    await repo.create(
      createMemoryEntry({
        object_id: "b9999999-2222-4222-8222-222222222222",
        run_id: "run-2",
        content: "A second deletable note about caching."
      })
    );
    database.connection
      .prepare("DELETE FROM memory_entries WHERE object_id = ?")
      .run("b9999999-2222-4222-8222-222222222222");
    expect(porterMatch("cach")).toEqual([]);
  });

  it("findBySharedDomainTags returns memories sharing >=1 tag, excludes zero-shared, is workspace-scoped, and dedupes", async () => {
    const { repo } = await createRepo();

    // shares one tag ("coffee") with the query.
    const sharesOne = createMemoryEntry({
      object_id: "11111111-1111-4111-8111-111111111111",
      domain_tags: ["coffee", "beans"]
    });
    // shares two tags -- must still appear exactly once (dedupe across the
    // json_each expansion).
    const sharesTwo = createMemoryEntry({
      object_id: "22222222-2222-4222-8222-222222222222",
      run_id: "run-2",
      domain_tags: ["coffee", "tea"]
    });
    // shares zero tags -- excluded.
    const sharesNone = createMemoryEntry({
      object_id: "33333333-3333-4333-8333-333333333333",
      run_id: "run-2",
      domain_tags: ["kettle", "mug"]
    });
    // empty tag array -- json_each yields no rows, so excluded.
    const noTags = createMemoryEntry({
      object_id: "44444444-4444-4444-8444-444444444444",
      run_id: "run-1",
      domain_tags: []
    });
    // matching tag but a DIFFERENT workspace -- must not leak across scope.
    const otherWorkspace = createMemoryEntry({
      object_id: "55555555-5555-4555-8555-555555555555",
      workspace_id: "workspace-2",
      run_id: "run-3",
      domain_tags: ["coffee"]
    });

    await repo.create(sharesOne);
    await repo.create(sharesTwo);
    await repo.create(sharesNone);
    await repo.create(noTags);
    await repo.create(otherWorkspace);

    const rows = await repo.findBySharedDomainTags("workspace-1", ["coffee", "tea"]);
    const ids = rows.map((row) => row.object_id);

    // sharesOne + sharesTwo only; each once; no zero-shared, no empty-tag,
    // no cross-workspace leak.
    expect(ids).toEqual([sharesOne.object_id, sharesTwo.object_id]);
  });

  it("findBySharedDomainTags returns empty for an empty tag query", async () => {
    const { repo } = await createRepo();
    await repo.create(createMemoryEntry({ domain_tags: ["coffee"] }));

    await expect(repo.findBySharedDomainTags("workspace-1", [])).resolves.toEqual([]);
  });

  it("findBySharedDomainTags excludes cold-tier and tombstoned rows (matches findByWorkspaceId hot scope)", async () => {
    const { repo } = await createRepo();

    const hot = createMemoryEntry({
      object_id: "1a111111-1111-4111-8111-111111111111",
      storage_tier: StorageTier.HOT,
      domain_tags: ["coffee"]
    });
    const cold = createMemoryEntry({
      object_id: "2a222222-2222-4222-8222-222222222222",
      run_id: "run-2",
      storage_tier: StorageTier.COLD,
      domain_tags: ["coffee"]
    });
    const tombstoned = createMemoryEntry({
      object_id: "3a333333-3333-4333-8333-333333333333",
      run_id: "run-2",
      storage_tier: StorageTier.HOT,
      retention_state: "tombstoned",
      domain_tags: ["coffee"]
    });

    await repo.create(hot);
    await repo.create(cold);
    await repo.create(tombstoned);

    const rows = await repo.findBySharedDomainTags("workspace-1", ["coffee"]);
    expect(rows.map((row) => row.object_id)).toEqual([hot.object_id]);
  });

  it("findByEvidenceRefs warns at the input cap and stays fail-safe", async () => {
    const { database } = await createRepo();
    const diagnostics = vi.fn<MemoryEntryRepoDiagnosticSink>();
    const repo = new SqliteMemoryEntryRepo(database, diagnostics);

    // input over the cap -> ids beyond the cap are never queried (fail-safe),
    // and the warn-level diagnostic surfaces the over-cap input to operators.
    const overCap = Array.from(
      { length: FIND_BY_EVIDENCE_REFS_INPUT_CAP + 5 },
      (_unused, index) => `evidence-${index}`
    );
    await repo.findByEvidenceRefs("workspace-1", overCap);

    expect(diagnostics).toHaveBeenCalledTimes(1);
    expect(diagnostics).toHaveBeenCalledWith("memory evidence-ref lookup input truncated", {
      workspace_id: "workspace-1",
      input_count: FIND_BY_EVIDENCE_REFS_INPUT_CAP + 5,
      capped_count: FIND_BY_EVIDENCE_REFS_INPUT_CAP
    });
  });

  it("findByEvidenceRefs does not warn when the input is within the cap", async () => {
    const { database } = await createRepo();
    const diagnostics = vi.fn<MemoryEntryRepoDiagnosticSink>();
    const repo = new SqliteMemoryEntryRepo(database, diagnostics);

    await repo.findByEvidenceRefs("workspace-1", ["evidence-1", "evidence-2"]);

    expect(diagnostics).not.toHaveBeenCalled();
  });
});

async function createRepo(): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly repo: SqliteMemoryEntryRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);

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

  await runRepo.create({
    run_id: "run-1",
    workspace_id: "workspace-1",
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  await runRepo.create({
    run_id: "run-2",
    workspace_id: "workspace-1",
    title: "run two",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });
  await runRepo.create({
    run_id: "run-3",
    workspace_id: "workspace-2",
    title: "run three",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });

  return {
    database,
    repo: new SqliteMemoryEntryRepo(database)
  };
}
