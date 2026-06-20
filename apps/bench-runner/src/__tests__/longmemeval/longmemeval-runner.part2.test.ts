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
});
