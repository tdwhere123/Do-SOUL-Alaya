import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  FormationKind,
  MemoryDimension,
  RetentionPolicy,
  RunMode,
  RunState,
  ScopeClass,
  SourceKind,
  StorageTier,
  WorkspaceKind,
  WorkspaceState,
  type EventLogEntry,
  type MemoryEntry,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteCoUsageCounterRepo,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { PathRelationProposalService } from "../../path-graph/edge-proposals/path-relation-proposal-service.js";
import { RecallService, type RecallServiceDependencies } from "../../recall/recall-service.js";

const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

const MEM_QUERY_HIT = "00000000-0000-4000-8000-000000000001";
const MEM_LINKED = "00000000-0000-4000-8000-000000000002";
const WS = "workspace-1";

describe("PathRelation end-to-end (propose K=3 -> recall path_expansion)", () => {
  it("writes PathRelation after 3 onCoUsage events and surfaces a path_expansion candidate", async () => {
    const { database, memoryEntryRepo, pathRelationRepo, coUsageCounterRepo } =
      await createRealStorage();

    await memoryEntryRepo.create(createMemoryEntry({
      object_id: MEM_QUERY_HIT,
      content: "rtk pnpm command anchor",
      domain_tags: ["repo"]
    }));
    await memoryEntryRepo.create(createMemoryEntry({
      object_id: MEM_LINKED,
      content: "distinct topic not lexically related",
      domain_tags: ["other"]
    }));

    const eventPublisher = {
      appendManyWithMutation: vi.fn(
        async <T,>(
          eventInputs: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
          mutate: (entries: readonly EventLogEntry[]) => T
        ): Promise<T> => {
          const persisted: EventLogEntry[] = eventInputs.map((entry, idx) => ({
            event_id: `evt_path_relation_${idx}`,
            created_at: "2026-05-16T00:00:00.000Z",
            revision: 0,
            ...entry
          })) as EventLogEntry[];
          return mutate(persisted);
        }
      )
    };
    const proposalService = new PathRelationProposalService({
      repo: {
        create: (relation) => pathRelationRepo.create(relation)
      },
      counterStore: coUsageCounterRepo,
      eventPublisher: eventPublisher as never,
      threshold: 3,
      generateId: () => "11111111-1111-4111-8111-aaaaaaaaaaaa",
      now: () => "2026-05-16T00:00:00.000Z"
    });
    await proposalService.onCoUsage([MEM_QUERY_HIT, MEM_LINKED], WS);
    await proposalService.onCoUsage([MEM_QUERY_HIT, MEM_LINKED], WS);
    await proposalService.onCoUsage([MEM_QUERY_HIT, MEM_LINKED], WS);

    const persistedPaths = await pathRelationRepo.findByAnchors(WS, [
      { kind: "object", object_id: MEM_QUERY_HIT }
    ]);
    expect(persistedPaths.length).toBeGreaterThanOrEqual(1);
    const path = persistedPaths[0]!;
    const sourceAnchor = path.anchors.source_anchor;
    const targetAnchor = path.anchors.target_anchor;
    const sourceId = sourceAnchor.kind === "object" ? sourceAnchor.object_id : null;
    const targetId = targetAnchor.kind === "object" ? targetAnchor.object_id : null;
    expect(new Set([sourceId, targetId])).toEqual(new Set([MEM_QUERY_HIT, MEM_LINKED]));

    const memories = await memoryEntryRepo.findByWorkspaceId(WS, StorageTier.HOT);
    const append = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): Promise<EventLogEntry> => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-05-13T00:00:00.000Z",
      revision: 0,
      ...entry
    }));

    const deps: RecallServiceDependencies = {
      now: () => "2026-05-16T00:00:00.000Z",
      generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => memories),
        findByDimension: vi.fn(async () => memories),
        findByScopeClass: vi.fn(async () => memories),
        searchByKeyword: vi.fn(async () =>
          memories
            .filter((m) => m.content.toLowerCase().includes("rtk"))
            .map((m) => ({ object_id: m.object_id, normalized_rank: 1 }))
        )
      } as RecallServiceDependencies["memoryRepo"],
      slotRepo: {
        findByWorkspace: vi.fn(async () => [])
      },
      eventLogRepo: {
        append,
        queryByEntity: vi.fn(async () => [])
      },
      pathExpansionPort: {
        findByAnchors: pathRelationRepo.findByAnchors.bind(pathRelationRepo)
      }
    };

    const recallService = new RecallService(deps);
    const result = await recallService.recall({
      taskSurface: createTaskSurface("rtk pnpm command"),
      workspaceId: WS,
      runId: "run-1",
      strategy: "build"
    });

    const linkedCandidate = result.candidates.find((c) => c.object_id === MEM_LINKED);
    expect(linkedCandidate, "MEM_LINKED should appear via path_expansion").toBeDefined();
    expect(
      linkedCandidate?.source_channels?.some((channel) => channel.includes("path_expansion"))
    ).toBe(true);

    database.close();
    databases.delete(database);
  });

  it("recalls dated memories through time_concern path expansion without the retired date plane", async () => {
    const { database, memoryEntryRepo, pathRelationRepo } = await createRealStorage();

    await memoryEntryRepo.create(createMemoryEntry({
      object_id: MEM_QUERY_HIT,
      content: "Artifact zeta was triaged during the release checkpoint.",
      domain_tags: ["release"]
    }));

    pathRelationRepo.create({
      path_id: "22222222-2222-4222-8222-aaaaaaaaaaaa",
      workspace_id: WS,
      anchors: {
        source_anchor: { kind: "object", object_id: MEM_QUERY_HIT },
        target_anchor: {
          kind: "time_concern",
          source_object_id: MEM_QUERY_HIT,
          window_digest: "yesterday"
        }
      },
      constitution: {
        relation_kind: "time_concern",
        why_this_relation_exists: ["matched temporal expression: yesterday"]
      },
      effect_vector: {
        salience: 1,
        recall_bias: 1,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "lens_entry"
      },
      plasticity_state: {
        strength: 1,
        direction_bias: "source_to_target",
        stability_class: "stable",
        support_events_count: 1,
        contradiction_events_count: 0,
        last_reinforced_at: "2026-05-16T00:00:00.000Z"
      },
      lifecycle: {
        status: "active",
        retirement_rule: "janitor_ttl_low_strength"
      },
      legitimacy: {
        evidence_basis: ["garden:time_concern"],
        governance_class: "recall_allowed"
      },
      created_at: "2026-05-16T00:00:00.000Z",
      updated_at: "2026-05-16T00:00:00.000Z"
    });

    const memories = await memoryEntryRepo.findByWorkspaceId(WS, StorageTier.HOT);
    const append = vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): Promise<EventLogEntry> => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-05-16T00:00:00.000Z",
      revision: 0,
      ...entry
    }));
    const pathExpansionPort: RecallServiceDependencies["pathExpansionPort"] = {
      findByAnchors: pathRelationRepo.findByAnchors.bind(pathRelationRepo),
      findByTimeConcernWindowDigests: async (workspaceId, windowDigests) => {
        const normalized = new Set(windowDigests);
        const paths = await pathRelationRepo.findByWorkspace(workspaceId);
        return paths.filter((path) =>
          [path.anchors.source_anchor, path.anchors.target_anchor].some((anchor) =>
            anchor.kind === "time_concern" && normalized.has(anchor.window_digest)
          )
        );
      }
    };
    const recallService = new RecallService({
      now: () => "2026-05-16T00:00:00.000Z",
      generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => memories),
        findByDimension: vi.fn(async () => memories),
        findByScopeClass: vi.fn(async () => memories),
        searchByKeyword: vi.fn(async () => [])
      } as RecallServiceDependencies["memoryRepo"],
      slotRepo: {
        findByWorkspace: vi.fn(async () => [])
      },
      eventLogRepo: {
        append,
        queryByEntity: vi.fn(async () => [])
      },
      pathExpansionPort
    });

    const result = await recallService.recall({
      taskSurface: createTaskSurface("What happened yesterday?"),
      workspaceId: WS,
      runId: "run-1",
      strategy: "build"
    });

    const datedCandidate = result.candidates.find((c) => c.object_id === MEM_QUERY_HIT);
    const retiredDatePlane = ["temporal", "proximity"].join("_");
    expect(datedCandidate, "MEM_QUERY_HIT should appear through time_concern path_expansion").toBeDefined();
    expect(datedCandidate?.source_channels).toContain("time_concern");
    expect(datedCandidate?.source_channels).toContain("plane:path_expansion");
    expect(datedCandidate?.source_channels).not.toContain(retiredDatePlane);
    expect(datedCandidate?.source_channels).not.toContain(`plane:${retiredDatePlane}`);

    database.close();
    databases.delete(database);
  });

  it("preserves sub-threshold co-usage counts across a simulated daemon restart", async () => {
    // The core purpose of the durable counter: a count accrued under one
    // daemon process must survive into a fresh service rebuilt against the
    // same database after the prior in-memory state is discarded.
    const tmpDir = mkdtempSync(join(tmpdir(), "alaya-co-usage-"));
    const filename = join(tmpDir, "co-usage.db");

    const buildSession = () => {
      const database = initDatabase({ filename });
      const pathRelationRepo = new SqlitePathRelationRepo(database);
      const coUsageCounterRepo = new SqliteCoUsageCounterRepo(database);
      const eventPublisher = {
        appendManyWithMutation: vi.fn(
          async <T,>(
            eventInputs: readonly Omit<EventLogEntry, "event_id" | "created_at" | "revision">[],
            mutate: (entries: readonly EventLogEntry[]) => T
          ): Promise<T> => {
            const persisted: EventLogEntry[] = eventInputs.map((entry, idx) => ({
              event_id: `evt_restart_${idx}`,
              created_at: "2026-05-16T00:00:00.000Z",
              revision: 0,
              ...entry
            })) as EventLogEntry[];
            return mutate(persisted);
          }
        )
      };
      const service = new PathRelationProposalService({
        repo: {
          create: (relation) => pathRelationRepo.create(relation),
          findByAnchorMemoryId: async (memoryId, workspaceId) =>
            await pathRelationRepo.findByAnchors(workspaceId, [
              { kind: "object", object_id: memoryId }
            ])
        },
        counterStore: coUsageCounterRepo,
        eventPublisher: eventPublisher as never,
        threshold: 3,
        generateId: () => "33333333-3333-4333-8333-aaaaaaaaaaaa",
        now: () => "2026-05-16T00:00:00.000Z"
      });
      return { database, pathRelationRepo, service };
    };

    try {
      const first = buildSession();
      const firstWorkspaceRepo = new SqliteWorkspaceRepo(first.database);
      await firstWorkspaceRepo.create({
        workspace_id: WS,
        name: "workspace one",
        root_path: "/tmp/ws-restart",
        workspace_kind: WorkspaceKind.LOCAL_REPO,
        default_engine_binding: null,
        workspace_state: WorkspaceState.ACTIVE
      });
      // Two sub-threshold observations under the first process.
      await first.service.onCoUsage([MEM_QUERY_HIT, MEM_LINKED], WS);
      await first.service.onCoUsage([MEM_QUERY_HIT, MEM_LINKED], WS);
      const beforeRestart = await first.pathRelationRepo.findByAnchors(WS, [
        { kind: "object", object_id: MEM_QUERY_HIT }
      ]);
      expect(beforeRestart).toHaveLength(0);
      // Discard in-memory state (close the connection, drop the service).
      first.database.close();

      // Fresh service + DB connection: the prior count (2) is read back from
      // the durable table, so a single further co-usage reaches the K=3
      // threshold and a PathRelation is minted.
      const second = buildSession();
      await second.service.onCoUsage([MEM_QUERY_HIT, MEM_LINKED], WS);
      const afterRestart = await second.pathRelationRepo.findByAnchors(WS, [
        { kind: "object", object_id: MEM_QUERY_HIT }
      ]);
      expect(afterRestart).toHaveLength(1);
      second.database.close();
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  }, 30_000);
});

