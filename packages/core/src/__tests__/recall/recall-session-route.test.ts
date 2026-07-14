import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  RetentionPolicy,
  RunMode,
  RunState,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type EventLogEntry,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteEvidenceCapsuleRepo,
  SqliteMemoryEntryRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { RecallService, type RecallServiceDependencies } from "../../recall/recall-service.js";
import { createMemoryEntry } from "./recall-service-test-fixtures.js";

const WS = "workspace-1";
const RUN = "run-1";
const ANCHOR_SURFACE = "surface-anchor-session";
const OTHER_SURFACE = "surface-other-session";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
  delete process.env.ALAYA_RECALL_SESSION_ROUTE;
});

async function createRealStorage(): Promise<{
  readonly database: StorageDatabase;
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly evidenceCapsuleRepo: SqliteEvidenceCapsuleRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  const evidenceCapsuleRepo = new SqliteEvidenceCapsuleRepo(database);

  workspaceRepo.create({
    workspace_id: WS,
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  runRepo.create({
    run_id: RUN,
    workspace_id: WS,
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });

  return { database, memoryEntryRepo, evidenceCapsuleRepo };
}

function buildRecallService(params: {
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly evidenceCapsuleRepo: SqliteEvidenceCapsuleRepo;
}): RecallService {
  const append = vi.fn(
    async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): Promise<EventLogEntry> => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-05-16T00:00:00.000Z",
      revision: 0,
      ...entry
    })
  );

  const memoryRepo = params.memoryEntryRepo;
  const deps: RecallServiceDependencies = {
    now: () => "2026-05-16T00:00:00.000Z",
    generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    memoryRepo: {
      findByWorkspaceId: memoryRepo.findByWorkspaceId.bind(memoryRepo),
      findByDimension: memoryRepo.findByDimension.bind(memoryRepo),
      findByScopeClass: memoryRepo.findByScopeClass.bind(memoryRepo),
      searchByKeyword: memoryRepo.searchByKeyword.bind(memoryRepo),
      searchByKeywordWithinObjectIds: memoryRepo.searchByKeywordWithinObjectIds.bind(memoryRepo),
      findByEvidenceRefs: memoryRepo.findByEvidenceRefs.bind(memoryRepo)
    },
    slotRepo: {
      findByWorkspace: vi.fn(async () => [])
    },
    eventLogRepo: {
      append,
      queryByEntity: vi.fn(async () => [])
    },
    evidenceSearchPort: {
      searchByKeyword: params.evidenceCapsuleRepo.searchByKeyword.bind(params.evidenceCapsuleRepo),
      findByIds: (workspaceId: string, evidenceObjectIds: readonly string[]) =>
        params.evidenceCapsuleRepo.findByIds(workspaceId, evidenceObjectIds)
    }
  };

  return new RecallService(deps);
}

function createTaskSurface(displayName: string): TaskObjectSurface {
  return {
    runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-05-13T00:30:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "build",
    display_name: displayName,
    context_refs: []
  };
}

// Low-activation gold + anchor-session footholds vs high-activation distractors in another session, so unrouted gold sinks.
async function seedSessionRoutedCorpus(memoryEntryRepo: SqliteMemoryEntryRepo): Promise<string> {
  const goldId = "00000000-0000-4000-8000-000000000001";
  await memoryEntryRepo.create(createMemoryEntry({
    object_id: goldId,
    content: "The staging release pipeline rotates the database credentials nightly.",
    surface_id: ANCHOR_SURFACE,
    activation_score: 0.3
  }));
  const anchorFootholds = [
    "Database migrations gate the staging release credentials rollout.",
    "Staging release pipeline owners review the database credentials backups.",
    "The staging release checklist verifies database credentials schema drift.",
    "Database credentials for the staging release rotate per pipeline run.",
    "Rotating database credentials precedes every staging release window.",
    "Staging release runbook documents database credentials handover."
  ];
  for (let index = 0; index < anchorFootholds.length; index += 1) {
    await memoryEntryRepo.create(createMemoryEntry({
      object_id: `00000000-0000-4000-8000-0000000000${String(index + 10).padStart(2, "0")}`,
      content: anchorFootholds[index]!,
      surface_id: ANCHOR_SURFACE,
      activation_score: 0.35
    }));
  }
  for (let index = 0; index < 3; index += 1) {
    await memoryEntryRepo.create(createMemoryEntry({
      object_id: `00000000-0000-4000-8000-0000000000${String(index + 30).padStart(2, "0")}`,
      content: `Staging release database credentials note from another session number ${index}.`,
      surface_id: OTHER_SURFACE,
      activation_score: 0.95
    }));
  }
  return goldId;
}

