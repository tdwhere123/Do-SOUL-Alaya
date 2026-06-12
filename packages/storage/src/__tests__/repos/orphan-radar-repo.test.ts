import { afterEach, describe, expect, it } from "vitest";
import {
  FormationKind,
  MemoryDimension,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type MemoryEntry,
  type OrphanRadar
} from "@do-soul/alaya-protocol";
import { initDatabase } from "../../sqlite/db.js";
import { SqliteMemoryEntryRepo } from "../../repos/memory-entry-repo.js";
import { SqliteOrphanRadarRepo } from "../../repos/health/orphan-radar-repo.js";
import { SqliteRunRepo } from "../../repos/run-repo.js";
import { SqliteWorkspaceRepo } from "../../repos/workspace-repo.js";

const databases = new Set<ReturnType<typeof initDatabase>>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }

  databases.clear();
});

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "7f7204d1-96e0-4ad0-bc85-ec8322bcd4ac",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-28T00:00:00.000Z",
    updated_at: "2026-03-28T00:00:00.000Z",
    created_by: "user_action",
    dimension: MemoryDimension.FACT,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "A memory that may need review.",
    domain_tags: ["memory"],
    evidence_refs: ["evidence-1"],
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
    ...overrides
  };
}

function createMemoryId(index: number): string {
  return `00000000-0000-4000-8000-${index.toString().padStart(12, "0")}`;
}

function createOrphanRadar(overrides: Partial<OrphanRadar> = {}): OrphanRadar {
  return {
    radar_id: "radar-1",
    target_memory_id: createMemoryId(1),
    workspace_id: "workspace-1",
    suspected_surface_gaps: ["surface-a"],
    suggested_action: "re_anchor_candidate",
    confidence: 0.7,
    detected_at: "2026-03-28T00:00:00.000Z",
    expires_at: "2026-03-30T00:00:00.000Z",
    requires_review: true,
    ...overrides
  };
}

async function createMemory(
  memoryRepo: SqliteMemoryEntryRepo,
  objectId: string,
  runId = "run-1"
): Promise<void> {
  await memoryRepo.create(createMemoryEntry({ object_id: objectId, run_id: runId }));
}

