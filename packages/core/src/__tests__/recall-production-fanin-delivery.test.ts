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
import { RecallService, type RecallServiceDependencies } from "../recall-service.js";

// anchor: PRODUCTION-PATH proof for the earned-co_recalled fan-in reserve
// exemption. The sibling suite recall-durable-fanin-delivery.test.ts injects
// `reachedViaEarnedCoRecalledFanin: true` DIRECTLY into helper candidates, so it
// exercises the reserve HELPERS but NOT the production propagation that sets the
// flag. recall-service.ts sets the flag only inside RecallService.recall()
// during direct path_expansion admission when path.constitution.relation_kind
// === "co_recalled" (the EARNED_CO_RECALLED_FANIN_RELATION_KIND const). This
// suite drives REAL RecallService.recall() against real memory_entries + a real
// co_recalled PathRelation and NEVER touches the internal flag — so it fails if
// the production propagation (addPathExpansionCandidates) OR the reserve
// exemption (isStructuralRescueCandidate) regresses. (Verified by mutation: with
// the flag set point forced to false, the co_recalled sibling is no longer
// delivered, matching the supports control.)
// see also: recall-service.ts EARNED_CO_RECALLED_FANIN_RELATION_KIND, the flag
//   set point in addPathExpansionCandidates, isStructuralRescueCandidate.

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
// Sibling sorts AFTER every filler id, so it can never win the flat-cut tie on
// compareMemoryEntries — its only route into the window is the structural
// reserve.
const SIBLING_ID = "00000000-0000-4000-8000-000000000009";

// Eight lexical fillers fill the flat top window above the zero-relevance
// structural sibling. The first DECOY_COUNT fillers are ALSO co_recalled path
// targets of the seed, so the genuine sibling ranks LAST in the path_expansion
// stream AND a decoy filler also competes for the final window slot — sinking
// the sibling strictly BELOW the natural top-(max_entries) cut. Only the
// structural reserve can then deliver it. (Validated by sweep: at DECOY_COUNT=5
// the supports sibling is refused while the co_recalled sibling is rescued,
// stable across path strengths.)
const FILLER_COUNT = 8;
const DECOY_COUNT = 5;
const MAX_ENTRIES = 6;

function fillerId(index: number): string {
  return `00000000-0000-4000-8000-0000000001${String(index).padStart(2, "0")}`;
}

// Drives a REAL RecallService.recall() in which a single zero-relevance sibling
// is reached from the lexical seed via a path edge of the given relation_kind.
// Returns whether the sibling was DELIVERED (present in the truncated top-N
// result) and, when present, its admission source_channels.
async function deliverSiblingViaPath(relationKind: string): Promise<{
  readonly delivered: boolean;
  readonly sourceChannels: readonly string[] | undefined;
}> {
  const { database, memoryEntryRepo, pathRelationRepo } = await createRealStorage();

  // Seed: a strong lexical hit on the query term, so recall() picks it as an
  // expansion seed. It carries the query term verbatim.
  await memoryEntryRepo.create(createMemoryEntry({
    object_id: SEED_ID,
    content: `${QUERY_TERM} primary anchor memory`,
    activation_score: 0.9
  }));
  // Sibling: content is lexically DISJOINT from the query and domain_tags are
  // empty (no cluster co-admission), so it is a pure path_expansion candidate
  // with (near-)zero direct relevance.
  await memoryEntryRepo.create(createMemoryEntry({
    object_id: SIBLING_ID,
    content: "wholly unrelated procedure about kettle descaling intervals",
    domain_tags: [],
    activation_score: 0.01
  }));
  // Lexical fillers: independent query-term hits with high activation.
  for (let index = 0; index < FILLER_COUNT; index += 1) {
    await memoryEntryRepo.create(createMemoryEntry({
      object_id: fillerId(index),
      content: `${QUERY_TERM} filler note number ${index}`,
      activation_score: 0.9 - index * 0.01
    }));
  }

  // The sibling edge under test: relation_kind is the only knob that differs
  // between the positive case and the negative control. recall_bias is positive
  // (0.5) so the path is born recall-eligible (active + recall_bias > 0),
  // matching the CO_RECALLED_SEED_PROFILE the producer mints at K=3.
  pathRelationRepo.create(buildPath({
    path_id: "11111111-1111-4111-8111-aaaaaaaaaaaa",
    sourceId: SEED_ID,
    targetId: SIBLING_ID,
    relationKind,
    strength: 0.5
  }));
  // Decoy co_recalled edges to high-activation lexical fillers. They crowd the
  // path_expansion stream so the sibling ranks last there and sinks below the
  // natural flat cut, isolating the structural reserve as the only delivery
  // route for a surviving sibling.
  for (let index = 0; index < DECOY_COUNT; index += 1) {
    pathRelationRepo.create(buildPath({
      path_id: `3333333${index}-3333-4333-8333-aaaaaaaaaaaa`,
      sourceId: SEED_ID,
      targetId: fillerId(index),
      relationKind: "co_recalled",
      strength: 0.95
    }));
  }

  const recallService = buildRecallService({ memoryEntryRepo, pathRelationRepo });
  const result = await recallService.recall({
    taskSurface: createTaskSurface(`${QUERY_TERM} recall`),
    workspaceId: WS,
    runId: RUN,
    strategy: "build",
    policyOverride: buildWideOpenPolicy(recallService)
  });

  const candidate = result.candidates.find((row) => row.object_id === SIBLING_ID);
  database.close();
  databases.delete(database);
  return { delivered: candidate !== undefined, sourceChannels: candidate?.source_channels };
}

