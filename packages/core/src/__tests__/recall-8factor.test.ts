import { describe, expect, it, vi } from "vitest";
import {
  BankruptcyKind,
  ControlPlaneObjectKind,
  DYNAMICS_CONSTANTS,
  MemoryDimension,
  RetentionPolicy,
  ScopeClass,
  type ActivationWeights,
  type EventLogEntry,
  type MemoryEntry,
  type RecallPolicy,
  type Slot,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import { RecallService, type RecallServiceDependencies } from "../recall-service.js";
import { mapBudgetPenalty, PATH_PLASTICITY_WEIGHT } from "../recall-service-helpers.js";

function createTaskSurface(displayName = "Implement recall"): TaskObjectSurface {
  return {
    runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-03-23T00:30:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "build",
    display_name: displayName,
    context_refs: []
  };
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "system",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for workspace commands.",
    domain_tags: ["repo"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.7,
    retention_score: 0.8,
    manifestation_state: "full_eligible",
    retention_state: "consolidated",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: "2026-03-23T00:00:00.000Z",
    last_hit_at: "2026-03-23T00:00:00.000Z",
    reinforcement_count: 3,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

function createSlot(overrides: Partial<Slot> = {}): Slot {
  return {
    object_id: "slot-1",
    object_kind: "slot",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "system",
    governance_subject: {
      subject_domain: "repo",
      subject_qualifiers: { category: "tooling" },
      canonical_key: "repo::category=tooling"
    },
    claim_kind: "constraint",
    scope_class: ScopeClass.PROJECT,
    winner_claim_id: "claim-form-winner-1",
    incumbent_since: "2026-03-20T00:00:00.000Z",
    flip_conditions: [],
    workspace_id: "workspace-1",
    ...overrides
  };
}

function createDependencies(
  memories: readonly MemoryEntry[],
  slots: readonly Slot[] = [],
  // Maps claim object_id -> source_object_refs (backing memory IDs).
  claimSourceRefs: Readonly<Record<string, readonly string[]>> = {},
  supportOptions: Readonly<{
    readonly graphSupportByMemoryId?: Readonly<Record<string, number>>;
    readonly pathPlasticityByMemoryId?: Readonly<Record<string, number>>;
  }> = {}
): {
  readonly dependencies: RecallServiceDependencies;
  readonly searchByKeyword: ReturnType<typeof vi.fn>;
  readonly countInboundSupports: ReturnType<typeof vi.fn>;
  readonly countInboundEdgesWeighted: ReturnType<typeof vi.fn>;
  readonly getSnapshot: ReturnType<typeof vi.fn>;
} {
  const searchByKeyword = vi.fn(async () => [{ object_id: memories[1]?.object_id ?? "memory-2", normalized_rank: 1 }]);
  const countInboundSupports = vi.fn(async (memoryId: string) => {
    if (supportOptions.graphSupportByMemoryId !== undefined) {
      return supportOptions.graphSupportByMemoryId[memoryId] ?? 0;
    }
    return memoryId === "memory-2" ? 3 : 0;
  });
  const getStrengthByMemoryId = vi.fn(async (_workspaceId: string, memoryIds: readonly string[]) =>
    new Map(
      memoryIds.flatMap((memoryId) => {
        const strength = supportOptions.pathPlasticityByMemoryId?.[memoryId];
        return strength === undefined ? [] : [[memoryId, strength] as const];
      })
    )
  );
  const getSnapshot = vi.fn(async () => ({
    snapshot_at: "2026-03-23T00:00:00.000Z",
    run_id: "run-1",
    current_mode: "lean",
    bankruptcy_kind: BankruptcyKind.SOFT,
    trigger_summary: "over budget",
    active_dossier: null,
    pending_proposal: null
  }));
  const append = vi.fn(
    async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): Promise<EventLogEntry> => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-03-23T00:00:00.000Z",
      revision: 0,
      ...entry
    })
  );

  return {
    dependencies: {
      now: () => "2026-03-23T00:00:00.000Z",
      generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      memoryRepo: {
        findByWorkspaceId: vi.fn(async () => memories),
        findByDimension: vi.fn(async () => memories),
        findByScopeClass: vi.fn(async () => memories),
        searchByKeyword
      } as RecallServiceDependencies["memoryRepo"],
      slotRepo: {
        findByWorkspace: vi.fn(async () => slots)
      },
      eventLogRepo: {
        append,
        queryByEntity: vi.fn(async () => [])
      },
      graphSupportPort: {
        countInboundSupports,
        countInboundEdgesWeighted: countInboundSupports
      },
      budgetPenaltyPort: {
        getSnapshot
      },
      ...(supportOptions.pathPlasticityByMemoryId === undefined
        ? {}
        : {
            pathPlasticityPort: {
              getStrengthByMemoryId
            }
          }),
      claimResolverPort: {
        findByIds: vi.fn(async (ids: readonly string[]) =>
          ids
            .filter((id) => claimSourceRefs[id] !== undefined)
            .map((id) => ({ object_id: id, source_object_refs: claimSourceRefs[id] ?? [] }))
        )
      }
    } as RecallServiceDependencies,
    searchByKeyword,
    countInboundSupports,
    countInboundEdgesWeighted: countInboundSupports,
    getSnapshot
  };
}