describe("SqliteOrphanRadarRepo", () => {
  it("stores orphan radar records and filters active rows by expiry", async () => {
    const { database, memoryRepo } = await createRepo();
    const repo = new SqliteOrphanRadarRepo(database);
    const activeMemoryId = createMemoryId(1);
    const expiredMemoryId = createMemoryId(2);

    await createMemory(memoryRepo, activeMemoryId);
    await createMemory(memoryRepo, expiredMemoryId, "run-2");

    const active = createOrphanRadar({
      radar_id: "radar-1",
      target_memory_id: activeMemoryId,
      detected_at: "2026-03-28T00:00:00.000Z",
      expires_at: "2026-03-30T00:00:00.000Z"
    });
    const expired = createOrphanRadar({
      radar_id: "radar-2",
      target_memory_id: expiredMemoryId,
      suspected_surface_gaps: ["surface-b"],
      suggested_action: "archive_candidate",
      confidence: 0.3,
      detected_at: "2026-03-27T00:00:00.000Z",
      expires_at: "2026-03-27T12:00:00.000Z"
    });

    expect(repo.create(active)).toEqual(active);
    expect(repo.create(expired)).toEqual(expired);
    await expect(repo.findById("radar-1")).resolves.toEqual(active);
    await expect(repo.findActiveByWorkspaceId("workspace-1", "2026-03-28T12:00:00.000Z")).resolves.toEqual([
      active
    ]);
  });

  it("stores EventLog orphan radar rows without requiring a memory parent", async () => {
    const { database } = await createRepo();
    const repo = new SqliteOrphanRadarRepo(database);

    const record = {
      radar_id: "radar-event-log",
      audit_event_id: "event-orphan-1",
      event_type: "memory.delivered",
      expected_table: "trust_context_delivery",
      workspace_id: "workspace-1",
      detected_at: "2026-03-28T00:00:00.000Z",
      expires_at: "2026-03-30T00:00:00.000Z",
      requires_review: true
    } as const;

    expect(repo.createEventLogOrphan(record)).toEqual(record);
    await expect(repo.findById("radar-event-log")).resolves.toBeNull();
    await expect(repo.findActiveByWorkspaceId("workspace-1", "2026-03-28T12:00:00.000Z")).resolves.toEqual([]);

    const row = database.connection
      .prepare(
        `SELECT target_memory_id, target_event_id, target_event_type, expected_table
         FROM orphan_radar
         WHERE radar_id = ?`
      )
      .get("radar-event-log") as
      | {
          readonly target_memory_id: string | null;
          readonly target_event_id: string;
          readonly target_event_type: string;
          readonly expected_table: string;
        }
      | undefined;

    expect(row).toEqual({
      target_memory_id: null,
      target_event_id: "event-orphan-1",
      target_event_type: "memory.delivered",
      expected_table: "trust_context_delivery"
    });
  });

  it("rejects duplicate EventLog orphan radar rows for the same audit event", async () => {
    const { database } = await createRepo();
    const repo = new SqliteOrphanRadarRepo(database);

    const first = {
      radar_id: "radar-event-log-1",
      audit_event_id: "event-orphan-duplicate",
      event_type: "memory.delivered",
      expected_table: "trust_context_delivery",
      workspace_id: "workspace-1",
      detected_at: "2026-03-28T00:00:00.000Z",
      expires_at: "2026-03-30T00:00:00.000Z",
      requires_review: true
    } as const;
    const duplicate = {
      ...first,
      radar_id: "radar-event-log-2"
    } as const;

    expect(repo.createEventLogOrphan(first)).toEqual(first);
    expect(() => repo.createEventLogOrphan(duplicate)).toThrowError(expect.objectContaining({ code: "CONFLICT" }));

    const rows = database.connection
      .prepare("SELECT radar_id FROM orphan_radar WHERE target_event_id = ? ORDER BY radar_id ASC")
      .all("event-orphan-duplicate") as Array<{ readonly radar_id: string }>;
    expect(rows).toEqual([{ radar_id: "radar-event-log-1" }]);
  });

  it("finds radar rows by target memory and deletes expired rows", async () => {
    const { database, memoryRepo } = await createRepo();
    const repo = new SqliteOrphanRadarRepo(database);
    const targetMemoryId = createMemoryId(10);
    const otherTargetMemoryId = createMemoryId(11);

    await createMemory(memoryRepo, targetMemoryId);
    await createMemory(memoryRepo, otherTargetMemoryId, "run-2");

    const latest = createOrphanRadar({
      radar_id: "radar-latest",
      target_memory_id: targetMemoryId,
      detected_at: "2026-03-28T00:00:00.000Z",
      expires_at: "2026-03-30T00:00:00.000Z"
    });
    const middle = createOrphanRadar({
      radar_id: "radar-middle",
      target_memory_id: targetMemoryId,
      suspected_surface_gaps: ["surface-b"],
      suggested_action: "no_action",
      confidence: 0.5,
      detected_at: "2026-03-27T00:00:00.000Z",
      expires_at: "2026-03-29T00:00:00.000Z"
    });
    const expired = createOrphanRadar({
      radar_id: "radar-expired",
      target_memory_id: targetMemoryId,
      suspected_surface_gaps: ["surface-c"],
      suggested_action: "archive_candidate",
      confidence: 0.2,
      detected_at: "2026-03-26T00:00:00.000Z",
      expires_at: "2026-03-27T12:00:00.000Z"
    });
    const otherTarget = createOrphanRadar({
      radar_id: "radar-other-target",
      target_memory_id: otherTargetMemoryId,
      detected_at: "2026-03-29T00:00:00.000Z",
      expires_at: "2026-03-31T00:00:00.000Z"
    });

    await repo.create(latest);
    await repo.create(middle);
    await repo.create(expired);
    await repo.create(otherTarget);

    await expect(repo.findByTargetMemory(targetMemoryId, "workspace-1")).resolves.toEqual([latest, middle, expired]);
    await expect(repo.deleteExpired("2026-03-28T12:00:00.000Z")).resolves.toBe(1);
    await expect(repo.findByTargetMemory(targetMemoryId, "workspace-1")).resolves.toEqual([latest, middle]);
    await expect(repo.findById("radar-expired")).resolves.toBeNull();
  });

  it("limits orphan radar list queries to 200 rows with deterministic ordering", async () => {
    const { database, memoryRepo } = await createRepo();
    const repo = new SqliteOrphanRadarRepo(database);
    const targetMemoryId = createMemoryId(100);
    const expectedRadarIds = Array.from(
      { length: 200 },
      (_, index) => `radar-${index.toString().padStart(3, "0")}`
    );

    await createMemory(memoryRepo, targetMemoryId);

    for (let index = 0; index < 201; index += 1) {
      await repo.create(
        createOrphanRadar({
          radar_id: `radar-${index.toString().padStart(3, "0")}`,
          target_memory_id: targetMemoryId
        })
      );
    }

    const activeRows = await repo.findActiveByWorkspaceId("workspace-1", "2026-03-28T12:00:00.000Z");
    expect(activeRows).toHaveLength(200);
    expect(activeRows.map((row) => row.radar_id)).toEqual(expectedRadarIds);

    const targetRows = await repo.findByTargetMemory(targetMemoryId, "workspace-1");
    expect(targetRows).toHaveLength(200);
    expect(targetRows.map((row) => row.radar_id)).toEqual(expectedRadarIds);
  });

  it("rejects orphan radar rows whose target memory does not exist", async () => {
    const { database } = await createRepo();
    const repo = new SqliteOrphanRadarRepo(database);

    expect(() =>
      repo.create(
        createOrphanRadar({
          radar_id: "radar-missing-parent",
          target_memory_id: createMemoryId(900)
        })
      )
    ).toThrowError(expect.objectContaining({
      name: "StorageError",
      code: "QUERY_FAILED"
    }));
  });

  it("cascades orphan radar deletion when the target memory is removed", async () => {
    const { database, memoryRepo } = await createRepo();
    const repo = new SqliteOrphanRadarRepo(database);
    const targetMemoryId = createMemoryId(910);

    await createMemory(memoryRepo, targetMemoryId);
    await repo.create(
      createOrphanRadar({
        radar_id: "radar-cascade",
        target_memory_id: targetMemoryId
      })
    );

    database.connection.prepare("DELETE FROM memory_entries WHERE object_id = ?").run(targetMemoryId);

    await expect(repo.findById("radar-cascade")).resolves.toBeNull();
  });
});

async function createRepo(): Promise<{
  readonly database: ReturnType<typeof initDatabase>;
  readonly memoryRepo: SqliteMemoryEntryRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);

  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const memoryRepo = new SqliteMemoryEntryRepo(database);

  await workspaceRepo.create({
    workspace_id: "workspace-1",
    name: "workspace one",
    root_path: "/tmp/ws1",
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

  return { database, memoryRepo };
}
