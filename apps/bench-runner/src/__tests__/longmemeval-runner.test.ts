import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KpiPayloadSchema, type KpiPayload } from "@do-soul/alaya-eval";
import { LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME } from "../longmemeval/archive-evidence.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic
} from "../longmemeval/diagnostics.js";
import { runLongMemEvalMultiturn } from "../longmemeval/multiturn.js";
import {
  buildLongMemEvalReportContextUsage,
  resolveBenchEmbeddingProviderLabel,
  resolveLongMemEvalSeedObjectKind,
  runLongMemEval,
  runLongMemEvalRecallCycle,
  scoreLongMemEvalRecallHits
} from "../longmemeval/runner.js";
import type { LongMemEvalQuestion } from "../longmemeval/dataset.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "lme-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

function buildMockQuestion(id: string, answerSessionId: string): LongMemEvalQuestion {
  return {
    question_id: id,
    question_type: "single_session",
    question: `What did the user say about topic ${id}?`,
    answer: `The answer for ${id}`,
    question_date: "2026-01-01",
    haystack_session_ids: [answerSessionId, "decoy-session"],
    haystack_dates: ["2025-12-01", "2025-11-01"],
    haystack_sessions: [
      [
        { role: "user", content: `The correct fact about ${id} is stored here.`, has_answer: true },
        { role: "assistant", content: "Acknowledged." }
      ],
      [
        { role: "user", content: "Unrelated conversation about cooking pasta." }
      ]
    ],
    answer_session_ids: [answerSessionId]
  };
}

function buildLongMemEvalArchivePayload(
  overrides: Partial<KpiPayload> = {}
): KpiPayload {
  return {
    bench_name: "public",
    split: "longmemeval-oracle",
    run_at: "2026-05-14T10:00:00.000Z",
    alaya_commit: "abc1234",
    alaya_version: "0.3.10-test",
    embedding_provider: "none",
    chat_provider: "none",
    policy_shape: "chat",
    simulate_report: "none",
    dataset: {
      name: "longmemeval_oracle",
      size: 2,
      source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned"
    },
    sample_size: 2,
    evaluated_count: 2,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: 0,
      r_at_5: 0.5,
      r_at_10: 0.5,
      latency_ms_p50: 10,
      latency_ms_p95: 20,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: 0,
      tier_distribution: { hot: 0, warm: 1, cold: 1 },
      degradation_reasons: {
        none: 2,
        warm_cascade_engaged: 0,
        cold_cascade_engaged: 0,
        recall_explainability_partial: 0
      },
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      per_scenario: [
        { id: "q001", version: 1, hit_at_5: false, tier: "cold" },
        { id: "q002", version: 1, hit_at_5: true, tier: "warm" }
      ]
    },
    ...overrides
  };
}

function buildRecallResult(deliveryId: string, objectIds: readonly string[]) {
  return {
    delivery_id: deliveryId,
    results: objectIds.map((objectId, index) => ({
      object_id: objectId,
      object_kind: "memory_entry",
      relevance_score: 0.9 - index * 0.1,
      content_preview: objectId,
      evidence_pointers: [objectId],
      selection_reason: "test",
      source_channels: [],
      score_factors: { relevance: 0.9 - index * 0.1 },
      budget_state: {
        token_estimate: 1,
        max_entries: 10,
        max_total_tokens: 2000,
        remaining_entries: 9 - index,
        remaining_tokens: 1999 - index,
        within_budget: true
      }
    })),
    total_count: objectIds.length,
    strategy_mix: {
      deterministic_match: true,
      precomputed_rank: true,
      semantic_supplement: false,
      graph_support: false,
      path_plasticity: false,
      global_recall: false
    },
    degradation_reason: null
  };
}