async function createRealStorage() {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  const pathRelationRepo = new SqlitePathRelationRepo(database);
  const coUsageCounterRepo = new SqliteCoUsageCounterRepo(database);

  await workspaceRepo.create({
    workspace_id: WS,
    name: "workspace one",
    root_path: "/tmp/ws1",
    workspace_kind: WorkspaceKind.LOCAL_REPO,
    default_engine_binding: null,
    workspace_state: WorkspaceState.ACTIVE
  });
  await runRepo.create({
    run_id: "run-1",
    workspace_id: WS,
    title: "run one",
    goal: null,
    run_mode: RunMode.CHAT,
    engine_binding_id: null,
    engine_class: null,
    run_state: RunState.IDLE,
    current_surface_id: null
  });

  return { database, memoryEntryRepo, pathRelationRepo, coUsageCounterRepo };
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

function createMemoryEntry(overrides: Partial<MemoryEntry>): MemoryEntry {
  return {
    object_id: "memory-default",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-13T00:00:00.000Z",
    updated_at: "2026-05-13T00:00:00.000Z",
    created_by: "path-relation-end-to-end-test",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "default content",
    domain_tags: ["repo"],
    evidence_refs: [],
    workspace_id: WS,
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.7,
    retention_score: 0.8,
    manifestation_state: "full_eligible",
    retention_state: "consolidated",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: "2026-05-12T00:00:00.000Z",
    last_hit_at: "2026-05-12T00:00:00.000Z",
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}
