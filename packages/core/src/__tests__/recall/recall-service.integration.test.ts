import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  EvidenceHealthState,
  RetentionPolicy,
  RunMode,
  RunState,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type EventLogEntry,
  type EvidenceCapsule,
  type RecallPolicy,
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

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

// anti-patterns-lint-allow: real-DB stand-up mirrors the recall real-storage precedents on purpose.
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

  await workspaceRepo.create({
    workspace_id: WS,
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
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

// Binds the real SQLite repos directly so lexical/evidence admission runs
// through actual FTS5 and tier-filtered reads, matching production wiring.
function buildRecallService(params: {
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly evidenceCapsuleRepo: SqliteEvidenceCapsuleRepo;
}): RecallService {
  const append = vi.fn(
    async (
      entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
    ): Promise<EventLogEntry> => ({
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

function withMaxEntries(recallService: RecallService, maxEntries: number): RecallPolicy {
  const base = recallService.buildDefaultPolicy("build", "task-surface-ref");
  return {
    ...base,
    fine_assessment: {
      ...base.fine_assessment,
      budgets: {
        ...base.fine_assessment.budgets,
        max_entries: maxEntries
      }
    }
  };
}

// anti-patterns-lint-allow: query-carrying surface fixture mirrors the recall precedents; shared one takes no query.
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

function createEvidenceCapsule(overrides: Partial<EvidenceCapsule>): EvidenceCapsule {
  return {
    object_id: "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "recall-service-integration-test",
    evidence_kind: "tool_output",
    semantic_anchor: {
      topic: "evidence topic",
      keywords: ["evidence"],
      summary: "evidence summary"
    },
    event_anchor: {
      event_type: "engine.response.received",
      event_id: "evt_1",
      occurred_at: "2026-03-20T00:00:00.000Z"
    },
    physical_anchor: {
      file_path: "packages/core/src/memory/evidence-service.ts",
      line_range: { start: 1, end: 120 },
      symbol_name: "EvidenceService",
      artifact_ref: "artifact://evidence/1"
    },
    evidence_health_state: EvidenceHealthState.VERIFIED,
    gist: "evidence gist",
    excerpt: "evidence excerpt",
    source_hash: "sha256:abc",
    run_id: RUN,
    workspace_id: WS,
    surface_id: null,
    ...overrides
  };
}

describe("RecallService integration (real SQLite + FTS5)", () => {
  it("places a lexically matching gold memory in the top five recalled candidates", async () => {
    const { database, memoryEntryRepo, evidenceCapsuleRepo } = await createRealStorage();

    const goldId = "00000000-0000-4000-8000-000000000001";
    await memoryEntryRepo.create(createMemoryEntry({
      object_id: goldId,
      content: "Always run database migrations before deploying the staging release.",
      activation_score: 0.6
    }));
    for (let index = 0; index < 6; index += 1) {
      await memoryEntryRepo.create(createMemoryEntry({
        object_id: `00000000-0000-4000-8000-0000000000${String(index + 10).padStart(2, "0")}`,
        content: `Unrelated note about kettle descaling intervals number ${index}.`,
        activation_score: 0.95
      }));
    }

    const recallService = buildRecallService({ memoryEntryRepo, evidenceCapsuleRepo });
    const result = await recallService.recall({
      taskSurface: createTaskSurface("database migrations staging release"),
      workspaceId: WS,
      runId: RUN,
      strategy: "build"
    });

    const topFive = result.candidates.slice(0, 5).map((row) => row.object_id);
    expect(topFive).toContain(goldId);

    database.close();
    databases.delete(database);
  });

  it("pulls warm-tier memories into the result when the hot tier is insufficient", async () => {
    const { database, memoryEntryRepo, evidenceCapsuleRepo } = await createRealStorage();

    // Single hot lexical hit leaves the pool below the cascade target, so the
    // warm tier must be read to reach MIN_RECALL_RESULTS.
    const hotId = "00000000-0000-4000-8000-000000000001";
    await memoryEntryRepo.create(createMemoryEntry({
      object_id: hotId,
      content: "Use the kubernetes deploy pipeline for the staging cluster.",
      storage_tier: StorageTier.HOT,
      activation_score: 0.6
    }));
    const warmIds = [
      "00000000-0000-4000-8000-000000000021",
      "00000000-0000-4000-8000-000000000022",
      "00000000-0000-4000-8000-000000000023",
      "00000000-0000-4000-8000-000000000024",
      "00000000-0000-4000-8000-000000000025"
    ];
    for (let index = 0; index < warmIds.length; index += 1) {
      await memoryEntryRepo.create(createMemoryEntry({
        object_id: warmIds[index]!,
        content: `Kubernetes deploy pipeline runbook chapter ${index}.`,
        storage_tier: StorageTier.WARM,
        activation_score: 0.5
      }));
    }

    const recallService = buildRecallService({ memoryEntryRepo, evidenceCapsuleRepo });
    const result = await recallService.recall({
      taskSurface: createTaskSurface("kubernetes deploy pipeline"),
      workspaceId: WS,
      runId: RUN,
      strategy: "build"
    });

    const recalledIds = new Set(result.candidates.map((row) => row.object_id));
    expect(result.degradation_reason).toBe("warm_cascade_engaged");
    expect(warmIds.some((id) => recalledIds.has(id))).toBe(true);

    database.close();
    databases.delete(database);
  });

  it("admits a memory whose backing evidence-capsule gist matches the query", async () => {
    const { database, memoryEntryRepo, evidenceCapsuleRepo } = await createRealStorage();

    // The memory content is lexically disjoint from the query; only its evidence
    // capsule gist carries the query terms, so admission must route via evidence FTS.
    const evidenceId = "11111111-1111-4111-8111-000000000001";
    const backedMemoryId = "00000000-0000-4000-8000-000000000001";
    await evidenceCapsuleRepo.create(createEvidenceCapsule({
      object_id: evidenceId,
      gist: "rotates the deployment credentials nightly",
      excerpt: "The deployment pipeline rotates the staging credentials nightly."
    }));
    await memoryEntryRepo.create(createMemoryEntry({
      object_id: backedMemoryId,
      content: "A short distilled note with no overlapping surface wording.",
      evidence_refs: [evidenceId],
      activation_score: 0.5
    }));

    const recallService = buildRecallService({ memoryEntryRepo, evidenceCapsuleRepo });
    const result = await recallService.recall({
      taskSurface: createTaskSurface("deployment credentials"),
      workspaceId: WS,
      runId: RUN,
      strategy: "build"
    });

    const backed = result.candidates.find((row) => row.object_id === backedMemoryId);
    expect(backed, "evidence-backed memory should be admitted via evidence FTS").toBeDefined();
    expect(backed?.source_channels?.some((channel: string) => channel.includes("evidence"))).toBe(true);

    database.close();
    databases.delete(database);
  });

  it("never returns more candidates than the configured max_entries cap", async () => {
    const { database, memoryEntryRepo, evidenceCapsuleRepo } = await createRealStorage();

    for (let index = 0; index < 12; index += 1) {
      await memoryEntryRepo.create(createMemoryEntry({
        object_id: `00000000-0000-4000-8000-0000000000${String(index + 10).padStart(2, "0")}`,
        content: `Release checklist item ${index} for the staging deployment runbook.`,
        activation_score: 0.5 + index * 0.01
      }));
    }

    const recallService = buildRecallService({ memoryEntryRepo, evidenceCapsuleRepo });
    const cap = 3;
    const result = await recallService.recall({
      taskSurface: createTaskSurface("staging deployment runbook"),
      workspaceId: WS,
      runId: RUN,
      strategy: "build",
      policyOverride: withMaxEntries(recallService, cap)
    });

    expect(result.candidates.length).toBeLessThanOrEqual(cap);

    database.close();
    databases.delete(database);
  });

  it("returns an empty candidate set without throwing when the workspace has no memories", async () => {
    const { database, memoryEntryRepo, evidenceCapsuleRepo } = await createRealStorage();

    const recallService = buildRecallService({ memoryEntryRepo, evidenceCapsuleRepo });
    const result = await recallService.recall({
      taskSurface: createTaskSurface("zylphqorbex quantum flux capacitor"),
      workspaceId: WS,
      runId: RUN,
      strategy: "build"
    });

    expect(Array.isArray(result.candidates)).toBe(true);
    expect(result.candidates).toHaveLength(0);

    database.close();
    databases.delete(database);
  });
});
