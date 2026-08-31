import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { collectReleaseHardGates, type KpiPayload } from "@do-soul/alaya-eval";
import {
  buildLongMemEvalFullGoldCoverage,
  buildLongMemEvalQualityMetrics
} from "../../../diagnostics/diagnostics.js";
import {
  reclassifyDiagnosticsGzipArtifact,
  reclassifyQuestionDiagnostics
} from "../../../diagnostics/miss/reclassify-question-diagnostics.js";
import {
  PLANTED_A_ID,
  PLANTED_B_ID,
  PLANTED_C_ID,
  PLANTED_D_ID,
  PLANTED_E_ID,
  PLANTED_GOLD_ID,
  plantedCanonicalQuestion
} from "./planted-canonical-fixture.js";

const ARTIFACT_RELATIVE =
  ".do-it/bench-runs/recall-any5-evidence-first/g19c-mimo-v2.5-live-prompt-785cbdcc/diagnostic-100q-core-canonical-head-141e739d-eval/history/public/2026-08-26T122305Z-141e739-policy-stress-recall-eval-snapshot/recall-eval-diagnostics.json.gz";

describe("canonical measurement honesty", () => {
  it("fails retained ranking gates for a candidate_key-order planted ranker", () => {
    const row = plantedCanonicalQuestion({
      questionId: "q-planted-key-order",
      fieldObjectIds: [
        PLANTED_A_ID,
        PLANTED_B_ID,
        PLANTED_C_ID,
        PLANTED_D_ID,
        PLANTED_E_ID,
        PLANTED_GOLD_ID
      ],
      deliveredObjectIds: [
        PLANTED_A_ID,
        PLANTED_B_ID,
        PLANTED_C_ID,
        PLANTED_D_ID,
        PLANTED_E_ID
      ]
    });
    expect(row.hit_at_5).toBe(false);
    expect(row.miss_classification).toBe("under_ranked");
    expect(row.miss_taxonomy).toBe("delivery_order_drop");

    const metrics = buildLongMemEvalQualityMetrics([row]);
    expect(metrics.miss_distribution.under_ranked).toBe(1);
    expect(metrics.gold_rank_buckets?.in_field_unranked).toBe(1);
    expect(metrics.gold_rank_buckets?.candidate_absent).toBe(0);

    const coverage = buildLongMemEvalFullGoldCoverage([row]);
    expect(coverage.pool_recall_at_50).toBe(1);
    expect(coverage.pool_recall_at_100).toBe(1);
    expect(coverage.delivery_contribution).toBeUndefined();

    const payload = candidateKeyOrderGatePayload(metrics, coverage);
    const gateIds = collectReleaseHardGates(payload).map((gate) => gate.id);
    expect(gateIds).not.toContain("longmemeval_s_evidence_stream_gold_delivery");
    const rAt5 = collectReleaseHardGates(payload).find(
      (gate) => gate.id === "longmemeval_s_100_embedding_off_r_at_5"
    );
    expect(rAt5).toMatchObject({ current: 0, passed: false });
  });

  it("reclassifies planted stored-shape questions without a recall rerun", () => {
    const stored = plantedCanonicalQuestion({
      questionId: "q-planted-reclassify-batch",
      fieldObjectIds: [PLANTED_GOLD_ID, PLANTED_A_ID],
      deliveredObjectIds: [PLANTED_A_ID]
    });
    const repaired = reclassifyQuestionDiagnostics([{
      ...stored,
      miss_classification: "candidate_absent"
    }]);
    expect(repaired.questions[0]?.miss_classification).toBe("under_ranked");
    expect(repaired.quality_metrics.gold_rank_buckets?.candidate_absent).toBe(0);
    expect(repaired.full_gold_coverage.pool_recall_at_100).toBe(1);
    expect(repaired.full_gold_coverage.delivery_contribution).toBeUndefined();
  });

  it("reclassifies a planted recall-eval gzip without a recall rerun", async () => {
    const stored = plantedCanonicalQuestion({
      questionId: "q-planted-gzip",
      fieldObjectIds: [PLANTED_GOLD_ID, PLANTED_A_ID],
      deliveredObjectIds: [PLANTED_A_ID]
    });
    const root = await mkdtemp(path.join(tmpdir(), "alaya-n0-gzip-"));
    const artifactPath = path.join(root, "recall-eval-diagnostics.json.gz");
    try {
      await writeFile(artifactPath, gzipSync(Buffer.from(JSON.stringify({
        schema_version: 2,
        kind: "recall_eval_diagnostics",
        questions: [{
          question_id: stored.question_id,
          diagnostics: { ...stored, miss_classification: "candidate_absent" }
        }]
      }), "utf8")));
      const summary = await reclassifyDiagnosticsGzipArtifact(artifactPath);
      expect(summary.questions).toBe(1);
      expect(summary.in_field_classified_candidate_absent).toBe(0);
      expect(summary.taxonomy_disagreement).toBe(0);
      expect(summary.miss_classification.under_ranked).toBe(1);
      expect(summary.miss_taxonomy.delivery_order_drop).toBe(1);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it("reclassifies the 100Q gzip artifact when present", async () => {
    const artifactPath = resolveGzipArtifact();
    if (artifactPath === null) {
      console.info(`skipping 100Q gzip reclassify; missing ${ARTIFACT_RELATIVE}`);
      return;
    }
    const summary = await reclassifyDiagnosticsGzipArtifact(artifactPath);
    expect(summary.questions).toBeGreaterThan(0);
    expect(summary.in_field_classified_candidate_absent).toBe(0);
    expect(summary.taxonomy_disagreement).toBe(0);
    expect(summary.miss_classification.under_ranked ?? 0).toBeGreaterThan(0);
    expect(
      (summary.miss_classification.under_ranked ?? 0) ===
        (summary.miss_taxonomy.delivery_order_drop ?? 0)
    ).toBe(true);
  });
});

function candidateKeyOrderGatePayload(
  metrics: ReturnType<typeof buildLongMemEvalQualityMetrics>,
  coverage: ReturnType<typeof buildLongMemEvalFullGoldCoverage>
): KpiPayload {
  return {
    bench_name: "public",
    split: "longmemeval-s",
    run_at: "2026-08-26T00:00:00.000Z",
    alaya_commit: "planted0",
    alaya_version: "0.3.11",
    embedding_provider: "none",
    chat_provider: "n/a",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: { name: "longmemeval_s", size: 100, source: "planted" },
    sample_size: 100,
    evaluated_count: 100,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: 0,
      r_at_5: 0,
      r_at_10: 0,
      latency_ms_p50: 60,
      latency_ms_p95: 110,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: 0.88,
      tier_distribution: { hot: 50, warm: 30, cold: 20 },
      degradation_reasons: {
        none: 80,
        warm_cascade_engaged: 12,
        cold_cascade_engaged: 8,
        recall_explainability_partial: 0
      },
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      per_scenario: [],
      quality_metrics: {
        ...metrics,
        evidence_stream_gold_delivery_rate: 1,
        evidence_stream_gold_delivery_count: 17,
        evidence_stream_gold_delivery_denominator: 17
      },
      full_gold_coverage: coverage
    }
  };
}

function resolveGzipArtifact(): string | null {
  const candidates = [
    path.resolve(process.cwd(), ARTIFACT_RELATIVE),
    path.resolve(process.cwd(), "..", "..", ARTIFACT_RELATIVE)
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? null;
}