interface RecalledRow {
  readonly objectId: string;
  readonly relevanceScore: number;
}

async function recallRows(
  memoryEntryRepo: SqliteMemoryEntryRepo,
  evidenceCapsuleRepo: SqliteEvidenceCapsuleRepo
): Promise<readonly RecalledRow[]> {
  const recallService = buildRecallService({ memoryEntryRepo, evidenceCapsuleRepo });
  const result = await recallService.recall({
    taskSurface: createTaskSurface("staging release database credentials"),
    workspaceId: WS,
    runId: RUN,
    strategy: "build"
  });
  return result.candidates.map((row) => ({ objectId: row.object_id, relevanceScore: row.relevance_score }));
}

describe("recall session route (real SQLite + FTS5)", () => {
  it("lifts the routed anchor-session gold into the top five when the flag is on", async () => {
    const off = await createRealStorage();
    const goldId = await seedSessionRoutedCorpus(off.memoryEntryRepo);
    delete process.env.ALAYA_RECALL_SESSION_ROUTE;
    const offRows = await recallRows(off.memoryEntryRepo, off.evidenceCapsuleRepo);

    const on = await createRealStorage();
    await seedSessionRoutedCorpus(on.memoryEntryRepo);
    process.env.ALAYA_RECALL_SESSION_ROUTE = "1";
    const onRows = await recallRows(on.memoryEntryRepo, on.evidenceCapsuleRepo);

    // Routing injects the dominant session into query probes so cohort admission
    // can deliver the gold in the top five. Family-max collapses correlated
    // structural lanes into one vote, so the public fused scalar need not
    // strictly rise — delivery rank is the contract.
    const onTopFive = onRows.slice(0, 5).map((row) => row.objectId);
    expect(onTopFive).toContain(goldId);
    const offRank = offRows.findIndex((row) => row.objectId === goldId);
    const onRank = onRows.findIndex((row) => row.objectId === goldId);
    expect(onRank).toBeGreaterThanOrEqual(0);
    expect(onRank).toBeLessThan(5);
    if (offRank >= 0) {
      expect(onRank).toBeLessThanOrEqual(offRank);
    }

    off.database.close();
    databases.delete(off.database);
    on.database.close();
    databases.delete(on.database);
  });

  it("is byte-identical (same order and scores) on or off when no session dominates the footholds", async () => {
    const { database, memoryEntryRepo, evidenceCapsuleRepo } = await createRealStorage();
    // Footholds split evenly across two sessions, so no session clears dominance: ON must equal OFF.
    for (let index = 0; index < 4; index += 1) {
      await memoryEntryRepo.create(createMemoryEntry({
        object_id: `00000000-0000-4000-8000-0000000000${String(index + 10).padStart(2, "0")}`,
        content: `Staging release database credentials runbook chapter ${index}.`,
        surface_id: index % 2 === 0 ? ANCHOR_SURFACE : OTHER_SURFACE,
        activation_score: 0.5 - index * 0.01,
        storage_tier: StorageTier.HOT
      }));
    }

    delete process.env.ALAYA_RECALL_SESSION_ROUTE;
    const offRows = await recallRows(memoryEntryRepo, evidenceCapsuleRepo);
    process.env.ALAYA_RECALL_SESSION_ROUTE = "1";
    const onRows = await recallRows(memoryEntryRepo, evidenceCapsuleRepo);
    expect(onRows).toEqual(offRows);

    database.close();
    databases.delete(database);
  });
});