describe("production-path earned co_recalled fan-in delivery (real RecallService.recall)", () => {
  it("delivers a zero-relevance gold sibling reached via a real co_recalled PathRelation (earned fan-in reserve exemption, no injected flag)", async () => {
    const { delivered, sourceChannels } = await deliverSiblingViaPath("co_recalled");

    // The sibling has zero query relevance and is buried below the flat top-N
    // cut; it is delivered ONLY because production admission set
    // reachedViaEarnedCoRecalledFanin (path.relation_kind === "co_recalled") and
    // the structural reserve exemption promoted it. If the production
    // propagation or the reserve exemption regressed, this fails.
    expect(
      delivered,
      "zero-relevance gold sibling must be DELIVERED via earned co_recalled fan-in"
    ).toBe(true);
    // Provenance: the sibling was admitted on the path_expansion plane (it has no
    // lexical/activation route into the window).
    expect(
      sourceChannels?.some((channel) => channel.includes("path_expansion"))
    ).toBe(true);
  });

  it("NEGATIVE CONTROL: an identical zero-relevance sibling reached via a NON-co_recalled relation_kind stays relevance-gated and is NOT delivered", async () => {
    // Identical fixture, identical buried position; the ONLY delta is the
    // relation_kind of the edge that reaches the sibling (`supports`, still
    // recall-eligible so it STILL admits the sibling on path_expansion). Because
    // it is not the earned co_recalled carrier, production must not set the
    // fan-in flag and the reserve exemption must not fire — proving relation_kind,
    // not topology, flips the exemption.
    const { delivered } = await deliverSiblingViaPath("supports");
    expect(
      delivered,
      "non-co_recalled sibling must stay relevance-gated and NOT be delivered"
    ).toBe(false);
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
      // Lexical lane: only the seed + the fillers carry the query term; the
      // disjoint sibling is NOT a lexical hit, so its only admission is the path
      // edge.
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
            normalized_rank: 1 / (rankIndex + 1)
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

// Open the deterministic match wide and set a tight delivery window so the test
// isolates the fan-in reserve mechanism, not the build-strategy scope/dimension
// contract. The base is the real build default policy, so every other knob
// (fusion streams, weights, semantic supplement) stays production-faithful.
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
      // positive recall_bias => born recall-eligible (isPathRecallEligible).
      recall_bias: 0.5,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: params.strength,
      // bidirectional so the seed (either anchor) expands to the sibling.
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
      governance_class: "attention_only"
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
    created_by: "recall-production-fanin-delivery-test",
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
