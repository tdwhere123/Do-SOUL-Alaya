import { execFile } from "node:child_process";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const rootDir = path.resolve(__dirname, "../../../../..");

async function writeDiagnosticsFixture(input: {
  readonly embeddingMode?: "env" | "disabled" | null;
} = {}): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), "alaya-abstention-script-"));
  const diagnosticsPath = path.join(dir, "longmemeval-diagnostics.json");
  const embeddingMode = input.embeddingMode === undefined ? "env" : input.embeddingMode;
  await writeFile(
    diagnosticsPath,
    JSON.stringify(
      {
        schema_version: 1,
        bench_name: "public",
        split: "s",
        run_at: "2026-07-07T00:00:00.000Z",
        alaya_commit: "test",
        embedding_provider: "test-provider",
        ...(embeddingMode === null ? {} : { embedding_mode: embeddingMode }),
        provider_state_summary: {
          total: 3,
          provider_returned: 3,
          provider_pending: 0,
          provider_failed: 0,
          provider_not_requested: 0,
          unknown: 0,
          provider_returned_rate: 1,
          provider_pending_rate: 0,
          provider_failed_rate: 0,
          provider_not_requested_rate: 0,
          unknown_rate: 0
        },
        questions: [
          {
            question_id: "q-answerable",
            gold_memory_ids: ["gold-1"],
            delivered_results: [
              {
                object_id: "gold-1",
                rank: 1,
                relevance_score: 0.96,
                fused_score: 2.5,
                fused_rank_contribution_per_stream: {
                  embedding_similarity: 0.3,
                  evidence_fts: 0.2,
                  graph_expansion: 0.1
                }
              },
              {
                object_id: "decoy-1",
                rank: 2,
                relevance_score: 0.62,
                fused_score: 1,
                fused_rank_contribution_per_stream: {
                  structural: 0.2,
                  path_expansion: 0.1
                },
                flood_fuel_coverage: {
                  candidates_total: 2,
                  cold_start_count: 1,
                  fuel_verified_count: 1,
                  slice_active_count: 0,
                  path_active_count: 1,
                  evidence_active_count: 1
                }
              }
            ],
            gold: [
              {
                object_id: "gold-1",
                final_rank: 1
              }
            ]
          },
          {
            question_id: "q-undelivered-gold",
            gold_memory_ids: ["gold-2"],
            delivered_results: [
              {
                object_id: "decoy-2",
                rank: 1,
                relevance_score: 0.58
              }
            ],
            gold: [
              {
                object_id: "gold-2",
                final_rank: null
              }
            ]
          },
          {
            question_id: "q-abs_abs",
            gold_memory_ids: [],
            delivered_results: [
              {
                object_id: "abs-decoy",
                rank: 1,
                relevance_score: 0.99,
                fused_score: 2
              },
              {
                object_id: "abs-decoy-2",
                rank: 2,
                relevance_score: 0.97,
                fused_score: 1.9
              }
            ],
            gold: []
          }
        ]
      },
      null,
      2
    )
  );
  return diagnosticsPath;
}

