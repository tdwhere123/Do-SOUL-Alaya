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
  type PathRelation,
  type RecallPolicy,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import {
  initDatabase,
  SqliteMemoryEntryRepo,
  SqlitePathRelationRepo,
  SqliteRunRepo,
  SqliteWorkspaceRepo,
  type StorageDatabase
} from "@do-soul/alaya-storage";
import { RecallService, type RecallServiceDependencies } from "../../recall/recall-service.js";


const databases = new Set<StorageDatabase>();

afterEach(() => {
  for (const database of databases) {
    database.close();
  }
  databases.clear();
});

const WS = "workspace-1";
const RUN = "run-1";
const QUERY_TERM = "zylphqorbex";
const SEED_ID = "00000000-0000-4000-8000-000000000001";
const SIBLING_ID = "00000000-0000-4000-8000-000000000009";
const FILLER_COUNT = 8;
const DECOY_COUNT = 5;
const MAX_ENTRIES = 6;

function fillerId(index: number): string {
  return `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`;
}

async function inspectSibling(params: {
  readonly relationKind: string;
  readonly siblingCarriesQueryTerm?: boolean;
  readonly negativeSiblingPath?: boolean;
}) {
  const { database, memoryEntryRepo, pathRelationRepo } = await createRealStorage();

  await memoryEntryRepo.create(
    createMemoryEntry({
      object_id: SEED_ID,
      content: `${QUERY_TERM} primary anchor memory`,
      activation_score: 0.9
    })
  );
  await memoryEntryRepo.create(
    createMemoryEntry({
      object_id: SIBLING_ID,
      content: params.siblingCarriesQueryTerm
        ? `${QUERY_TERM} sibling with a faint relevance term`
        : "wholly unrelated procedure about kettle descaling intervals",
      domain_tags: [],
      activation_score: 0.01
    })
  );
  for (let index = 0; index < FILLER_COUNT; index += 1) {
    await memoryEntryRepo.create(
      createMemoryEntry({
        object_id: fillerId(index),
        content: `${QUERY_TERM} filler note number ${index}`,
        activation_score: 0.9 - index * 0.01
      })
    );
  }

  pathRelationRepo.create(
    buildPath({
      path_id: "11111111-1111-4111-8111-aaaaaaaaaaaa",
      sourceId: SEED_ID,
      targetId: SIBLING_ID,
      relationKind: params.relationKind,
      strength: 0.5,
      recallBias: 0.5
    })
  );
  for (let index = 0; index < DECOY_COUNT; index += 1) {
    pathRelationRepo.create(
      buildPath({
        path_id: `3333333${index}-3333-4333-8333-aaaaaaaaaaaa`,
        sourceId: SEED_ID,
        targetId: fillerId(index),
        relationKind: "co_recalled",
        strength: 0.95,
        recallBias: 0.5
      })
    );
  }
  if (params.negativeSiblingPath === true) {
    pathRelationRepo.create(
      buildPath({
        path_id: "22222222-2222-4222-8222-bbbbbbbbbbbb",
        sourceId: SEED_ID,
        targetId: SIBLING_ID,
        relationKind: "supersedes",
        strength: 0.95,
        recallBias: -0.5,
        governanceClass: "recall_allowed"
      })
    );
  }

  const recallService = buildRecallService({ memoryEntryRepo, pathRelationRepo });
  const result = await recallService.recall({
    taskSurface: createTaskSurface(`${QUERY_TERM} recall`),
    workspaceId: WS,
    runId: RUN,
    strategy: "build",
    policyOverride: buildWideOpenPolicy(recallService)
  });
  const delivered = result.candidates.some((row) => row.object_id === SIBLING_ID);
  const diagnostic = result.diagnostics?.candidates.find((row) => row.object_id === SIBLING_ID);
  if (diagnostic === undefined) {
    throw new Error("expected path-admitted sibling diagnostics");
  }
  database.close();
  databases.delete(database);
  return {
    delivered,
    admissionPlanes: diagnostic.admission_planes,
    relationKinds: diagnostic.path_expansion_sources.map((source) => source.relation_kind),
    pathRank: diagnostic.per_stream_rank.path_expansion,
    lexicalRank: diagnostic.per_stream_rank.lexical_fts,
    pathContribution: diagnostic.fused_rank_contribution_per_stream.path_expansion,
    lexicalContribution: diagnostic.fused_rank_contribution_per_stream.lexical_fts,
    suppressionScore: diagnostic.path_suppression_score,
    fusedRank: diagnostic.fused_rank,
    finalRank: diagnostic.final_rank,
    rankAfterStructuralStage: diagnostic.rank_after_structural_reserve
  };
}