describe("LongMemEval runner", () => {
  it("normalizes optional recall diagnostics without requiring protocol schema changes", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-diagnostics",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [{ object_id: "memory-decoy", rank: 1, relevance_score: 0.9 }],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "env",
      recallResult: {
        diagnostics: {
          provider_state: "provider_returned",
          candidate_pool: [
            {
              object_id: "memory-gold",
              rank: 4,
              pre_budget_rank: 3,
              fused_rank: 2,
              fused_score: 0.25,
              per_stream_rank: {
                lexical_fts: 3,
                evidence_fts: null,
                evidence_structural_agreement: null,
                source_proximity: null,
                structural: 1,
                existing_score: 2,
                embedding_similarity: null,
                graph_expansion: null,
                path_expansion: null,
                temporal_recency: null,
                workspace_activation: 4
              },
              fused_rank_contribution_per_stream: {
                lexical_fts: 0.01,
                evidence_fts: 0,
                evidence_structural_agreement: 0,
                source_proximity: 0,
                structural: 0.02,
                existing_score: 0.015,
                embedding_similarity: 0,
                graph_expansion: 0,
                path_expansion: 0,
                temporal_recency: 0,
                workspace_activation: 0.008
              },
              plane_first_admitted: "domain_tag_cluster",
              plane_winning_admission: "domain_tag_cluster",
              source_planes: ["domain_tag_cluster", "openai_api_key"],
              lexical_rank: 0.42,
              structural_score: 0.88,
              source_channels: [
                "domain_tag_cluster",
                "plane:domain_tag_cluster",
                "sk-live-secret",
                "sk_live_secret",
                "openai_api_key",
                "raw_memory_content"
              ],
              budget_drop_reason: "delivery_budget"
            }
          ]
        }
      }
    });

    expect(row.recall_diagnostics_present).toBe(true);
    expect(row.provider_state).toBe("provider_returned");
    expect(row.miss_classification).toBe("budget_dropped");
    expect(row.gold[0]).toMatchObject({
      object_id: "memory-gold",
      candidate_status: "candidate_not_delivered",
      final_rank: null,
      pre_budget_rank: 3,
      fused_rank: 2,
      fused_score: 0.25,
      per_stream_rank: {
        lexical_fts: 3,
        evidence_fts: null,
        evidence_structural_agreement: null,
        source_proximity: null,
        structural: 1,
        existing_score: 2,
        embedding_similarity: null,
        graph_expansion: null,
        path_expansion: null,
        temporal_recency: null,
        workspace_activation: 4
      },
      fused_rank_contribution_per_stream: {
        lexical_fts: 0.01,
        evidence_fts: 0,
        evidence_structural_agreement: 0,
        source_proximity: 0,
        structural: 0.02,
        existing_score: 0.015,
        embedding_similarity: 0,
        graph_expansion: 0,
        path_expansion: 0,
        temporal_recency: 0,
        workspace_activation: 0.008
      },
      plane_first_admitted: "domain_tag_cluster",
      lexical_rank: 0.42,
      structural_score: 0.88,
      source_channels: ["domain_tag_cluster", "plane:domain_tag_cluster"],
      budget_drop_reason: "delivery_budget"
    });
    expect(JSON.stringify(row)).not.toContain("sk-live-secret");
    expect(JSON.stringify(row)).not.toContain("sk_live_secret");
    expect(JSON.stringify(row)).not.toContain("openai_api_key");
    expect(JSON.stringify(row)).not.toContain("raw_memory_content");
  });

  it("keeps budget-drop reason counts separate from question miss classes", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-two-gold-budget-dropped",
      goldMemoryIds: ["memory-gold-a", "memory-gold-b"],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: [
            {
              object_id: "memory-gold-a",
              final_rank: null,
              pre_budget_rank: 6,
              budget_drop_reason: "max_entries"
            },
            {
              object_id: "memory-gold-b",
              final_rank: null,
              pre_budget_rank: 7,
              budget_drop_reason: "max_entries"
            }
          ]
        }
      }
    });

    const metrics = buildLongMemEvalQualityMetrics([row]);
    expect(metrics.miss_distribution.budget_dropped).toBe(1);
    expect(metrics.budget_drop_distribution.max_entries).toEqual({
      count: 2,
      share: 1,
      denominator: 2
    });
  });

  it("classifies post-budget candidates outside the delivery window as under-ranked", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-budget-reason-outside-window",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: [
            {
              object_id: "memory-gold",
              final_rank: null,
              pre_budget_rank: 16,
              fused_rank: 16,
              budget_drop_reason: "max_entries"
            }
          ]
        }
      }
    });

    const metrics = buildLongMemEvalQualityMetrics([row]);
    expect(row.miss_classification).toBe("under_ranked");
    expect(metrics.miss_distribution.budget_dropped ?? 0).toBe(0);
    expect(metrics.budget_drop_distribution.max_entries).toEqual({
      count: 0,
      share: 0,
      denominator: 1
    });
  });

  it("uses fused rank order for non-monotonic diagnostics when fusion metadata exists", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-fused-rank-order",
      goldMemoryIds: ["memory-a"],
      answerSessionIds: ["session-a"],
      deliveredResults: [
        { object_id: "memory-a", rank: 1, relevance_score: 0.1 },
        { object_id: "memory-b", rank: 2, relevance_score: 0.9 }
      ],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: [
            {
              object_id: "memory-a",
              final_rank: 1,
              fused_rank: 1
            },
            {
              object_id: "memory-b",
              final_rank: 2,
              fused_rank: 2
            }
          ]
        }
      }
    });

    const metrics = buildLongMemEvalQualityMetrics([row]);
    expect(metrics.non_monotonic_count).toBe(0);
    expect(metrics.non_monotonic_rate).toBe(0);
  });

  it("keeps delivered_results plane attribution for cohort diagnostics consumers", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-delivered-plane-attribution",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [
        {
          object_id: "memory-gold",
          rank: 1,
          relevance_score: 0.91,
          plane_first_admitted: "activation",
          plane_winning_admission: "protected_winner"
        },
        { object_id: "memory-fallback", rank: 2, relevance_score: 0.72 }
      ],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "env",
      recallResult: {
        diagnostics: {
          provider_state: "provider_returned",
          candidate_pool: [
            {
              object_id: "memory-fallback",
              plane_first_admitted: "lexical",
              plane_winning_admission: "lexical",
              source_planes: ["lexical"]
            }
          ]
        }
      }
    });

    expect(row.delivered_results).toEqual([
      {
        object_id: "memory-gold",
        rank: 1,
        relevance_score: 0.91,
        fused_rank: null,
        fused_score: null,
        per_stream_rank: null,
        fused_rank_contribution_per_stream: null,
        plane_first_admitted: "activation",
        plane_winning_admission: "protected_winner",
        score_factors: null
      },
      {
        object_id: "memory-fallback",
        rank: 2,
        relevance_score: 0.72,
        fused_rank: null,
        fused_score: null,
        per_stream_rank: null,
        fused_rank_contribution_per_stream: null,
        plane_first_admitted: "lexical",
        plane_winning_admission: "lexical",
        score_factors: null
      }
    ]);
  });

  it("computes evidence and path stream quality metrics from recall diagnostics", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-native-streams",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [
        {
          object_id: "memory-gold",
          rank: 1,
          relevance_score: 0.91,
          plane_first_admitted: "evidence_anchor",
          plane_winning_admission: "path_expansion"
        }
      ],
      hitAt1: true,
      hitAt5: true,
      hitAt10: true,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: [
            {
              object_id: "memory-gold",
              final_rank: 1,
              pre_budget_rank: 1,
              fused_rank: 1,
              per_stream_rank: {
                evidence_fts: 1,
                evidence_structural_agreement: null,
                path_expansion: 2
              },
              plane_first_admitted: "evidence_anchor",
              plane_winning_admission: "path_expansion",
              source_planes: ["evidence_anchor", "path_expansion"],
              source_channels: ["evidence_fts", "path_expansion"]
            }
          ]
        }
      }
    });

    const metrics = buildLongMemEvalQualityMetrics([row]);
    expect(metrics.evidence_stream_gold_delivery_count).toBe(1);
    expect(metrics.evidence_stream_gold_delivery_rate).toBe(1);
    expect(metrics.path_stream_top10_count).toBe(1);
    expect(metrics.path_stream_top10_rate).toBe(1);
  });

  it("scores LongMemEval R@K from ranked results only, not active constraints", () => {
    const sidecar = new Map([
      ["gold-constraint", { sessionId: "session-a", hasAnswer: true }],
      ["decoy-top", { sessionId: "session-b", hasAnswer: false }]
    ]);
    const scoring = scoreLongMemEvalRecallHits({
      results: [{ object_id: "decoy-top", relevance_score: 0.91 }],
      sidecar,
      answerSessionIds: new Set(["session-a"])
    });
    const row = buildQuestionDiagnostic({
      questionId: "q-active-constraint-only",
      goldMemoryIds: ["gold-constraint"],
      answerSessionIds: ["session-a"],
      deliveredResults: [
        {
          object_id: "decoy-top",
          rank: 1,
          relevance_score: 0.91
        }
      ],
      activeConstraintResults: [{ object_id: "gold-constraint", rank: 1 }],
      hitAt1: scoring.hitAt1,
      hitAt5: scoring.hitAt5,
      hitAt10: scoring.hitAt10,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: []
        }
      }
    });

    expect(scoring).toMatchObject({
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      firstTier: "hot"
    });
    expect(row.hit_at_5).toBe(false);
    expect(row.hit_at_10).toBe(false);
    expect(row.miss_classification).toBe("active_constraint_only");
    expect(row.gold[0]).toMatchObject({
      object_id: "gold-constraint",
      candidate_status: "active_constraint_delivered",
      final_rank: null,
      active_constraint_rank: 1
    });
  });

  it("keeps LongMemEval gate seeding label-independent", () => {
    expect(resolveLongMemEvalSeedObjectKind({ seedIndex: 0 })).toBe("fact");
    expect(resolveLongMemEvalSeedObjectKind({ seedIndex: 3 })).toBe("fact");
  });

  it("classifies empty-gold rows separately from candidate absence", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-no-gold",
      goldMemoryIds: [],
      answerSessionIds: ["session-no-answer"],
      deliveredResults: [
        {
          object_id: "decoy",
          rank: 1,
          relevance_score: 0.9
        }
      ],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: []
        }
      }
    });

    expect(row.miss_classification).toBe("no_gold");
    const metrics = buildLongMemEvalQualityMetrics([row]);
    expect(metrics.no_gold_count).toBe(1);
    expect(metrics.candidate_absent_count).toBe(0);
    expect(metrics.miss_distribution).toMatchObject({ no_gold: 1 });
  });

  it("redacts arbitrary provider degradation text from diagnostics sidecars", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-secret-provider-text",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "env",
      recallResult: {
        diagnostics: {
          provider: {
            state: "provider_failed",
            degradation_reason: "sk-live-secret file:/home/me/.config/alaya/secrets/openai"
          },
          candidates: []
        }
      }
    });

    expect(row.provider_state).toBe("provider_failed");
    expect(row.provider_degradation_reason).toBeNull();
    expect(JSON.stringify(row)).not.toContain("sk-live-secret");
    expect(JSON.stringify(row)).not.toContain("/home/me/.config/alaya/secrets/openai");
  });

  it("preserves allowlisted provider degradation reasons in diagnostics sidecars", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-provider-pending",
      goldMemoryIds: ["memory-gold"],
      answerSessionIds: ["session-a"],
      deliveredResults: [],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "env",
      recallResult: {
        diagnostics: {
          embedding_provider_status: "provider_pending",
          provider_degradation_reason: "query_embedding_pending",
          candidates: []
        }
      }
    });

    expect(row.provider_state).toBe("provider_pending");
    expect(row.provider_degradation_reason).toBe("query_embedding_pending");
  });

  it("labels env embedding benchmarks with provider and model metadata", () => {
    expect(
      resolveBenchEmbeddingProviderLabel("env", {
        OPENAI_EMBEDDING_PROVIDER_URL: "https://api.yunwu.example/v1",
        OPENAI_EMBEDDING_MODEL: "text-embedding-3-large"
      })
    ).toBe("yunwu:text-embedding-3-large");
    expect(
      resolveBenchEmbeddingProviderLabel("env", {
        OPENAI_EMBEDDING_PROVIDER_URL: "https://embedding-proxy.example/v1",
        OPENAI_EMBEDDING_MODEL: "custom-embed"
      })
    ).toBe("openai-compatible:custom-embed");
    expect(resolveBenchEmbeddingProviderLabel("env", {})).toBe(
      "openai:text-embedding-3-small"
    );
    expect(resolveBenchEmbeddingProviderLabel("disabled", {})).toBe("none");
  });

  it("builds simulate-report usage from delivered results only", () => {
    const delivered = [
      { object_id: "decoy-top", relevance_score: 0.9 },
      { object_id: "gold-delivered", relevance_score: 0.8 },
      { object_id: "decoy-tail", relevance_score: 0.7 }
    ];

    expect(
      buildLongMemEvalReportContextUsage({
        simulateReport: "none",
        deliveryId: "delivery-1",
        results: delivered,
        goldMemoryIds: ["gold-delivered"],
        turnIndex: 3,
        questionText: "Which memory was used?"
      }).reportInput
    ).toBeNull();

    const goldOnly = buildLongMemEvalReportContextUsage({
      simulateReport: "gold-only",
      deliveryId: "delivery-2",
      results: delivered,
      goldMemoryIds: ["gold-delivered", "gold-not-delivered"],
      turnIndex: 3,
      questionText: "Which memory was used?"
    });
    expect(goldOnly.reportInput?.usageState).toBe("used");
    expect(goldOnly.reportInput?.usedObjectIds).toEqual(["gold-delivered"]);
    expect(goldOnly.reportInput?.deliveredObjects).toEqual([
      { objectId: "decoy-top", usageStatus: "skipped" },
      { objectId: "gold-delivered", usageStatus: "used" },
      { objectId: "decoy-tail", usageStatus: "skipped" }
    ]);

    const mixedFallback = buildLongMemEvalReportContextUsage({
      simulateReport: "mixed",
      deliveryId: "delivery-3",
      results: delivered,
      goldMemoryIds: ["gold-not-delivered"],
      turnIndex: 4,
      questionText: "Which fallback was used?"
    });
    expect(mixedFallback.reportInput?.usageState).toBe("used");
    expect(mixedFallback.reportInput?.usedObjectIds).toEqual(["decoy-top"]);

    const skippedGoldOnly = buildLongMemEvalReportContextUsage({
      simulateReport: "gold-only",
      deliveryId: "delivery-4",
      results: delivered,
      goldMemoryIds: ["gold-not-delivered"],
      turnIndex: 5,
      questionText: "Was gold delivered?"
    });
    expect(skippedGoldOnly.reportInput?.usageState).toBe("skipped");
    expect(skippedGoldOnly.reportInput?.usedObjectIds).toBeUndefined();
    expect(skippedGoldOnly.reportInput?.deliveredObjects?.every(
      (item) => item.usageStatus === "skipped"
    )).toBe(true);

    const alwaysUsedEmpty = buildLongMemEvalReportContextUsage({
      simulateReport: "always-used",
      deliveryId: "delivery-5",
      results: [],
      goldMemoryIds: ["gold-not-delivered"],
      turnIndex: 6,
      questionText: "No results?"
    });
    expect(alwaysUsedEmpty.reportInput?.usageState).toBe("skipped");
    expect(alwaysUsedEmpty.reportInput?.deliveredObjects).toEqual([]);
    expect(alwaysUsedEmpty.stats).toEqual({
      reportsAttempted: 1,
      reportsUsed: 0,
      reportsSkipped: 1,
      usedObjectCount: 0
    });
  });

  it("uses a pre-report recall before the scored recall for simulate_report warm modes", async () => {
    const recall = vi
      .fn()
      .mockResolvedValueOnce(buildRecallResult("delivery-pre", ["gold", "decoy"]))
      .mockResolvedValueOnce(buildRecallResult("delivery-scored", ["decoy", "gold"]));
    const reportContextUsage = vi.fn().mockResolvedValue(undefined);

    const result = await runLongMemEvalRecallCycle({
      daemon: { recall, reportContextUsage },
      query: "Which memory was used?",
      recallOptions: { maxResults: 10, conflictAwareness: true },
      simulateReport: "mixed",
      goldMemoryIds: ["gold"],
      turnIndex: 7,
      questionText: "Which memory was used?"
    });

    expect(recall).toHaveBeenCalledTimes(2);
    expect(reportContextUsage).toHaveBeenCalledTimes(1);
    expect(reportContextUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: "delivery-pre",
        usedObjectIds: ["gold", "decoy"]
      })
    );
    expect(result.scoredRecallResult.delivery_id).toBe("delivery-scored");
    expect(result.scoredRecallResult.results[0]?.object_id).toBe("decoy");
    expect(result.reportUsageStats).toMatchObject({
      reportsAttempted: 1,
      reportsUsed: 1,
      usedObjectCount: 2
    });
  });

  it("keeps simulate_report=none as a single scored recall", async () => {
    const recall = vi
      .fn()
      .mockResolvedValueOnce(buildRecallResult("delivery-scored", ["gold"]));
    const reportContextUsage = vi.fn().mockResolvedValue(undefined);

    const result = await runLongMemEvalRecallCycle({
      daemon: { recall, reportContextUsage },
      query: "Which memory was used?",
      recallOptions: { maxResults: 10, conflictAwareness: true },
      simulateReport: "none",
      goldMemoryIds: ["gold"],
      turnIndex: 8,
      questionText: "Which memory was used?"
    });

    expect(recall).toHaveBeenCalledTimes(1);
    expect(reportContextUsage).not.toHaveBeenCalled();
    expect(result.scoredRecallResult.delivery_id).toBe("delivery-scored");
    expect(result.reportUsageStats.reportsAttempted).toBe(0);
  });

  it(
    "runs 2-question mock dataset through the real MCP propose+review chain and produces a valid kpi.json with mcp_propose_review harness_mode",
    async () => {
      const dataDir = join(tmpDir, "longmemeval");
      await mkdir(dataDir, { recursive: true });
      const historyRoot = join(tmpDir, "history");

      const mockQuestions: LongMemEvalQuestion[] = [
        buildMockQuestion("q001", "session-a"),
        buildMockQuestion("q002", "session-b")
      ];

      const variant = "longmemeval_oracle";
      const datasetRaw = JSON.stringify(mockQuestions);
      const datasetSha = createHash("sha256").update(datasetRaw, "utf8").digest("hex");
      await writeFile(join(dataDir, `${variant}.json`), datasetRaw, "utf8");
      await writeFile(
        join(dataDir, `${variant}.meta.json`),
        JSON.stringify({ variant, sha256: datasetSha, questionCount: 2 }),
        "utf8"
      );

      // Pinned meta lookup root for the loadDataset checksum guard.
      const pinnedMetaRoot = join(tmpDir, "pinned-meta");
      await mkdir(pinnedMetaRoot, { recursive: true });
      await writeFile(
        join(pinnedMetaRoot, `${variant}.meta.json`),
        JSON.stringify({
          name: variant,
          sha256: datasetSha,
          question_count: 2,
          first_pinned_at: "2026-05-14T00:00:00Z",
          pinned_by_commit: "test"
        }),
        "utf8"
      );

      const priorColdSlug = "2026-05-14T100000Z-abc1234-policy-chat";
      const priorColdRoot = join(historyRoot, "public", priorColdSlug);
      await mkdir(priorColdRoot, { recursive: true });
      await writeFile(
        join(priorColdRoot, "kpi.json"),
        JSON.stringify(
          buildLongMemEvalArchivePayload({
            run_at: "2026-05-14T10:00:00.000Z",
            policy_shape: "chat",
            simulate_report: "none"
          }),
          null,
          2
        ) + "\n",
        "utf8"
      );
      await writeFile(join(priorColdRoot, "report.md"), "cold report\n", "utf8");
      const priorColdEnvSlug = "2026-05-14T110000Z-def5678-policy-chat";
      const priorColdEnvRoot = join(historyRoot, "public", priorColdEnvSlug);
      await mkdir(priorColdEnvRoot, { recursive: true });
      const priorColdEnvPayload = buildLongMemEvalArchivePayload({
        run_at: "2026-05-14T11:00:00.000Z",
        alaya_commit: "def5678",
        embedding_provider: "yunwu:text-embedding-3-small",
        policy_shape: "chat",
        simulate_report: "none"
      });
      await writeFile(
        join(priorColdEnvRoot, "kpi.json"),
        JSON.stringify(
          {
            ...priorColdEnvPayload,
            kpi: {
              ...priorColdEnvPayload.kpi,
              r_at_5: 0.9
            }
          },
          null,
          2
        ) + "\n",
        "utf8"
      );
      await writeFile(join(priorColdEnvRoot, "report.md"), "cold env report\n", "utf8");

      const weightOverridesJson = JSON.stringify({
        activation_weights_phase4b: {
          scope_match: 0.08,
          relevance: 0.2
        },
        additive: {
          CONFIDENCE_DIRECT_WEIGHT: 0.1
        },
        fusion_weights: {
          lexical_fts: 0.5
        }
      });

      const result = await runLongMemEval({
        variant,
        limit: 2,
        historyRoot,
        dataDir,
        pinnedMetaRoot,
        policyShape: "chat",
        simulateReport: "mixed",
        weightOverridesJson
      });

      // Slug format must match SLUG_PATTERN
      expect(result.slug).toMatch(
        /^\d{4}-\d{2}-\d{2}T\d{6}Z-[0-9a-f]{7,40}-policy-chat-report-mixed$/
      );

      // harness_mode must reflect the real MCP chain, never direct_db_seed.
      expect(result.payload.harness_mode).toBe("mcp_propose_review");
      expect(result.payload.recall_pipeline_version).toBe("fusion-rrf-v1");
      expect(result.payload.embedding_provider).toBe("none");
      expect(result.payload.policy_shape).toBe("chat");
      expect(result.payload.simulate_report).toBe("mixed");
      expect(result.payload.seed_policy).toMatchObject({
        mode: "label_independent_all_fact",
        label_independent: true,
        object_kind: "fact"
      });
      expect(result.payload.seed_policy?.description).not.toMatch(/\bK\d\b/);
      expect(result.payload.recall_weight_overrides).toMatchObject({
        source: "cli",
        activation_weights_phase4b: {
          scope_match: 0.08,
          relevance: 0.2
        },
        additive: {
          CONFIDENCE_DIRECT_WEIGHT: 0.1
        },
        fusion_weights: {
          lexical_fts: 0.5
        }
      });

      // KPI payload must pass schema validation
      const parseResult = KpiPayloadSchema.safeParse(result.payload);
      expect(parseResult.success).toBe(true);
      expect(await readFile(result.reportPath, "utf8")).toContain("Recall weights: source=cli");
      expect(await readFile(result.reportPath, "utf8")).toContain(
        "Recall pipeline: fusion-rrf-v1"
      );
      expect(await readFile(result.reportPath, "utf8")).toContain(
        "Seed policy: label_independent_all_fact (label-independent)"
      );

      // Structural assertions
      expect(result.payload.bench_name).toBe("public");
      // Variant=longmemeval_oracle → split=longmemeval-oracle (split now
      // tracks variant; Oracle and S are archived under distinct splits
      // because their session-set filter semantics differ).
      expect(result.payload.split).toBe("longmemeval-oracle");
      expect(result.payload.kpi.per_scenario).toHaveLength(2);
      expect(result.payload.kpi.per_scenario[0]?.id).toBe("q001");
      expect(result.payload.kpi.per_scenario[1]?.id).toBe("q002");
      expect(result.diagnosticsPath).not.toBeNull();
      const diagnostics = JSON.parse(
        await readFile(result.diagnosticsPath!, "utf8")
      ) as {
        schema_version: number;
        recall_pipeline_version: string;
        policy_shape: string;
        simulate_report: string;
        report_usage: {
          mode: string;
          reports_attempted: number;
          reports_used: number;
          reports_skipped: number;
          used_object_count: number;
        };
        provider_state_summary: {
          provider_not_requested: number;
          provider_returned_rate: number;
        };
        report_side_effects: {
          recalls_edge_count: number;
          memory_graph_edges_by_type: Record<string, number>;
          path_relations_total: number;
          snapshots: Array<{
            memory_graph_edges_by_type: Record<string, number>;
          }>;
        };
        scored_recall_evidence: {
          delivered_result_count: number;
          graph_support_gold_count: number;
          path_plasticity_gold_count: number;
          graph_expansion_plane_count: number;
          path_expansion_plane_count: number;
        };
        questions: Array<{
          question_id: string;
          gold_memory_ids: string[];
          recall_diagnostics_present: boolean;
          recall_diagnostics_keys: string[];
        }>;
      };
      expect(diagnostics.schema_version).toBe(1);
      expect(diagnostics.recall_pipeline_version).toBe("fusion-rrf-v1");
      expect(diagnostics.policy_shape).toBe("chat");
      expect(diagnostics.simulate_report).toBe("mixed");
      expect(diagnostics.report_usage.mode).toBe("mixed");
      expect(diagnostics.report_usage.reports_attempted).toBe(2);
      expect(
        diagnostics.report_usage.reports_used + diagnostics.report_usage.reports_skipped
      ).toBe(2);
      expect(diagnostics.report_usage.used_object_count).toBeGreaterThanOrEqual(0);
      expect(diagnostics.provider_state_summary.provider_not_requested).toBe(2);
      expect(diagnostics.provider_state_summary.provider_returned_rate).toBe(0);
      expect(diagnostics.report_side_effects.recalls_edge_count).toBeGreaterThanOrEqual(0);
      expect(diagnostics.report_side_effects.memory_graph_edges_by_type).toHaveProperty("recalls");
      expect(diagnostics.report_side_effects.path_relations_total).toBeGreaterThanOrEqual(0);
      expect(diagnostics.report_side_effects.snapshots).toHaveLength(2);
      expect(diagnostics.scored_recall_evidence.delivered_result_count).toBeGreaterThan(0);
      expect(diagnostics.scored_recall_evidence.graph_support_gold_count).toBeGreaterThanOrEqual(0);
      expect(diagnostics.scored_recall_evidence.path_plasticity_gold_count).toBeGreaterThanOrEqual(0);
      expect(diagnostics.scored_recall_evidence.path_expansion_plane_count).toBeGreaterThanOrEqual(0);
      expect(diagnostics.questions).toHaveLength(2);
      expect(diagnostics.questions[0]?.question_id).toBe("q001");
      expect(diagnostics.questions[0]?.gold_memory_ids.length).toBeGreaterThan(0);
      expect(diagnostics.questions[0]?.recall_diagnostics_present).toBe(true);
      expect(diagnostics.questions[0]?.recall_diagnostics_keys).toContain("candidates");
      expect(JSON.stringify(diagnostics)).not.toContain("correct fact");
      const comparison = JSON.parse(
        await readFile(
          join(dirname(result.kpiPath), LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME),
          "utf8"
        )
      ) as {
        current: { simulate_report: string; r_at_5: number };
        opposite: { simulate_report: string; r_at_5: number } | null;
        delta_current_minus_opposite: {
          r_at_5: number;
          report_side_effects: { recalls_edge_count: number | null };
          scored_recall_evidence: { path_expansion_plane_count: number | null };
        } | null;
      };
      expect(comparison.current.simulate_report).toBe("mixed");
      expect(comparison.opposite?.simulate_report).toBe("none");
      expect(comparison.opposite?.r_at_5).toBe(0.5);
      expect(comparison.delta_current_minus_opposite?.r_at_5).toBeCloseTo(
        result.payload.kpi.r_at_5 - 0.5
      );
      expect(
        comparison.delta_current_minus_opposite?.report_side_effects.recalls_edge_count
      ).toBeNull();
      expect(
        comparison.delta_current_minus_opposite?.scored_recall_evidence.path_expansion_plane_count
      ).toBeNull();

      // All rate values are in [0, 1]
      const kpi = result.payload.kpi;
      expect(kpi.r_at_1).toBeGreaterThanOrEqual(0);
      expect(kpi.r_at_1).toBeLessThanOrEqual(1);
      expect(kpi.r_at_5).toBeGreaterThanOrEqual(0);
      expect(kpi.r_at_5).toBeLessThanOrEqual(1);
      expect(kpi.r_at_10).toBeGreaterThanOrEqual(0);
      expect(kpi.r_at_10).toBeLessThanOrEqual(1);

      // Degradation reasons sum to the number of evaluated questions;
      // the values come from the daemon's recall response, not seed counts.
      const degradeTotal =
        kpi.degradation_reasons.none +
        kpi.degradation_reasons.warm_cascade_engaged +
        kpi.degradation_reasons.cold_cascade_engaged +
        kpi.degradation_reasons.recall_explainability_partial;
      expect(degradeTotal).toBe(2);

      // eslint-disable-next-line no-console
      console.log(
        `[longmemeval mock harness] r_at_1=${kpi.r_at_1} r_at_5=${kpi.r_at_5} r_at_10=${kpi.r_at_10} tier_hot=${kpi.tier_distribution.hot} tier_warm=${kpi.tier_distribution.warm} tier_cold=${kpi.tier_distribution.cold} degrade_none=${kpi.degradation_reasons.none} degrade_warm=${kpi.degradation_reasons.warm_cascade_engaged} degrade_cold=${kpi.degradation_reasons.cold_cascade_engaged}`
      );
    },
    180_000
  );

  it(
    "archives public-multiturn runs with round KPIs and diagnostics sidecar",
    async () => {
      const dataDir = join(tmpDir, "longmemeval-multiturn");
      await mkdir(dataDir, { recursive: true });
      const historyRoot = join(tmpDir, "history-multiturn");

      const mockQuestions: LongMemEvalQuestion[] = [
        buildMockQuestion("qmt001", "session-a")
      ];
      const variant = "longmemeval_s";
      const datasetRaw = JSON.stringify(mockQuestions);
      const datasetSha = createHash("sha256").update(datasetRaw, "utf8").digest("hex");
      await writeFile(join(dataDir, `${variant}.json`), datasetRaw, "utf8");
      await writeFile(
        join(dataDir, `${variant}.meta.json`),
        JSON.stringify({ variant, sha256: datasetSha, questionCount: 1 }),
        "utf8"
      );
      const pinnedMetaRoot = join(tmpDir, "pinned-meta-multiturn");
      await mkdir(pinnedMetaRoot, { recursive: true });
      await writeFile(
        join(pinnedMetaRoot, `${variant}.meta.json`),
        JSON.stringify({
          name: variant,
          sha256: datasetSha,
          question_count: 1,
          first_pinned_at: "2026-05-15T00:00:00Z",
          pinned_by_commit: "test"
        }),
        "utf8"
      );

      const result = await runLongMemEvalMultiturn({
        variant,
        limit: 1,
        rounds: 2,
        historyRoot,
        dataDir,
        pinnedMetaRoot
      });

      expect(result.payload.bench_name).toBe("public-multiturn");
      expect(result.payload.kpi.multiturn_rounds).toBe(2);
      expect(result.payload.kpi.r_at_5_round_1).toBeGreaterThanOrEqual(0);
      expect(result.payload.kpi.r_at_5_round_n).toBe(result.payload.kpi.r_at_5);
      expect(result.diagnosticsPath).not.toBeNull();
      const diagnostics = JSON.parse(
        await readFile(result.diagnosticsPath!, "utf8")
      ) as { bench_name: string; questions: Array<{ round_index: number | null }> };
      expect(diagnostics.bench_name).toBe("public-multiturn");
      expect(diagnostics.questions.map((row) => row.round_index)).toEqual([1, 2]);
    },
    180_000
  );
});
