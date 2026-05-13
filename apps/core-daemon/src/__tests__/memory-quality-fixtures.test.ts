import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  MemoryDimension,
  RetentionPolicy,
  ScopeClass,
  type CandidateMemorySignal,
  type EventLogEntry,
  type MemoryEntry,
  type RecallPolicy,
  type SignalState,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import {
  RecallService,
  SignalService,
  buildRecallEvidencePack,
  type RecallServiceDependencies
} from "@do-soul/alaya-core";
import {
  InMemoryHandoffGapHandler,
  MaterializationRouter,
  normalizeSchemaGroundedSignal
} from "@do-soul/alaya-soul";

interface IntegrationFixture {
  readonly fixture_id: string;
  readonly query: string;
  readonly baseline_memories: readonly MemoryEntry[];
  readonly signals: readonly CandidateMemorySignal[];
  readonly expected_after_content: readonly string[];
}

describe("memory quality read/write fixtures", () => {
  it("compares baseline recall with schema-aware write-path recall on the same fixture set", async () => {
    const packs = [];

    for (const fixture of createIntegrationFixtures()) {
      const baselineHarness = createHarness([...fixture.baseline_memories]);
      const baseline = await baselineHarness.recall(fixture.query);

      const writeHarness = createHarness([...fixture.baseline_memories]);
      for (const signal of fixture.signals) {
        await writeHarness.receive(signal);
      }
      const after = await writeHarness.recall(fixture.query);
      const expectedObjectIds = fixture.expected_after_content.flatMap((content) =>
        writeHarness.memoryIdsByContent.get(content) ?? []
      );

      packs.push(
        buildRecallEvidencePack({
          fixture_id: fixture.fixture_id,
          query: fixture.query,
          result: after,
          expected_object_ids: expectedObjectIds,
          delivery: {
            delivery_id: `delivery-${fixture.fixture_id}`,
            delivered_object_ids: after.candidates.map((candidate) => candidate.object_id)
          },
          usage: {
            delivery_id: `delivery-${fixture.fixture_id}`,
            used_object_ids: expectedObjectIds
          }
        })
      );

      if (fixture.expected_after_content.length > 0) {
        expect(baseline.candidates.map((candidate) => candidate.object_id)).not.toEqual(
          expect.arrayContaining(expectedObjectIds)
        );
      }
    }

    expect(packs.map((pack) => pack.fixture_id)).toEqual([
      "exact_fact",
      "current_state_update",
      "negative_query",
      "relation_query",
      "broad_thematic_recall",
      "chinese_preference_constraint"
    ]);
    expect(packs.every((pack) => pack.metrics.factual_expected_hit)).toBe(true);
    expect(packs.find((pack) => pack.fixture_id === "negative_query")?.metrics).toMatchObject({
      selected_count: 0,
      coverage: 1
    });
    expect(packs.find((pack) => pack.fixture_id === "broad_thematic_recall")?.metrics).toMatchObject({
      expected_hit_count: 2,
      coverage: 1
    });
  });
});