describe("query evidence in fusion-only path delivery", () => {
  it("retains generic path admission when direct lexical evidence is absent", async () => {
    const diagnostic = await inspectSibling({ relationKind: "supports" });
    expect(diagnostic.admissionPlanes).toContain("path_expansion");
    expect(diagnostic.relationKinds).toContain("supports");
    expect(diagnostic.pathRank).not.toBeNull();
    expect(diagnostic.pathContribution).toBeGreaterThan(0);
    expect(diagnostic.lexicalRank).toBeNull();
    expect(diagnostic.delivered).toBe(false);
    expect(diagnostic.finalRank).toBeNull();
    expect(diagnostic.rankAfterStructuralStage).toBeUndefined();
  });

  it("records direct lexical evidence without bypassing the fused budget", async () => {
    const diagnostic = await inspectSibling({
      relationKind: "supports",
      siblingCarriesQueryTerm: true
    });
    expect(diagnostic.admissionPlanes).toContain("path_expansion");
    expect(diagnostic.admissionPlanes).toContain("lexical");
    expect(diagnostic.pathContribution).toBeGreaterThan(0);
    expect(diagnostic.lexicalContribution).toBeGreaterThan(0);
    expect(diagnostic.delivered).toBe(false);
    expect(diagnostic.finalRank).toBeNull();
    expect(diagnostic.rankAfterStructuralStage).toBeUndefined();
  });
});

describe("path diagnostics preserve sign-aware suppression", () => {
  it("records a high-strength supersedes suppression signal", async () => {
    const diagnostic = await inspectSibling({
      relationKind: "co_recalled",
      negativeSiblingPath: true
    });
    expect(diagnostic.relationKinds).toContain("co_recalled");
    expect(diagnostic.suppressionScore).toBeGreaterThan(0);
    expect(diagnostic.delivered).toBe(false);
    expect(diagnostic.finalRank).toBeNull();
    expect(diagnostic.rankAfterStructuralStage).toBeUndefined();
  });

  it("reports zero suppression when the negative path is absent", async () => {
    const diagnostic = await inspectSibling({ relationKind: "co_recalled" });
    expect(diagnostic.relationKinds).toContain("co_recalled");
    expect(diagnostic.suppressionScore).toBe(0);
    expect(diagnostic.pathContribution).toBeGreaterThan(0);
    expect(diagnostic.delivered).toBe(false);
    expect(diagnostic.finalRank).toBeNull();
    expect(diagnostic.rankAfterStructuralStage).toBeUndefined();
  });
});

async function createRealStorage(): Promise<{
  readonly database: StorageDatabase;
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly pathRelationRepo: SqlitePathRelationRepo;
}> {
  const database = initDatabase({ filename: ":memory:" });
  databases.add(database);
  const workspaceRepo = new SqliteWorkspaceRepo(database);
  const runRepo = new SqliteRunRepo(database);
  const memoryEntryRepo = new SqliteMemoryEntryRepo(database);
  const pathRelationRepo = new SqlitePathRelationRepo(database);

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

  return { database, memoryEntryRepo, pathRelationRepo };
}