describe("bench-run .do-it abstention and flood scripts", () => {
  it("reports abstention threshold sweeps without using true abstentions for threshold search", async () => {
    const diagnosticsPath = await writeDiagnosticsFixture();
    const { stdout } = await execFileAsync("node", [
      "apps/bench-runner/scripts/evaluate-abstention-calibration.mjs",
      "--diagnostics",
      diagnosticsPath,
      "--include-sweep"
    ], { cwd: rootDir });
    const report = JSON.parse(stdout);
    expect(report.schema_version).toBe("abstention-calibration-eval.v1");
    expect(report.counts).toMatchObject({
      answerable_training: 2,
      synthetic_negatives: 1,
      synthetic_skipped_no_delivered_gold: 1,
      true_abstention_holdout: 1
    });
    expect(report.calibration_boundary).toMatchObject({
      threshold_search_uses_true_abs_holdout: false,
      premise_invalid_available: false,
      premise_invalid_default: false
    });
    expect(report.runtime_handoff).toMatchObject({
      status: "uncalibrated",
      scorable: false,
      scorer_field: null,
      scorer_threshold: null,
      diagnostic_field: "abstention_confidence_score",
      promotion_eligible: false
    });
    expect(report.signal_comparison.runtime_confidence).toEqual(["abstention_confidence_score"]);
    const relevanceSweep = report.signals.find(
      (signal: { signal: string }) => signal.signal === "top1_top2_relevance_margin"
    );
    expect(relevanceSweep.best_by_answerable_f1.holdout_true_abs_evaluated).toBe(1);
    expect(relevanceSweep.sweep.every((row: { threshold: unknown }) => typeof row.threshold === "number")).toBe(true);
    expect(report.feature_availability.top1_fused_score.missing).toBeGreaterThan(0);
  });

  it("checks flood experiment env and only reports explicit fuel coverage", async () => {
    const diagnosticsPath = await writeDiagnosticsFixture();
    const { stdout } = await execFileAsync("node", [
      "apps/bench-runner/scripts/check-flood-delivery-experiment.mjs",
      "--diagnostics",
      diagnosticsPath,
      "--embedding",
      "env"
    ], {
      cwd: rootDir,
      env: { ...process.env }
    });
    const report = JSON.parse(stdout);
    expect(report.ok).toBe(true);
    expect(report.checks).toEqual({
      answers_with_env_ok: true,
      embedding_env_ok: true,
      fuel_verified_ok: true
    });
    expect(report.fuel_coverage).toMatchObject({
      available: true,
      blocks: 1,
      candidates_total: 2,
      fuel_verified_count: 1,
      fuel_verified_rate: 0.5
    });
  });

  it("fails when diagnostics declare flood fuel coverage with zero fuel_verified_count", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "alaya-flood-zero-fuel-"));
    const diagnosticsPath = path.join(dir, "longmemeval-diagnostics.json");
    await writeFile(
      diagnosticsPath,
      JSON.stringify({
        schema_version: 1,
        embedding_mode: "env",
        questions: [
          {
            question_id: "q-cold",
            delivered_results: [
              {
                object_id: "cold-1",
                flood_fuel_coverage: {
                  candidates_total: 3,
                  cold_start_count: 3,
                  fuel_verified_count: 0,
                  slice_active_count: 0,
                  path_active_count: 0,
                  evidence_active_count: 0
                }
              }
            ]
          }
        ]
      }),
      "utf8"
    );

    await expect(
      execFileAsync("node", [
        "apps/bench-runner/scripts/check-flood-delivery-experiment.mjs",
        "--diagnostics",
        diagnosticsPath,
        "--embedding",
        "env"
      ], {
        cwd: rootDir,
        env: { ...process.env }
      })
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("\"fuel_verified_ok\": false")
    });
  });

  it("does not let CLI embedding mode override diagnostics provenance", async () => {
    const diagnosticsPath = await writeDiagnosticsFixture({ embeddingMode: "disabled" });

    await expect(
      execFileAsync("node", [
        "apps/bench-runner/scripts/check-flood-delivery-experiment.mjs",
        "--diagnostics",
        diagnosticsPath,
        "--embedding",
        "env"
      ], {
        cwd: rootDir,
        env: { ...process.env }
      })
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("\"embedding_env_ok\": false")
    });
  });

  it("requires embedding provenance when diagnostics are supplied", async () => {
    const diagnosticsPath = await writeDiagnosticsFixture({ embeddingMode: null });

    await expect(
      execFileAsync("node", [
        "apps/bench-runner/scripts/check-flood-delivery-experiment.mjs",
        "--diagnostics",
        diagnosticsPath,
        "--embedding",
        "env"
      ], {
        cwd: rootDir,
        env: { ...process.env }
      })
    ).rejects.toMatchObject({
      stdout: expect.stringContaining("\"sidecar_embedding_mode\": null")
    });
  });

  it("refuses weighted replay unless diagnostics declare a complete candidate pool", async () => {
    const diagnosticsPath = await writeDiagnosticsFixture();

    await expect(
      execFileAsync("node", [
        "apps/bench-runner/scripts/replay-longmemeval-diagnostics.mjs",
        "--diagnostics",
        diagnosticsPath,
        "--weights",
        "embedding_similarity=0.5"
      ], { cwd: rootDir })
    ).rejects.toMatchObject({
      stderr: expect.stringContaining("candidate_pool_complete=true")
    });
  });
});