function createHarness(initialMemories: MemoryEntry[]) {
  const memories = initialMemories;
  const signalRows = new Map<string, CandidateMemorySignal>();
  const memoryIdsByContent = new Map<string, string[]>();
  let memoryCounter = 0;
  let evidenceCounter = 0;
  let claimCounter = 0;
  let eventCounter = 0;

  for (const memory of memories) {
    memoryIdsByContent.set(memory.content, [
      ...(memoryIdsByContent.get(memory.content) ?? []),
      memory.object_id
    ]);
  }

  const router = new MaterializationRouter({
    evidenceService: {
      create: vi.fn(async () => ({
        object_kind: "evidence_capsule",
        object_id: `evidence-${++evidenceCounter}`
      }))
    },
    memoryService: {
      create: vi.fn(async (input: any) => {
        const objectId = `memory-${++memoryCounter}`;
        const memory = createMemoryEntry({
          object_id: objectId,
          dimension: input.dimension,
          source_kind: input.source_kind,
          formation_kind: input.formation_kind,
          scope_class: input.scope_class,
          content: input.content,
          domain_tags: input.domain_tags,
          evidence_refs: input.evidence_refs,
          workspace_id: input.workspace_id,
          run_id: input.run_id,
          surface_id: input.surface_id,
          storage_tier: input.storage_tier
        });
        memories.push(memory);
        memoryIdsByContent.set(input.content, [
          ...(memoryIdsByContent.get(input.content) ?? []),
          objectId
        ]);
        return { object_kind: "memory_entry", object_id: objectId };
      })
    },
    synthesisService: {
      create: vi.fn(async () => ({
        object_kind: "synthesis_capsule",
        object_id: "synthesis-1"
      }))
    },
    claimService: {
      create: vi.fn(async () => ({
        object_kind: "claim_form",
        object_id: `claim-${++claimCounter}`
      }))
    },
    handoffGapHandler: new InMemoryHandoffGapHandler(),
    graphEdgePort: {
      createEdge: vi.fn(async () => {})
    }
  });
  const signalService = new SignalService({
    eventLogRepo: {
      append: vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
        event_id: `event-${++eventCounter}`,
        created_at: "2026-05-13T00:00:00.000Z",
        revision: eventCounter,
        ...event
      })),
      queryByEntity: vi.fn(async () => [])
    },
    signalRepo: {
      create: vi.fn(async (signal) => {
        const stored = { ...signal, signal_state: "emitted" as const };
        signalRows.set(signal.signal_id, stored);
        return stored;
      }),
      getById: vi.fn(async (signalId: string) => signalRows.get(signalId) ?? null),
      listByRun: vi.fn(async (runId: string) =>
        [...signalRows.values()].filter((signal) => signal.run_id === runId)
      ),
      updateState: vi.fn(async (signalId: string, state: SignalState) => {
        const current = signalRows.get(signalId);
        if (current === undefined) {
          throw new Error(`missing signal ${signalId}`);
        }
        const updated = { ...current, signal_state: state };
        signalRows.set(signalId, updated);
        return updated;
      })
    },
    runtimeNotifier: {
      notifyEntry: vi.fn(async () => {})
    },
    postTriageMaterializer: {
      materialize: async (signal) => await router.materializeSignal(signal)
    }
  });

  return {
    memoryIdsByContent,
    receive: async (signal: CandidateMemorySignal) => await signalService.receiveSignal(signal),
    recall: async (query: string) => await recallWithMemories(memories, query)
  };
}

async function recallWithMemories(memories: readonly MemoryEntry[], query: string) {
  const service = new RecallService(createRecallDependencies(memories));
  const policy = createPolicy(service, query);
  return await service.recall({
    taskSurface: createTaskSurface(query),
    workspaceId: "workspace-1",
    strategy: "analyze",
    policyOverride: policy,
    hostContext: { tokenizer_hint: "approx_chars_per_token" }
  });
}

function createRecallDependencies(memories: readonly MemoryEntry[]): RecallServiceDependencies {
  return {
    now: () => "2026-05-13T00:00:00.000Z",
    generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    memoryRepo: {
      findByWorkspaceId: vi.fn(async (_workspaceId, tier) =>
        memories.filter((memory) => tier === undefined || memory.storage_tier === tier)
      ),
      findByDimension: vi.fn(async (_workspaceId, dimension) =>
        memories.filter((memory) => memory.dimension === dimension)
      ),
      findByScopeClass: vi.fn(async (_workspaceId, scopeClass) =>
        memories.filter((memory) => memory.scope_class === scopeClass)
      ),
      searchByKeywordWithinObjectIds: vi.fn(async (_workspaceId, queryText, limit, objectIds) => {
        const tokens = tokenize(queryText);
        return memories
          .filter((memory) => objectIds.includes(memory.object_id))
          .map((memory) => ({
            object_id: memory.object_id,
            normalized_rank: computeLexicalRank(tokens, memory)
          }))
          .filter((match) => match.normalized_rank > 0)
          .sort((left, right) => right.normalized_rank - left.normalized_rank)
          .slice(0, limit);
      })
    },
    slotRepo: { findByWorkspace: vi.fn(async () => []) },
    eventLogRepo: {
      append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
        event_id: "event-1",
        created_at: "2026-05-13T00:00:00.000Z",
        revision: 0,
        ...entry
      })),
      queryByEntity: vi.fn(async () => [])
    },
    graphSupportPort: {
      countInboundSupports: vi.fn(async (memoryId) =>
        memoryId.includes("relation") ? 3 : 0
      )
    }
  };
}