function overridePolicy(base: Readonly<RecallPolicy>, patch: Partial<RecallPolicy>): RecallPolicy {
  return {
    ...base,
    ...patch,
    coarse_filter: patch.coarse_filter ?? base.coarse_filter,
    fine_assessment: patch.fine_assessment ?? base.fine_assessment
  };
}

function sumActivationWeights(weights: Readonly<ActivationWeights>): number {
  return (
    weights.scope_match +
    weights.domain_match +
    weights.retention +
    weights.freshness +
    weights.relevance +
    weights.graph_support +
    weights.budget_penalty +
    weights.conflict_penalty
  );
}

function expectScoreWeightTotalConserved(
  weights: Readonly<ActivationWeights>,
  effectivePathWeight: number
): void {
  expect(sumActivationWeights(weights) + effectivePathWeight).toBeCloseTo(
    sumActivationWeights(DYNAMICS_CONSTANTS.activation_weights_phase4b) + PATH_PLASTICITY_WEIGHT
  );
}

describe("RecallService 8-factor scoring", () => {
  it("maps budget pressure to a graduated monotonic penalty", () => {
    const baseSnapshot = {
      snapshot_at: "2026-05-11T00:00:00.000Z",
      run_id: "run-1",
      current_mode: "lean",
      trigger_summary: null,
      active_dossier: null,
      pending_proposal: null
    } as const;
    const ratios = [0, 0.5, 0.75, 0.99] as const;
    const penalties = ratios.map((pressure_ratio) =>
      mapBudgetPenalty({
        ...baseSnapshot,
        bankruptcy_kind: BankruptcyKind.SOFT,
        pressure_ratio
      })
    );

    expect(mapBudgetPenalty({ ...baseSnapshot, bankruptcy_kind: BankruptcyKind.NONE, pressure_ratio: 0 })).toBe(0);
    expect(mapBudgetPenalty({ ...baseSnapshot, bankruptcy_kind: BankruptcyKind.HARD, pressure_ratio: 1 })).toBe(1);
    expect(
      mapBudgetPenalty({
        ...baseSnapshot,
        bankruptcy_kind: BankruptcyKind.SOFT
      } as never)
    ).toBe(0);
    expect(penalties[0]).toBe(0);
    expect(penalties[1]).toBeCloseTo(0.1);
    expect(penalties[2]).toBeCloseTo(0.4);
    expect(penalties[3]).toBeGreaterThan(penalties[2]);
  });

  it("keeps the default keyword supplement enabled in default policy", () => {
    const { dependencies } = createDependencies([]);
    const service = new RecallService(dependencies);

    expect(service.buildDefaultPolicy("chat", createTaskSurface().runtime_id).coarse_filter.semantic_supplement).toEqual({
      enabled: true,
      max_supplement: 5,
      embedding_enabled: false
    });
  });

  it("adds FTS supplement candidates and ranks by effective relevance_score", async () => {
    const memories = [
      createMemoryEntry({ object_id: "memory-1", content: "Alpha", activation_score: 0.72 }),
      createMemoryEntry({ object_id: "memory-2", content: "Implement recall", activation_score: 0.55 })
    ];
    const { dependencies, searchByKeyword, countInboundSupports, getSnapshot } = createDependencies(memories);
    const service = new RecallService(dependencies);
    const basePolicy = service.buildDefaultPolicy("build", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      coarse_filter: {
        ...basePolicy.coarse_filter,
        semantic_supplement: {
          enabled: true,
          max_supplement: 5
        },
        deterministic_match: {
          ...basePolicy.coarse_filter.deterministic_match,
          scope_filter: null,
          dimension_filter: null
        }
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface("Implement recall"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build",
      policyOverride: policy
    });

    expect(searchByKeyword).toHaveBeenCalledWith("workspace-1", "Implement recall", 5);
    expect(countInboundSupports).toHaveBeenCalledWith("memory-2", "workspace-1");
    expect(getSnapshot).toHaveBeenCalledWith("run-1");
    expect(result.candidates[0]?.object_id).toBe("memory-2");
    expect(result.candidates[0]?.relevance_score).toBeGreaterThan(result.candidates[1]?.relevance_score ?? 0);
  });

  it("uses token-estimator hints per recall call without leaking global state", async () => {
    const content = "x".repeat(36);
    const { dependencies } = createDependencies([
      createMemoryEntry({ object_id: "memory-1", content, activation_score: 0.7 })
    ]);
    const service = new RecallService(dependencies);
    const baseParams = {
      taskSurface: createTaskSurface("token estimate"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build" as const
    };

    const noHint = await service.recall(baseParams);
    const cl100k = await service.recall({
      ...baseParams,
      hostContext: { tokenizer_hint: "cl100k" }
    });
    const noHintAgain = await service.recall(baseParams);

    expect(noHint.candidates[0]?.token_estimate).toBe(9);
    expect(cl100k.candidates[0]?.token_estimate).toBe(10);
    expect(noHintAgain.candidates[0]?.token_estimate).toBe(9);
  });

  it("records valid per-domain activation weight overrides in score factors", async () => {
    const { dependencies } = createDependencies(
      [
        createMemoryEntry({
          object_id: "memory-1",
          content: "Domain-specific recall weighting",
          domain_tags: ["repo", "docs"]
        })
      ],
      [],
      {},
      { graphSupportByMemoryId: { "memory-1": 1 } }
    );
    const service = new RecallService(dependencies);
    const basePolicy = service.buildDefaultPolicy("build", createTaskSurface().runtime_id);
    const policy = overridePolicy(basePolicy, {
      domain_weight_overrides: {
        docs: {
          scope_match: 0.08,
          relevance: 0.2
        }
      }
    });

    const result = await service.recall({
      taskSurface: createTaskSurface("Domain-specific recall weighting"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build",
      policyOverride: policy
    });

    expect(result.candidates[0]?.score_factors?.resolved_activation_weights).toMatchObject({
      ...DYNAMICS_CONSTANTS.activation_weights_phase4b,
      scope_match: 0.08,
      relevance: 0.2
    });
  });

  it.each([
    {
      caseName: "no graph, no path",
      graphSupport: 0,
      pathPlasticity: undefined,
      expectedRelevanceWeight: 0.3,
      expectedGraphWeight: 0,
      expectedGraphFactor: 0,
      expectedPathFactor: 0,
      effectivePathWeight: 0
    },
    {
      caseName: "only graph",
      graphSupport: 3,
      pathPlasticity: undefined,
      expectedRelevanceWeight: 0.1,
      expectedGraphWeight: 0.05,
      expectedGraphFactor: 1,
      expectedPathFactor: 0,
      effectivePathWeight: PATH_PLASTICITY_WEIGHT
    },
    {
      caseName: "only path",
      graphSupport: 0,
      pathPlasticity: 0.6,
      expectedRelevanceWeight: 0.1,
      expectedGraphWeight: 0.05,
      expectedGraphFactor: 0,
      expectedPathFactor: 0.6,
      effectivePathWeight: PATH_PLASTICITY_WEIGHT
    },
    {
      caseName: "both",
      graphSupport: 3,
      pathPlasticity: 0.6,
      expectedRelevanceWeight: 0.1,
      expectedGraphWeight: 0.05,
      expectedGraphFactor: 1,
      expectedPathFactor: 0.6,
      effectivePathWeight: PATH_PLASTICITY_WEIGHT
    }
  ])(
    "keeps score weight total stable with dynamic graph/path reallocation when $caseName",
    async ({
      graphSupport,
      pathPlasticity,
      expectedRelevanceWeight,
      expectedGraphWeight,
      expectedGraphFactor,
      expectedPathFactor,
      effectivePathWeight
    }) => {
      const { dependencies, searchByKeyword } = createDependencies(
        [
          createMemoryEntry({
            object_id: "memory-1",
            content: "Dynamic scoring evidence"
          })
        ],
        [],
        {},
        {
          graphSupportByMemoryId: { "memory-1": graphSupport },
          ...(pathPlasticity === undefined
            ? {}
            : { pathPlasticityByMemoryId: { "memory-1": pathPlasticity } })
        }
      );
      searchByKeyword.mockResolvedValue([{ object_id: "memory-1", normalized_rank: 1 }]);
      const service = new RecallService(dependencies);

      const result = await service.recall({
        taskSurface: createTaskSurface("Dynamic scoring evidence"),
        workspaceId: "workspace-1",
        runId: "run-1",
        strategy: "build"
      });

      const candidate = result.candidates[0];
      const weights = candidate?.score_factors?.resolved_activation_weights;
      expect(weights).toBeDefined();
      expect(weights?.relevance).toBeCloseTo(expectedRelevanceWeight);
      expect(weights?.graph_support).toBeCloseTo(expectedGraphWeight);
      expect(candidate?.score_factors?.graph_support).toBeCloseTo(expectedGraphFactor);
      expect(candidate?.score_factors?.path_plasticity).toBeCloseTo(expectedPathFactor);
      expectScoreWeightTotalConserved(weights as ActivationWeights, effectivePathWeight);
    }
  );

  it("applies conflict penalty to non-winner claim-like entries", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "claim-1",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.65,
        content: "Loser"
      }),
      createMemoryEntry({
        // Distinct memory ID; the slot's winner_claim_id is a ClaimForm ID, not a memory ID.
        object_id: "winner-claim-1",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.65,
        content: "Winner"
      })
    ];
    // "claim-form-winner-1" is the ClaimForm object_id stored in the slot.
    // Its source_object_refs points to the backing memory "winner-claim-1".
    const claimSourceRefs = { "claim-form-winner-1": ["winner-claim-1"] };
    const { dependencies } = createDependencies(memories, [createSlot()], claimSourceRefs);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("claim review"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "analyze"
    });

    const winner = result.candidates.find((candidate) => candidate.object_id === "winner-claim-1");
    const loser = result.candidates.find((candidate) => candidate.object_id === "claim-1");

    expect(winner?.relevance_score).toBeGreaterThan(loser?.relevance_score ?? 0);
  });
});
