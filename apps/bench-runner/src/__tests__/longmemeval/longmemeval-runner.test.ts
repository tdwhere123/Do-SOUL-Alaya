import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { KpiPayloadSchema, type KpiPayload } from "@do-soul/alaya-eval";
import { LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME } from "../../longmemeval/archive-evidence.js";
import {
  buildLongMemEvalQualityMetrics,
  buildQuestionDiagnostic
} from "../../longmemeval/diagnostics.js";
import { runLongMemEvalMultiturn } from "../../longmemeval/multiturn.js";
import { runLongMemEvalCrossQuestion } from "../../longmemeval/crossquestion.js";
import {
  buildLongMemEvalSidecarKey,
  buildLongMemEvalReportContextUsage,
  deriveLongMemEvalGoldMemoryIds,
  resolveBenchEmbeddingProviderLabel,
  runLongMemEval,
  runLongMemEvalRecallCycle,
  scoreLongMemEvalRecallHits
} from "../../longmemeval/runner.js";
import { buildRecallResult } from "./longmemeval-runner-fixture.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "lme-test-"));
  // These runs take the no-credentials offline seed path; the model value is
  // never used for a live call. Each run below passes an isolated
  // extractionCacheRoot (no manifest -> first-ever-build preflight), so this
  // model is arbitrary and the tests are decoupled from the production
  // extraction-cache manifest's model.
  vi.stubEnv("OFFICIAL_API_GARDEN_MODEL", "test-extraction-model");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(tmpDir, { recursive: true, force: true });
});

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
                synthesis_fts: null,
                evidence_fts: null,
                evidence_structural_agreement: null,
                source_proximity: null,
                source_evidence_agreement: null,
                subject_alignment: null,
                structural: 1,
                existing_score: 2,
                embedding_similarity: null,
                graph_expansion: null,
                entity_seed: null,
                path_expansion: null,
                temporal_recency: null,
                workspace_activation: 4
              },
              fused_rank_contribution_per_stream: {
                lexical_fts: 0.01,
                synthesis_fts: 0,
                evidence_fts: 0,
                evidence_structural_agreement: 0,
                source_proximity: 0,
                source_evidence_agreement: 0,
                subject_alignment: 0,
                structural: 0.02,
                existing_score: 0.015,
                embedding_similarity: 0,
                graph_expansion: 0,
                entity_seed: 0,
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
        synthesis_fts: null,
        evidence_fts: null,
        evidence_structural_agreement: null,
        source_proximity: null,
        source_evidence_agreement: null,
        subject_alignment: null,
        structural: 1,
        existing_score: 2,
        embedding_similarity: null,
        graph_expansion: null,
        entity_seed: null,
        path_expansion: null,
        temporal_recency: null,
        workspace_activation: 4
      },
      fused_rank_contribution_per_stream: {
        lexical_fts: 0.01,
        synthesis_fts: 0,
        evidence_fts: 0,
        evidence_structural_agreement: 0,
        source_proximity: 0,
        source_evidence_agreement: 0,
        subject_alignment: 0,
        structural: 0.02,
        existing_score: 0.015,
        embedding_similarity: 0,
        graph_expansion: 0,
        entity_seed: 0,
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

  it("does not attribute same-id synthesis diagnostics to LongMemEval memory gold", () => {
    const row = buildQuestionDiagnostic({
      questionId: "q-kind-collision",
      goldMemoryIds: ["shared-object"],
      answerSessionIds: ["session-a"],
      deliveredResults: [
        {
          object_id: "shared-object",
          object_kind: "synthesis_capsule",
          rank: 1,
          relevance_score: 0.99
        }
      ],
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      degradationReason: null,
      embeddingMode: "disabled",
      recallResult: {
        diagnostics: {
          candidate_pool: [
            {
              candidate_key: "workspace_local:synthesis_capsule:shared-object",
              object_id: "shared-object",
              object_kind: "synthesis_capsule",
              final_rank: 1,
              pre_budget_rank: 1,
              fused_rank: 1,
              per_stream_rank: {
                synthesis_fts: 1,
                lexical_fts: null,
                existing_score: null
              }
            }
          ]
        }
      }
    });

    expect(row.delivered_results[0]).toMatchObject({
      object_id: "shared-object",
      object_kind: "synthesis_capsule",
      fused_rank: 1
    });
    expect(row.gold[0]).toMatchObject({
      object_id: "shared-object",
      candidate_status: "candidate_absent",
      final_rank: null,
      fused_rank: null,
      per_stream_rank: null
    });
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

  it("uses final delivered rank order for non-monotonic diagnostics", () => {
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
        dimension: null,
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
        dimension: null,
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
      [
        buildLongMemEvalSidecarKey("memory_entry", "gold-constraint"),
        {
          objectId: "gold-constraint",
          objectKind: "memory_entry" as const,
          sessionId: "session-a",
          hasAnswer: true
        }
      ],
      [
        buildLongMemEvalSidecarKey("memory_entry", "decoy-top"),
        {
          objectId: "decoy-top",
          objectKind: "memory_entry" as const,
          sessionId: "session-b",
          hasAnswer: false
        }
      ]
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

  it("does not count same-id synthesis_capsule results as LongMemEval memory gold hits", () => {
    const sidecar = new Map([
      [
        buildLongMemEvalSidecarKey("memory_entry", "shared-object"),
        {
          objectId: "shared-object",
          objectKind: "memory_entry" as const,
          sessionId: "session-a",
          hasAnswer: true
        }
      ]
    ]);

    const synthesisOnly = scoreLongMemEvalRecallHits({
      results: [
        {
          object_id: "shared-object",
          object_kind: "synthesis_capsule",
          relevance_score: 0.99
        }
      ],
      sidecar,
      answerSessionIds: new Set(["session-a"])
    });
    expect(synthesisOnly).toMatchObject({
      hitAt1: false,
      hitAt5: false,
      hitAt10: false,
      firstTier: "hot"
    });

    const memoryEntry = scoreLongMemEvalRecallHits({
      results: [
        {
          object_id: "shared-object",
          object_kind: "memory_entry",
          relevance_score: 0.99
        }
      ],
      sidecar,
      answerSessionIds: new Set(["session-a"])
    });
    expect(memoryEntry.hitAt1).toBe(true);
  });

  it("derives LongMemEval gold ids from memory_entry sidecar entries only", () => {
    const sidecar = new Map([
      [
        buildLongMemEvalSidecarKey("memory_entry", "shared-object"),
        {
          objectId: "shared-object",
          objectKind: "memory_entry" as const,
          sessionId: "session-a",
          hasAnswer: true
        }
      ],
      [
        buildLongMemEvalSidecarKey("synthesis_capsule", "shared-object"),
        {
          objectId: "shared-object",
          objectKind: "synthesis_capsule" as const,
          sessionId: "session-a",
          hasAnswer: true
        }
      ],
      [
        buildLongMemEvalSidecarKey("memory_entry", "decoy-object"),
        {
          objectId: "decoy-object",
          objectKind: "memory_entry" as const,
          sessionId: "session-b",
          hasAnswer: true
        }
      ]
    ]);

    expect(deriveLongMemEvalGoldMemoryIds(sidecar, new Set(["session-a"]))).toEqual([
      "shared-object"
    ]);
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
    // local_onnx is an on-device provider: labeled by the resolved local model,
    // never the OPENAI_* remote-endpoint env vars (which do not describe it).
    expect(resolveBenchEmbeddingProviderLabel("env", {}, "local_onnx")).toBe(
      "local_onnx:Xenova/paraphrase-multilingual-MiniLM-L12-v2"
    );
    expect(
      resolveBenchEmbeddingProviderLabel(
        "env",
        {
          ALAYA_LOCAL_EMBEDDING_MODEL: "Xenova/custom-model",
          OPENAI_EMBEDDING_MODEL: "ignored-for-local"
        },
        "local_onnx"
      )
    ).toBe("local_onnx:Xenova/custom-model");
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
      { objectId: "decoy-top", objectKind: "memory_entry", usageStatus: "skipped" },
      { objectId: "gold-delivered", objectKind: "memory_entry", usageStatus: "used" },
      { objectId: "decoy-tail", objectKind: "memory_entry", usageStatus: "skipped" }
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

    const synthesisCollision = buildLongMemEvalReportContextUsage({
      simulateReport: "gold-only",
      deliveryId: "delivery-synthesis-collision",
      results: [
        {
          object_id: "gold-delivered",
          object_kind: "synthesis_capsule"
        }
      ],
      goldMemoryIds: ["gold-delivered"],
      turnIndex: 4,
      questionText: "Which memory was used?"
    });
    expect(synthesisCollision.reportInput?.usageState).toBe("skipped");
    expect(synthesisCollision.reportInput?.usedObjectIds).toBeUndefined();

    const mixedSynthesisOnly = buildLongMemEvalReportContextUsage({
      simulateReport: "mixed",
      deliveryId: "delivery-mixed-synthesis",
      results: [
        {
          object_id: "shared-object",
          object_kind: "synthesis_capsule"
        }
      ],
      goldMemoryIds: ["other-gold"],
      turnIndex: 4,
      questionText: "Which fallback was used?"
    });
    expect(mixedSynthesisOnly.reportInput?.usageState).toBe("skipped");
    expect(mixedSynthesisOnly.reportInput?.usedObjectIds).toBeUndefined();

    const alwaysUsedSynthesisOnly = buildLongMemEvalReportContextUsage({
      simulateReport: "always-used",
      deliveryId: "delivery-always-synthesis",
      results: [
        {
          object_id: "shared-object",
          object_kind: "synthesis_capsule"
        }
      ],
      goldMemoryIds: ["other-gold"],
      turnIndex: 4,
      questionText: "Which fallback was used?"
    });
    expect(alwaysUsedSynthesisOnly.reportInput?.usageState).toBe("skipped");
    expect(alwaysUsedSynthesisOnly.reportInput?.usedObjectIds).toBeUndefined();

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

  // Guards KpiPayloadSchema's latency_ms* nonnegative() invariant: a
  // monotonic recall clock can never report a negative duration even when
  // recall resolves instantly. see also: packages/eval/src/schema/kpi-schema.ts.
  it.each(["none", "mixed"] as const)(
    "reports a non-negative finite scoredRecallLatencyMs for simulate_report=%s",
    async (simulateReport) => {
      const recall = vi
        .fn()
        .mockResolvedValue(buildRecallResult("delivery-scored", ["gold"]));
      const reportContextUsage = vi.fn().mockResolvedValue(undefined);

      const result = await runLongMemEvalRecallCycle({
        daemon: { recall, reportContextUsage },
        query: "Which memory was used?",
        recallOptions: { maxResults: 10, conflictAwareness: true },
        simulateReport,
        goldMemoryIds: ["gold"],
        turnIndex: 9,
        questionText: "Which memory was used?"
      });

      expect(Number.isFinite(result.scoredRecallLatencyMs)).toBe(true);
      expect(result.scoredRecallLatencyMs).toBeGreaterThanOrEqual(0);
    }
  );
});