function createIntegrationFixtures(): readonly IntegrationFixture[] {
  return [
    {
      fixture_id: "exact_fact",
      query: "project codename aurora",
      baseline_memories: [],
      signals: [createSignal("signal-exact", "fact", "Project codename is Aurora.", ["project", "codename"])],
      expected_after_content: ["Project codename is Aurora."]
    },
    {
      fixture_id: "current_state_update",
      query: "current deploy status",
      baseline_memories: [
        createMemoryEntry({
          object_id: "baseline-status-old",
          content: "Deploy status was blocked yesterday.",
          activation_score: 0.2
        })
      ],
      signals: [createSignal("signal-current", "fact", "Current deploy status is green.", ["deploy"])],
      expected_after_content: ["Current deploy status is green."]
    },
    {
      fixture_id: "negative_query",
      query: "missing payments backlog",
      baseline_memories: [],
      signals: [],
      expected_after_content: []
    },
    {
      fixture_id: "relation_query",
      query: "router storage relation",
      baseline_memories: [],
      signals: [createSignal("signal-relation", "fact", "Router uses storage relation metadata.", ["router", "storage"])],
      expected_after_content: ["Router uses storage relation metadata."]
    },
    {
      fixture_id: "broad_thematic_recall",
      query: "memory quality",
      baseline_memories: [],
      signals: [
        createSignal("signal-density", "fact", "Memory quality evaluation tracks evidence density.", ["memory"]),
        createSignal("signal-redundancy", "fact", "Memory quality evaluation tracks redundancy.", ["memory"])
      ],
      expected_after_content: [
        "Memory quality evaluation tracks evidence density.",
        "Memory quality evaluation tracks redundancy."
      ]
    },
    {
      fixture_id: "chinese_preference_constraint",
      query: "中文 rtk 约束",
      baseline_memories: [],
      signals: [createSignal("signal-zh", "constraint", "必须用 rtk 包裹仓库命令。", ["中文", "rtk"])],
      expected_after_content: ["必须用 rtk 包裹仓库命令。"]
    }
  ];
}

function createSignal(
  signalId: string,
  objectKind: string,
  matchedText: string,
  domainTags: readonly string[]
): CandidateMemorySignal {
  return normalizeSchemaGroundedSignal({
    signal_id: signalId,
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: objectKind === "preference" ? "potential_preference" : "potential_claim",
    signal_state: "emitted",
    object_kind: objectKind,
    scope_hint: null,
    domain_tags: domainTags,
    confidence: 0.8,
    evidence_refs: [],
    raw_payload: { matched_text: matchedText },
    created_at: "2026-05-13T00:00:00.000Z"
  });
}

function createPolicy(service: RecallService, query: string): RecallPolicy {
  const base = service.buildDefaultPolicy("analyze", createTaskSurface(query).runtime_id);
  return {
    ...base,
    coarse_filter: {
      deterministic_match: {
        scope_filter: null,
        dimension_filter: null,
        domain_tag_filter: null
      },
      precomputed_rank: {
        max_candidates: 0,
        min_activation_score: null
      },
      semantic_supplement: {
        enabled: true,
        max_supplement: 8,
        embedding_enabled: false
      }
    },
    fine_assessment: {
      budgets: {
        max_entries: 5,
        max_total_tokens: 800,
        per_dimension_limits: null
      },
      conflict_awareness: true
    }
  };
}

function createTaskSurface(query: string): TaskObjectSurface {
  return {
    runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-05-13T00:30:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "build",
    display_name: query,
    context_refs: []
  };
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-13T00:00:00.000Z",
    updated_at: "2026-05-13T00:00:00.000Z",
    created_by: "system",
    dimension: MemoryDimension.FACT,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "Memory content.",
    domain_tags: ["memory"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.7,
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

function computeLexicalRank(queryTokens: readonly string[], memory: MemoryEntry): number {
  const haystack = `${memory.content} ${memory.domain_tags.join(" ")}`.toLowerCase();
  const hits = queryTokens.filter((token) => haystack.includes(token.toLowerCase())).length;
  return queryTokens.length === 0 ? 0 : hits / queryTokens.length;
}

function tokenize(value: string): readonly string[] {
  return value
    .toLowerCase()
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}
