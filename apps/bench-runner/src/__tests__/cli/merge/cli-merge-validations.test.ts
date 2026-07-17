import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KpiPayload } from "@do-soul/alaya-eval";

import { runCli } from "../../../cli/index.js";

import { LONGMEMEVAL_DIAGNOSTICS_FILENAME } from "./cli-merge-validations-fixture.js";
import {
  buildGoldDiagnostic,
  buildQuestionDiagnosticFixture
} from "../../longmemeval/diagnostics/gold-diagnostic-fixture.js";

import {
  makeQualityMetrics,
  makeShardDiagnostics,
  makeShardKpi,
  writeHistoryEntry,
  writeShardRoot
} from "./cli-merge-validations-fixture.js";

describe("merge-longmemeval validations", () => {

  let tmpRoot: string;

  let originalWrite: typeof process.stderr.write;

  let stderrBuf: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "merge-validations-"));
    stderrBuf = "";
    originalWrite = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((chunk: string | Uint8Array) => {
      stderrBuf += chunk.toString();
      return true;
    }) as typeof process.stderr.write;
  });

  afterEach(async () => {
    process.stderr.write = originalWrite;
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("uses exact merged latency when shard rows carry per-question latency", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    const rowsA = Array.from({ length: 10 }, (_, index) => ({
      id: `lat-a-${index}`,
      version: 1,
      hit_at_5: true,
      tier: "warm" as const,
      latency_ms: index + 1
    }));
    const rowsB = Array.from({ length: 10 }, (_, index) => ({
      id: `lat-b-${index}`,
      version: 1,
      hit_at_5: true,
      tier: "warm" as const,
      latency_ms: index + 11
    }));
    await writeShardRoot(
      shardA,
      makeShardKpi({
        evaluated_count: 10,
        kpi: {
          ...makeShardKpi().kpi,
          latency_ms_p50: 500,
          latency_ms_p95: 1000,
          tier_distribution: { hot: 0, warm: 10, cold: 0 },
          quality_metrics: makeQualityMetrics({ denominator: 10 }),
          per_scenario: rowsA
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        evaluated_count: 10,
        kpi: {
          ...makeShardKpi().kpi,
          latency_ms_p50: 500,
          latency_ms_p95: 1000,
          tier_distribution: { hot: 0, warm: 10, cold: 0 },
          quality_metrics: makeQualityMetrics({ denominator: 10 }),
          per_scenario: rowsB
        }
      })
    );

    const historyRoot = path.join(tmpRoot, "history-latency");
    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      historyRoot,
      "--shards",
      shardA,
      shardB
    ]);

    expect(exitCode).toBe(1);
    const pointer = JSON.parse(
      await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")
    ) as { slug: string };
    const merged = JSON.parse(
      await readFile(
        path.join(historyRoot, "public", pointer.slug, "kpi.json"),
        "utf8"
      )
    ) as KpiPayload;
    expect(merged.kpi.latency_source).toBe("exact");
    expect(merged.kpi.latency_ms_p50).toBe(10);
    expect(merged.kpi.latency_ms_p95).toBe(19);
  });

  it("merges shard roots that only expose latest-run pointers", async () => {
    const shardA = path.join(tmpRoot, "shard-latest-run-a");
    const shardB = path.join(tmpRoot, "shard-latest-run-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "q-latest-run-a-1", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "q-latest-run-b-1", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      })
    );

    await expect(
      readFile(path.join(shardA, "public", "latest-passing.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      readFile(path.join(shardB, "public", "latest-baseline.json"), "utf8")
    ).rejects.toMatchObject({ code: "ENOENT" });

    const historyRoot = path.join(tmpRoot, "history-latest-run");
    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      historyRoot,
      "--shards",
      shardA,
      shardB
    ]);

    expect(exitCode).toBe(1);
    const pointer = JSON.parse(
      await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")
    ) as { slug: string };
    const merged = JSON.parse(
      await readFile(
        path.join(historyRoot, "public", pointer.slug, "kpi.json"),
        "utf8"
      )
    ) as KpiPayload;
    expect(merged.evaluated_count).toBe(10);
  });

  it("rebuilds merged full_gold_coverage from shard diagnostics", async () => {
    const shardA = path.join(tmpRoot, "shard-full-gold-a");
    const shardB = path.join(tmpRoot, "shard-full-gold-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({
        evaluated_count: 1,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 1,
          per_scenario: [
            { id: "q-full-gold-a", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      }),
      makeShardDiagnostics({
        questions: [
          buildQuestionDiagnosticFixture({
            questionId: "q-full-gold-a",
            gold: [
              buildGoldDiagnostic({ object_id: "gold-a-1", final_rank: 1 }),
              buildGoldDiagnostic({ object_id: "gold-a-2", final_rank: 4 })
            ]
          })
        ]
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        evaluated_count: 1,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0,
          per_scenario: [
            { id: "q-full-gold-b", version: 1, hit_at_5: false, tier: "warm" }
          ]
        }
      }),
      makeShardDiagnostics({
        questions: [
          buildQuestionDiagnosticFixture({
            questionId: "q-full-gold-b",
            gold: [
              buildGoldDiagnostic({ object_id: "gold-b-1", final_rank: 7 }),
              buildGoldDiagnostic({
                object_id: "gold-b-2",
                final_rank: null,
                pre_budget_rank: 80
              })
            ]
          })
        ]
      })
    );

    const historyRoot = path.join(tmpRoot, "history-full-gold");
    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      historyRoot,
      "--shards",
      shardA,
      shardB
    ]);

    expect(exitCode).toBe(1);
    const pointer = JSON.parse(
      await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")
    ) as { slug: string };
    const merged = JSON.parse(
      await readFile(
        path.join(historyRoot, "public", pointer.slug, "kpi.json"),
        "utf8"
      )
    ) as KpiPayload;
    expect(merged.kpi.full_gold_coverage).toMatchObject({
      gold_bearing_questions: 2,
      full_gold_at_5: 0.5,
      full_gold_at_10: 0.5,
      gold_coverage_at_5: 0.5,
      gold_coverage_at_10: 0.75,
      pool_recall_at_50: 0.75,
      pool_recall_at_100: 1
    });
  });

  it("omits merged full_gold_coverage for legacy diagnostics without gold detail", async () => {
    const shard = path.join(tmpRoot, "shard-full-gold-mismatch");
    await writeShardRoot(
      shard,
      makeShardKpi({
        evaluated_count: 1,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 1,
          per_scenario: [
            { id: "q-full-gold-expected", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      }),
      makeShardDiagnostics({
        questions: [
          {
            question_id: "q-full-gold-expected",
            gold_memory_ids: ["gold-a-1"],
            delivered_memory_ids: ["gold-a-1"],
            delivered_gold_ids: ["gold-a-1"],
            hit_at_5: true,
            miss_reasons: [],
            provider_state: "provider_not_requested",
            candidates: []
          }
        ]
      })
    );

    const historyRoot = path.join(tmpRoot, "history-full-gold-mismatch");
    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      historyRoot,
      "--shards",
      shard
    ]);

    expect(exitCode).toBe(1);
    const pointer = JSON.parse(
      await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")
    ) as { slug: string };
    const merged = JSON.parse(
      await readFile(
        path.join(historyRoot, "public", pointer.slug, "kpi.json"),
        "utf8"
      )
    ) as KpiPayload;
    expect(merged.kpi.full_gold_coverage).toBeUndefined();
  });

  it("fails merge when a shard is missing its diagnostics sidecar", async () => {
    const shard = path.join(tmpRoot, "shard-missing-diagnostics");
    await writeShardRoot(
      shard,
      makeShardKpi({
        evaluated_count: 1,
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "q-missing-diag", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      }),
      null
    );

    const historyRoot = path.join(tmpRoot, "history-missing-diagnostics");
    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      historyRoot,
      "--shards",
      shard
    ]);

    expect(exitCode).not.toBe(0);
    expect(stderrBuf).toMatch(
      /missing diagnostics sidecar for shard root=.*slug=/
    );
  });

  it("accepts latest-passing and legacy latest-baseline shard pointers", async () => {
    const shardA = path.join(tmpRoot, "shard-passing");
    const shardB = path.join(tmpRoot, "shard-baseline");
    await writeShardRoot(
      shardA,
      makeShardKpi({
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "q-passing-1", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      }),
      undefined,
      ["passing"]
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "q-baseline-1", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      }),
      undefined,
      ["baseline"]
    );

    const historyRoot = path.join(tmpRoot, "history-compatible-pointers");
    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      historyRoot,
      "--shards",
      shardA,
      shardB
    ]);

    expect(exitCode).toBe(1);
  });

  it("fails closed when present side-effect counters are malformed", async () => {
    const shard = path.join(tmpRoot, "shard-malformed-side-effects");
    await writeShardRoot(
      shard,
      makeShardKpi({
        policy_shape: "chat",
        simulate_report: "mixed",
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 1
        }
      }),
      makeShardDiagnostics({
        report_side_effects: {
          ...(makeShardDiagnostics().report_side_effects as Record<string, unknown>),
          memory_graph_edges_total: "bad"
        }
      })
    );

    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      path.join(tmpRoot, "history-malformed-side-effects"),
      "--shards",
      shard
    ]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toContain(
      "invalid report_side_effects.memory_graph_edges_total: expected finite number"
    );
  });

  it("fails closed when compact side-effect snapshot_count is malformed", async () => {
    const shard = path.join(tmpRoot, "shard-malformed-snapshot-count");
    const fullReportSideEffects =
      makeShardDiagnostics().report_side_effects as Record<string, unknown>;
    const compactReportSideEffects = {
      ...Object.fromEntries(
        Object.entries(fullReportSideEffects).filter(([key]) => key !== "snapshots")
      ),
      snapshot_count: "bad"
    };
    await writeShardRoot(
      shard,
      makeShardKpi({
        policy_shape: "chat",
        simulate_report: "mixed",
        evaluated_count: 0,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 1,
          per_scenario: []
        }
      }),
      makeShardDiagnostics({
        compact_schema_version: 1,
        question_count: 0,
        questions: undefined,
        report_side_effects: compactReportSideEffects
      })
    );

    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      path.join(tmpRoot, "history-malformed-snapshot-count"),
      "--shards",
      shard
    ]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toContain(
      "invalid report_side_effects.snapshot_count: expected non-negative integer"
    );
  });
});
