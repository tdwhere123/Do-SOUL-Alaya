import { describe, expect, it } from "vitest";
import { BankruptcyKind, DYNAMICS_CONSTANTS, MemoryDimension } from "@do-soul/alaya-protocol";
import { RecallService } from "../../recall/recall-service.js";
import { mapBudgetPenalty } from "../../recall/runtime/recall-service-helpers.js";
import { createDependencies, createMemoryEntry, createSlot, createTaskSurface, overridePolicy } from "./recall-8factor-test-fixtures.js";

import { FALSE_CONFIDENT_ACCEPTANCE_THRESHOLD } from "./recall-8factor.test-support.js";

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

// Warm-regression witness for base-weight existing_score: with identical query
  // evidence, the warmer (higher-activation) memory still ranks ahead — the prior
  // keeps its tiebreak discrimination at base weight, it is not silenced.
  it("ranks a warmer memory ahead of an identical-evidence colder twin under base-weight existing_score", async () => {
    const memories = [
      createMemoryEntry({ object_id: "cold-twin", content: "Shared evidence needle", activation_score: 0.3, confidence: 0.9 }),
      createMemoryEntry({ object_id: "warm-twin", content: "Shared evidence needle", activation_score: 1, confidence: 0.9 })
    ];
    const { dependencies, searchByKeyword } = createDependencies(
      memories,
      [],
      {},
      {
        graphSupportByMemoryId: { "cold-twin": 0, "warm-twin": 0 },
        recallsEdgeCountByMemoryId: { "cold-twin": 50, "warm-twin": 50 }
      }
    );
    searchByKeyword.mockResolvedValue([
      { object_id: "cold-twin", normalized_rank: 1 },
      { object_id: "warm-twin", normalized_rank: 1 }
    ]);
    const service = new RecallService(dependencies);
    const taskSurface = createTaskSurface("needle");
    const result = await service.recall({
      taskSurface,
      workspaceId: "workspace-1",
      runId: "run-1",
      strategy: "build"
    });
    expect(result.candidates[0]?.object_id).toBe("warm-twin");
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
});
