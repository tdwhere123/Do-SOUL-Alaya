import { describe, expect, it, vi } from "vitest";
import {
  BankruptcyKind,
  ControlPlaneObjectKind,
  DYNAMICS_CONSTANTS,
  MemoryDimension,
  RecallContextEventType,
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

const FALSE_CONFIDENT_ACCEPTANCE_THRESHOLD = 0.91;

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
    readonly recallsEdgeCountByMemoryId?: Readonly<Record<string, number>>;
    readonly pathPlasticityByMemoryId?: Readonly<Record<string, number>>;
  }> = {}
): {
  readonly dependencies: RecallServiceDependencies;
  readonly searchByKeyword: ReturnType<typeof vi.fn>;
  readonly countInboundSupports: ReturnType<typeof vi.fn>;
  readonly countInboundEdgesWeighted: ReturnType<typeof vi.fn>;
  readonly append: ReturnType<typeof vi.fn>;
  readonly getSnapshot: ReturnType<typeof vi.fn>;
} {
  const searchByKeyword = vi.fn(async () => [{ object_id: memories[1]?.object_id ?? "memory-2", normalized_rank: 1 }]);
  const countInboundSupports = vi.fn(async (memoryId: string) => {
    if (supportOptions.graphSupportByMemoryId !== undefined) {
      return supportOptions.graphSupportByMemoryId[memoryId] ?? 0;
    }
    return memoryId === "memory-2" ? 3 : 0;
  });
  const countInboundRecalls = vi.fn(async (memoryId: string) =>
    supportOptions.recallsEdgeCountByMemoryId?.[memoryId] ?? 0
  );
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
        countInboundEdgesWeighted: countInboundSupports,
        countInboundRecalls
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
    append,
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

  it("adds FTS supplement candidates and treats direct FTS rank as lexical structural evidence", async () => {
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
      taskSurface: createTaskSurface("zulu omega"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build",
      policyOverride: policy
    });

    expect(searchByKeyword).toHaveBeenCalledWith("workspace-1", "zulu omega", 5);
    expect(countInboundSupports).toHaveBeenCalledWith("memory-2", "workspace-1");
    expect(getSnapshot).toHaveBeenCalledWith("run-1");
    const ftsCandidate = result.candidates.find((candidate) => candidate.object_id === "memory-2");
    const ftsDiagnostic = result.diagnostics?.candidates.find((candidate) => candidate.object_id === "memory-2");
    expect(ftsCandidate).toBeDefined();
    expect(ftsDiagnostic).toMatchObject({
      lexical_rank: 1
    });
    expect(ftsDiagnostic?.structural_score).toBe(1);
    expect(ftsDiagnostic?.admission_planes).toContain("lexical");
    expect(ftsDiagnostic?.source_channels).toContain("lexical");
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

  it("applies explicit additive scoring weight overrides from RecallPolicy", async () => {
    const { dependencies } = createDependencies([
      createMemoryEntry({
        object_id: "memory-1",
        content: "Confidence weighted recall candidate",
        confidence: 1,
        activation_score: 0.7,
        domain_tags: ["bench-seed", "bench-reviewed"]
      })
    ]);
    const service = new RecallService(dependencies);
    const taskSurface = createTaskSurface("Confidence weighted recall candidate");
    const basePolicy = service.buildDefaultPolicy("build", taskSurface.runtime_id);
    const override = overridePolicy(basePolicy, {
      scoring_weight_overrides: {
        additive: {
          CONFIDENCE_DIRECT_WEIGHT: 0.2
        }
      }
    });

    const baseResult = await service.recall({
      taskSurface,
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build",
      policyOverride: basePolicy
    });
    const overrideResult = await service.recall({
      taskSurface,
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build",
      policyOverride: override
    });

    expect(overrideResult.candidates[0]?.relevance_score).toBeGreaterThan(
      baseResult.candidates[0]?.relevance_score ?? 0
    );
    expect(
      (overrideResult.candidates[0]?.relevance_score ?? 0) -
        (baseResult.candidates[0]?.relevance_score ?? 0)
    ).toBeGreaterThan(0.08);
  });

  it("dynamically transfers base prior weight to strong query evidence", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "stale-prior",
        content: "Generic workspace habit",
        activation_score: 1,
        confidence: 0.9
      }),
      createMemoryEntry({
        object_id: "query-match",
        content: "Exact query evidence needle",
        activation_score: 0.6,
        confidence: 0.9
      })
    ];
    const { dependencies, searchByKeyword } = createDependencies(
      memories,
      [],
      {},
      {
        graphSupportByMemoryId: { "stale-prior": 0, "query-match": 0 },
        recallsEdgeCountByMemoryId: { "stale-prior": 50, "query-match": 50 }
      }
    );
    searchByKeyword.mockResolvedValue([{ object_id: "query-match", normalized_rank: 1 }]);
    const service = new RecallService(dependencies);
    const taskSurface = createTaskSurface("Exact query evidence needle");
    const basePolicy = service.buildDefaultPolicy("build", taskSurface.runtime_id);
    const noTransferPolicy = overridePolicy(basePolicy, {
      scoring_weight_overrides: {
        fusion_weights: {
          QUERY_EVIDENCE_BASE_TRANSFER_MAX: 0
        }
      }
    });

    const withoutTransfer = await service.recall({
      taskSurface,
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build",
      policyOverride: noTransferPolicy
    });
    const withTransfer = await service.recall({
      taskSurface,
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build",
      policyOverride: basePolicy
    });

    expect(withoutTransfer.candidates[0]?.object_id).toBe("query-match");
    expect(withTransfer.candidates[0]?.object_id).toBe("query-match");
    expect(withoutTransfer.candidates[0]?.score_factors?.query_evidence_transfer).toBeCloseTo(0);
    expect(withTransfer.candidates[0]?.score_factors?.content_relevance).toBeCloseTo(1);
    expect(withTransfer.candidates[0]?.score_factors?.query_evidence_transfer).toBeCloseTo(0.25);
    expect(withTransfer.candidates[0]?.score_factors?.adjusted_base_weight).toBeCloseTo(0.45);
    expect(withTransfer.candidates[0]?.score_factors?.effective_relevance_weight).toBeCloseTo(0.59);
    expect(withTransfer.candidates[0]?.score_factors?.weighted_query_evidence_transfer).toBeCloseTo(0.25);
  });

  it("keeps weak or absent evidence below false-confident recall confidence", async () => {
    const { dependencies: noEvidenceDependencies, searchByKeyword: noEvidenceSearch } = createDependencies([
      createMemoryEntry({
        object_id: "no-evidence",
        content: "Dormant unrelated prior",
        activation_score: 1,
        confidence: 1
      })
    ]);
    noEvidenceSearch.mockResolvedValue([]);
    const noEvidenceService = new RecallService(noEvidenceDependencies);

    const noEvidenceResult = await noEvidenceService.recall({
      taskSurface: createTaskSurface("missing answer query"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });
    const noEvidence = noEvidenceResult.candidates.find((candidate) => candidate.object_id === "no-evidence");

    expect(noEvidence?.score_factors?.content_relevance ?? 0).toBe(0);
    expect(noEvidence?.relevance_score ?? 1).toBeLessThan(FALSE_CONFIDENT_ACCEPTANCE_THRESHOLD);

    const { dependencies, searchByKeyword } = createDependencies(
      [
        createMemoryEntry({
          object_id: "weak-lexical",
          content: "Archived unrelated policy fragment",
          activation_score: 1,
          confidence: 1
        })
      ],
      [],
      {},
      {
        graphSupportByMemoryId: { "weak-lexical": 0 }
      }
    );
    searchByKeyword.mockResolvedValue([{ object_id: "weak-lexical", normalized_rank: 0.65 }]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("missing answer query"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });

    const weakLexical = result.candidates.find((candidate) => candidate.object_id === "weak-lexical");

    expect(weakLexical?.score_factors?.content_relevance).toBeCloseTo(0.65);
    expect(weakLexical?.score_factors?.graph_support ?? 0).toBe(0);
    expect(weakLexical?.score_factors?.adjusted_base_weight).toBeLessThan(
      (weakLexical?.score_factors?.base_weight ?? 0) -
        (weakLexical?.score_factors?.query_evidence_transfer ?? 0)
    );
    expect(weakLexical?.score_factors?.weighted_relevance).toBeLessThan(
      (weakLexical?.score_factors?.content_relevance ?? 0) *
        (weakLexical?.score_factors?.resolved_activation_weights?.relevance ?? 0)
    );
    const weakFactors = weakLexical?.score_factors;
    const deliveredWeightedRelevance =
      (weakFactors?.weighted_relevance ?? 0) +
      (weakFactors?.weighted_relevance_direct ?? 0) +
      (weakFactors?.weighted_query_evidence_transfer ?? 0);
    expect(deliveredWeightedRelevance).toBeCloseTo(
      (weakFactors?.content_relevance ?? 0) *
        (weakFactors?.effective_relevance_weight ?? 0)
    );
    expect(weakLexical?.relevance_score ?? 1).toBeLessThan(FALSE_CONFIDENT_ACCEPTANCE_THRESHOLD);
  });

  it("keeps off-topic path-plasticity candidates below false-confident recall confidence", async () => {
    const { dependencies, searchByKeyword } = createDependencies(
      [
        createMemoryEntry({
          object_id: "off-topic-path",
          content: "Dormant unrelated prior",
          dimension: MemoryDimension.FACT,
          activation_score: 1,
          confidence: 1
        })
      ],
      [],
      {},
      {
        graphSupportByMemoryId: { "off-topic-path": 0 },
        pathPlasticityByMemoryId: { "off-topic-path": 1 }
      }
    );
    searchByKeyword.mockResolvedValue([]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("missing answer query"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "chat"
    });

    const offTopic = result.candidates.find((candidate) => candidate.object_id === "off-topic-path");

    expect(offTopic?.score_factors?.content_relevance).toBe(0);
    expect(offTopic?.score_factors?.graph_support ?? 0).toBe(0);
    expect(offTopic?.score_factors?.path_plasticity).toBe(1);
    expect(offTopic?.relevance_score ?? 1).toBeLessThan(FALSE_CONFIDENT_ACCEPTANCE_THRESHOLD);
  });

  it("keeps weak conflicted contradiction losers below false-confident recall confidence", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "losing-claim",
        content: "Stale contradicted prior",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 1,
        confidence: 1,
        contradiction_count: 1
      }),
      createMemoryEntry({
        object_id: "winner-claim-1",
        content: "Current accepted procedure",
        dimension: MemoryDimension.PROCEDURE,
        activation_score: 0.75,
        confidence: 1
      })
    ];
    const { dependencies, searchByKeyword } = createDependencies(
      memories,
      [createSlot()],
      { "claim-form-winner-1": ["winner-claim-1"] },
      {
        graphSupportByMemoryId: { "losing-claim": 0, "winner-claim-1": 0 }
      }
    );
    // invariant: this test exercises the WEAK-evidence arbitration-loser
    // path. normalized_rank must keep content_relevance below
    // WEAK_EVIDENCE_CALIBRATION_GATE (0.72) so calibration fires;
    // otherwise the loser rides priors past the false-confident floor
    // even with conflict_penalty applied.
    searchByKeyword.mockResolvedValue([{ object_id: "losing-claim", normalized_rank: 0.5 }]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("weak contradicted procedure"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "analyze"
    });

    const loser = result.candidates.find((candidate) => candidate.object_id === "losing-claim");

    expect(loser?.score_factors?.content_relevance).toBeLessThan(0.72);
    expect(loser?.score_factors?.conflict_penalty).toBe(1);
    expect(loser?.score_factors?.contradiction_penalty).toBeCloseTo(0.05);
    expect(loser?.relevance_score ?? 1).toBeLessThan(FALSE_CONFIDENT_ACCEPTANCE_THRESHOLD);
  });

  it("does not cap strong lexical evidence below useful recall confidence", async () => {
    const { dependencies, searchByKeyword } = createDependencies([
      createMemoryEntry({
        object_id: "strong-evidence",
        content: "Direct answer evidence",
        activation_score: 1,
        confidence: 1
      })
    ]);
    searchByKeyword.mockResolvedValue([{ object_id: "strong-evidence", normalized_rank: 1 }]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("Direct answer evidence"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });

    const strong = result.candidates.find((candidate) => candidate.object_id === "strong-evidence");

    expect(strong?.score_factors?.content_relevance).toBeCloseTo(1);
    expect(strong?.relevance_score ?? 0).toBeGreaterThan(FALSE_CONFIDENT_ACCEPTANCE_THRESHOLD);
  });

  // invariant: shouldCalibrateWeakEvidence must NOT fire when query-grounded
  // evidence sits at or above WEAK_EVIDENCE_CALIBRATION_GATE. Strong-
  // evidence queries keep the un-calibrated score shape; full-weak queries
  // with no prior signal do not enter the calibration branch at all.
  it("does not reshape strong query-grounded evidence below saturation", async () => {
    const { dependencies, searchByKeyword } = createDependencies(
      [
        createMemoryEntry({
          object_id: "strong-multi-evidence",
          content: "Strong multi-signal evidence",
          activation_score: 1,
          confidence: 1
        })
      ],
      [],
      {},
      {
        // graph_support count 3 → normalizeGraphSupport returns 1.0 (above
        // WEAK_EVIDENCE_CALIBRATION_GATE). queryEvidenceCalibrationStrength
        // = max(relevance, graph_support, embedding) ≥ 1.0, so the gate
        // condition `< 0.72` is false.
        graphSupportByMemoryId: { "strong-multi-evidence": 3 }
      }
    );
    searchByKeyword.mockResolvedValue([
      { object_id: "strong-multi-evidence", normalized_rank: 0.9 }
    ]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("Strong multi-signal evidence"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });

    const strong = result.candidates.find(
      (candidate) => candidate.object_id === "strong-multi-evidence"
    );
    const factors = strong?.score_factors;
    expect(factors?.graph_support).toBeCloseTo(1);

    // gate did not fire → weighted_relevance is content_relevance *
    // resolved relevance weight (no evidenceContributionCalibration shrink).
    const expectedWeightedRelevance =
      (factors?.content_relevance ?? 0) *
      (factors?.resolved_activation_weights?.relevance ?? 0);
    expect(factors?.weighted_relevance ?? 0).toBeCloseTo(expectedWeightedRelevance);

    // gate did not fire → adjusted_base_weight equals base_weight minus
    // queryEvidenceTransfer (no priorEvidenceCalibration shrink).
    const expectedAdjustedBaseWeight = Math.max(
      0,
      (factors?.base_weight ?? 0) - (factors?.query_evidence_transfer ?? 0)
    );
    expect(factors?.adjusted_base_weight ?? 0).toBeCloseTo(expectedAdjustedBaseWeight);
  });

  it("calibrates weak-evidence candidates carrying a prior signal", async () => {
    const { dependencies, searchByKeyword } = createDependencies(
      [
        createMemoryEntry({
          object_id: "weak-prior-heavy",
          content: "Tangential prior text",
          activation_score: 1,
          confidence: 1
        })
      ],
      [],
      {},
      {
        graphSupportByMemoryId: { "weak-prior-heavy": 0 }
      }
    );
    // normalized_rank 0.5 → content_relevance ≈ 0.31, below floor 0.72.
    searchByKeyword.mockResolvedValue([
      { object_id: "weak-prior-heavy", normalized_rank: 0.5 }
    ]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("missing answer query"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });

    const weak = result.candidates.find(
      (candidate) => candidate.object_id === "weak-prior-heavy"
    );
    const factors = weak?.score_factors;

    // gate fired → weighted_relevance strictly less than the un-calibrated
    // upper bound (content_relevance * resolved relevance weight).
    const upperWeightedRelevance =
      (factors?.content_relevance ?? 0) *
      (factors?.resolved_activation_weights?.relevance ?? 0);
    expect(factors?.weighted_relevance ?? 0).toBeLessThan(upperWeightedRelevance);

    // gate fired → adjusted_base_weight strictly less than the un-calibrated
    // upper bound (base_weight - queryEvidenceTransfer).
    const upperAdjustedBaseWeight =
      (factors?.base_weight ?? 0) - (factors?.query_evidence_transfer ?? 0);
    expect(factors?.adjusted_base_weight ?? 0).toBeLessThan(upperAdjustedBaseWeight);
    expect(weak?.relevance_score ?? 1).toBeLessThan(FALSE_CONFIDENT_ACCEPTANCE_THRESHOLD);
  });

  it("does not calibrate when neither prior nor evidence is present", async () => {
    const { dependencies, searchByKeyword } = createDependencies(
      [
        createMemoryEntry({
          object_id: "all-weak",
          content: "Dormant unrelated text",
          activation_score: 0,
          confidence: 0
        })
      ],
      [],
      {},
      {
        graphSupportByMemoryId: { "all-weak": 0 }
      }
    );
    // no FTS hit → content_relevance 0, graph_support 0, plasticity absent,
    // activation 0, confidence 0 → prior-side inner condition is false.
    searchByKeyword.mockResolvedValue([]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("missing answer query"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });

    const allWeak = result.candidates.find(
      (candidate) => candidate.object_id === "all-weak"
    );
    const factors = allWeak?.score_factors;
    expect(factors?.content_relevance ?? 0).toBe(0);

    // gate did not fire (no prior signal) → weighted_relevance equals the
    // un-calibrated product. Both sides are 0 here but the equality still
    // pins the "no reshape" semantics.
    const expectedWeightedRelevance =
      (factors?.content_relevance ?? 0) *
      (factors?.resolved_activation_weights?.relevance ?? 0);
    expect(factors?.weighted_relevance ?? 0).toBeCloseTo(expectedWeightedRelevance);

    // adjusted_base_weight equals base_weight - queryEvidenceTransfer, with
    // no priorEvidenceCalibration shrink.
    const expectedAdjustedBaseWeight = Math.max(
      0,
      (factors?.base_weight ?? 0) - (factors?.query_evidence_transfer ?? 0)
    );
    expect(factors?.adjusted_base_weight ?? 0).toBeCloseTo(expectedAdjustedBaseWeight);
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

  it("graduates cold-mode transfer by inbound RECALLS edge count and records audit telemetry", async () => {
    const { dependencies, searchByKeyword, append } = createDependencies(
      [
        createMemoryEntry({
          object_id: "memory-1",
          content: "Graduated cold score evidence"
        })
      ],
      [],
      {},
      {
        graphSupportByMemoryId: { "memory-1": 0 },
        recallsEdgeCountByMemoryId: { "memory-1": 25 }
      }
    );
    searchByKeyword.mockResolvedValue([{ object_id: "memory-1", normalized_rank: 1 }]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("Graduated cold score evidence"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });

    const factors = result.candidates[0]?.score_factors;
    const weights = factors?.resolved_activation_weights;
    expect(weights).toBeDefined();
    expect(weights?.relevance).toBeCloseTo(0.2);
    expect(weights?.graph_support).toBeCloseTo(0.025);
    expect(factors?.graph_path_cold_score).toBeCloseTo(0.5);
    expect(factors?.recalls_edge_count).toBe(25);
    expect(factors?.weight_transfer_amount).toBeCloseTo(0.1);
    expectScoreWeightTotalConserved(weights as ActivationWeights, 0.075);
    const transferEvent = append.mock.calls
      .map((call) => call[0])
      .find((entry) => entry.event_type === RecallContextEventType.SOUL_RECALL_WEIGHT_TRANSFER);
    expect(transferEvent).toMatchObject({
      entity_type: "recall_weight_transfer",
      workspace_id: "workspace-1",
      run_id: "run-1",
      payload_json: expect.objectContaining({
        cold_score: 0.5,
        recalls_edge_count: 25,
        recalls_threshold: 50
      })
    });
    expect(
      (transferEvent?.payload_json as { readonly transferred_amount?: number })?.transferred_amount
    ).toBeCloseTo(0.1);
  });

  // invariant: cold graph/path transfer is candidate-set scoped. Mixed candidate
  // sets with any graph/path support keep baseline weights so candidates with
  // real graph evidence are not inflated by a cold-path transfer.
  it("keeps baseline weights when only some candidates have graph/path support (mixed)", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-cold",
        content: "Cold candidate - no graph, no path"
      }),
      createMemoryEntry({
        object_id: "memory-warm",
        content: "Warm candidate — has graph support"
      })
    ];
    const { dependencies, searchByKeyword } = createDependencies(
      memories,
      [],
      {},
      {
        graphSupportByMemoryId: { "memory-cold": 0, "memory-warm": 3 }
      }
    );
    searchByKeyword.mockResolvedValue([
      { object_id: "memory-cold", normalized_rank: 1 },
      { object_id: "memory-warm", normalized_rank: 1 }
    ]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("Mixed cold/warm scoring evidence"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });

    for (const candidate of result.candidates) {
      const weights = candidate.score_factors?.resolved_activation_weights;
      expect(weights).toBeDefined();
      // Baseline relevance + graph_support, NOT the cold-reallocation
      // relevance: 0.3 / graph_support: 0 shape.
      expect(weights?.relevance).toBeCloseTo(0.1);
      expect(weights?.graph_support).toBeCloseTo(0.05);
    }
  });

  it("orders identical memories by confidence sub-weight", async () => {
    const memories = [
      createMemoryEntry({
        object_id: "memory-low-confidence",
        content: "shared identical content body",
        confidence: 0.2
      }),
      createMemoryEntry({
        object_id: "memory-high-confidence",
        content: "shared identical content body",
        confidence: 0.95
      })
    ];
    const { dependencies, searchByKeyword } = createDependencies(memories);
    searchByKeyword.mockResolvedValue([]);
    const service = new RecallService(dependencies);

    const result = await service.recall({
      taskSurface: createTaskSurface("shared identical content body"),
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });

    const high = result.candidates.find((candidate) => candidate.object_id === "memory-high-confidence");
    const low = result.candidates.find((candidate) => candidate.object_id === "memory-low-confidence");

    expect(high).toBeDefined();
    expect(low).toBeDefined();
    expect(high?.score_factors?.confidence).toBeCloseTo(0.95);
    expect(low?.score_factors?.confidence).toBeCloseTo(0.2);
    expect(high?.relevance_score ?? 0).toBeGreaterThan(low?.relevance_score ?? 0);
    expect(high?.relevance_score ?? -1).toBeLessThanOrEqual(1);
    expect(low?.relevance_score ?? 2).toBeGreaterThanOrEqual(0);
  });

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
