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
        abstention_confidence_score: null,
        dimension: null,
        fused_rank: null,
        fused_score: null,
        per_stream_rank: null,
        fused_rank_contribution_per_stream: null,
        per_axis_rank: null,
        per_axis_contribution: null,
        flood_potential: null,
        flood_fuel_coverage: null,
        plane_first_admitted: "activation",
        plane_winning_admission: "protected_winner",
        score_factors: null
      },
      {
        object_id: "memory-fallback",
        rank: 2,
        relevance_score: 0.72,
        abstention_confidence_score: null,
        dimension: null,
        fused_rank: null,
        fused_score: null,
        per_stream_rank: null,
        fused_rank_contribution_per_stream: null,
        per_axis_rank: null,
        per_axis_contribution: null,
        flood_potential: null,
        flood_fuel_coverage: null,
        plane_first_admitted: "lexical",
        plane_winning_admission: "lexical",
        score_factors: null
      }
    ]);
  });
});
