import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(__dirname, "../../../../..");
const scriptPath = "apps/bench-runner/scripts/evaluate-abstention-calibration.mjs";

function deliveredResult(
  objectId: string,
  relevanceScore: number,
  fusedScore: number,
  contributions: Record<string, number>,
  abstentionConfidenceScore?: number
) {
  return {
    object_id: objectId,
    relevance_score: relevanceScore,
    fused_score: fusedScore,
    fused_rank_contribution_per_stream: contributions,
    ...(abstentionConfidenceScore === undefined
      ? {}
      : { abstention_confidence_score: abstentionConfidenceScore })
  };
}

function answerableQuestions() {
  return [
    {
      question_id: "q-answerable-strong",
      gold_memory_ids: ["gold-1"],
      delivered_results: [
        deliveredResult("gold-1", 0.9, 2.4, { embedding_similarity: 0.4, evidence_fts: 0.2 }, 0.95),
        deliveredResult("decoy-1", 0.35, 0.7, { structural: 0.2 }, 0.95),
        deliveredResult("decoy-2", 0.3, 0.4, { structural: 0.1 }, 0.95)
      ]
    },
    {
      question_id: "q-answerable-overlap",
      gold_memory_ids: ["gold-2"],
      delivered_results: [
        deliveredResult("gold-2", 0.75, 1.8, { embedding_similarity: 0.3 }, 0.7),
        deliveredResult("decoy-3", 0.45, 0.8, { structural: 0.2 }, 0.7),
        deliveredResult("decoy-4", 0.4, 0.6, { structural: 0.1 }, 0.7)
      ]
    }
  ];
}

function abstentionQuestions() {
  return [
    {
      question_id: "q-abs-one_abs",
      gold_memory_ids: [],
      delivered_results: [
        deliveredResult("abs-decoy-1", 0.99, 2.6, { structural: 0.2 }, 0.99),
        deliveredResult("abs-decoy-2", 0.98, 2.55, { structural: 0.1 }, 0.99)
      ]
    },
    {
      question_id: "q-abs-two_abs",
      gold_memory_ids: [],
      delivered_results: [
        deliveredResult("abs-decoy-3", 0.97, 2.5, { structural: 0.2 }, 0.05),
        deliveredResult("abs-decoy-4", 0.96, 2.45, { structural: 0.1 }, 0.05)
      ]
    }
  ];
}

async function writeDiagnosticsFixture(input: { readonly includeAbs?: boolean } = {}) {
  const dir = await mkdtemp(path.join(tmpdir(), "alaya-abstention-calibration-"));
  const diagnosticsPath = path.join(dir, "longmemeval-diagnostics.json");
  const questions = [...answerableQuestions(), ...(input.includeAbs === false ? [] : abstentionQuestions())];
  await writeFile(
    diagnosticsPath,
    JSON.stringify(
      {
        schema_version: 1,
        bench_name: "fixture",
        split: "test",
        run_at: "2026-07-07T00:00:00.000Z",
        alaya_commit: "test",
        embedding_mode: "env",
        embedding_provider: "test-provider",
        questions
      },
      null,
      2
    )
  );
  return diagnosticsPath;
}

async function runReport(diagnosticsPath: string) {
  const { stdout } = await execFileAsync("node", [scriptPath, "--diagnostics", diagnosticsPath, "--include-sweep"], {
    cwd: rootDir
  });
  return JSON.parse(stdout);
}

describe("evaluate-abstention-calibration script", () => {
  it("reports separate raw, margin, and likelihood ROC/AUC evidence without training on true abstentions", async () => {
    const diagnosticsPath = await writeDiagnosticsFixture();
    const report = await runReport(diagnosticsPath);

    expect(report.calibration_boundary).toMatchObject({
      threshold_search_uses_true_abs_holdout: false,
      roc_auc_uses_true_abs_holdout_for_evaluation_only: true,
      roc_auc_excludes_synthetic_negatives: true,
      isotonic_fit_uses_true_abs_holdout: false
    });
    expect(report.signal_comparison.raw_score).toEqual(["top1_relevance_score", "top1_fused_score"]);
    expect(report.signal_comparison.margin).toContain("top1_top2_relevance_margin");
    expect(report.signal_comparison.likelihood_support).toEqual(["likelihood_stream_support_count"]);
    expect(report.signal_comparison.runtime_confidence).toEqual(["abstention_confidence_score"]);
    expect(report.signal_comparison.isotonic).toContain("isotonic_top1_top2_fused_margin");
    expect(report.runtime_handoff).toMatchObject({
      scorer_field: "abstention_confidence_score",
      scorer_threshold: 0.91
    });

    const rawThresholds = report.signals
      .find((signal: { signal: string }) => signal.signal === "top1_relevance_score")
      .sweep.map((row: { threshold: number }) => row.threshold);
    expect(Math.max(...rawThresholds)).toBeLessThan(0.91);

    const rawRoc = report.roc_auc.find((signal: { signal: string }) => signal.signal === "top1_relevance_score");
    const marginRoc = report.roc_auc.find(
      (signal: { signal: string }) => signal.signal === "top1_top2_relevance_margin"
    );
    const likelihoodRoc = report.roc_auc.find(
      (signal: { signal: string }) => signal.signal === "likelihood_stream_support_count"
    );
    const confidenceRoc = report.roc_auc.find(
      (signal: { signal: string }) => signal.signal === "abstention_confidence_score"
    );
    const isotonicRoc = report.roc_auc.find(
      (signal: { signal: string }) => signal.signal === "isotonic_top1_top2_fused_margin"
    );
    expect(rawRoc).toMatchObject({ comparison_group: "raw_score", positives: 2, negatives: 2, evaluated: 4 });
    expect(marginRoc).toMatchObject({ comparison_group: "margin", auc_reason: null });
    expect(likelihoodRoc).toMatchObject({ comparison_group: "likelihood_support", auc_reason: null });
    expect(confidenceRoc).toMatchObject({
      comparison_group: "runtime_confidence",
      positives: 2,
      negatives: 2,
      auc_reason: null
    });
    expect(isotonicRoc).toMatchObject({
      family: "isotonic_calibrated",
      source_signal: "top1_top2_fused_margin",
      auc_reason: null
    });
    expect(typeof confidenceRoc.auc).toBe("number");
    expect(typeof isotonicRoc.auc).toBe("number");
    expect(report.isotonic_calibration.algorithm).toBe("pava");
    expect(report.isotonic_calibration.fits.top1_top2_fused_margin.fitted_count).toBeGreaterThan(0);
    expect(rawRoc.roc.length).toBeGreaterThan(0);
    expect(typeof rawRoc.auc).toBe("number");
    expect(typeof marginRoc.auc).toBe("number");
    expect(typeof likelihoodRoc.auc).toBe("number");
  });

  it("returns null AUC with an explicit reason when the hold-out negative class is missing", async () => {
    const diagnosticsPath = await writeDiagnosticsFixture({ includeAbs: false });
    const report = await runReport(diagnosticsPath);

    const rawRoc = report.roc_auc.find((signal: { signal: string }) => signal.signal === "top1_relevance_score");
    expect(rawRoc).toMatchObject({
      auc: null,
      auc_reason: "missing_negative_examples",
      positives: 2,
      negatives: 0,
      roc: []
    });
  });
});