function buildRecallService(params: {
  readonly memoryEntryRepo: SqliteMemoryEntryRepo;
  readonly pathRelationRepo: SqlitePathRelationRepo;
}): RecallService {
  const memoriesPromise = params.memoryEntryRepo.findByWorkspaceId(WS, StorageTier.HOT);
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

  const deps: RecallServiceDependencies = {
    now: () => "2026-05-16T00:00:00.000Z",
    generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    memoryRepo: {
      findByWorkspaceId: vi.fn(async () => await memoriesPromise),
      findByDimension: vi.fn(async () => await memoriesPromise),
      findByScopeClass: vi.fn(async () => await memoriesPromise),
      // Lexical hit only when content carries the query term verbatim.
      searchByKeyword: vi.fn(async (_workspaceId, queryText) => {
        const memories = await memoriesPromise;
        const needle = QUERY_TERM.toLowerCase();
        return memories
          .filter(
            (memory) =>
              queryText.toLowerCase().includes(needle) &&
              memory.content.toLowerCase().includes(needle)
          )
          .map((memory, rankIndex) => ({
            object_id: memory.object_id,
            normalized_rank: memory.object_id === SIBLING_ID ? 0.0001 : 1 / (rankIndex + 1)
          }));
      })
    } as RecallServiceDependencies["memoryRepo"],
    slotRepo: {
      findByWorkspace: vi.fn(async () => [])
    },
    eventLogRepo: {
      append,
      queryByEntity: vi.fn(async () => [])
    },
    pathExpansionPort: {
      findByAnchors: params.pathRelationRepo.findByAnchors.bind(params.pathRelationRepo)
    }
  };

  return new RecallService(deps);
}

function buildWideOpenPolicy(recallService: RecallService): RecallPolicy {
  const base = recallService.buildDefaultPolicy("build", "task-surface-ref");
  return {
    ...base,
    coarse_filter: {
      ...base.coarse_filter,
      deterministic_match: {
        scope_filter: null,
        dimension_filter: null,
        domain_tag_filter: null
      },
      precomputed_rank: {
        ...base.coarse_filter.precomputed_rank,
        max_candidates: 50,
        min_activation_score: 0
      }
    },
    fine_assessment: {
      ...base.fine_assessment,
      budgets: {
        ...base.fine_assessment.budgets,
        max_entries: MAX_ENTRIES,
        max_total_tokens: 100000
      }
    }
  };
}

function buildPath(params: {
  readonly path_id: string;
  readonly sourceId: string;
  readonly targetId: string;
  readonly relationKind: string;
  readonly strength: number;
  readonly recallBias: number;
  readonly governanceClass?: "attention_only" | "recall_allowed" | "strictly_governed" | "hint_only";
}): PathRelation {
  return {
    path_id: params.path_id,
    workspace_id: WS,
    anchors: {
      source_anchor: { kind: "object", object_id: params.sourceId },
      target_anchor: { kind: "object", object_id: params.targetId }
    },
    constitution: {
      relation_kind: params.relationKind,
      why_this_relation_exists: ["co-usage threshold reached"]
    },
    effect_vector: {
      salience: 1,
      recall_bias: params.recallBias,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: params.strength,
      direction_bias: "bidirectional_asymmetric",
      stability_class: "stable",
      support_events_count: 3,
      contradiction_events_count: 0,
      last_reinforced_at: "2026-05-16T00:00:00.000Z"
    },
    lifecycle: {
      status: "active",
      retirement_rule: "janitor_ttl_low_strength"
    },
    legitimacy: {
      evidence_basis: ["recalls_edge_co_usage"],
      governance_class: params.governanceClass ?? "attention_only"
    },
    created_at: "2026-05-16T00:00:00.000Z",
    updated_at: "2026-05-16T00:00:00.000Z"
  };
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
    created_by: "recall-durable-fanin-delivery-part2-test",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "default content",
    domain_tags: ["repo"],
    evidence_refs: [],
    workspace_id: WS,
    run_id: RUN,
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
