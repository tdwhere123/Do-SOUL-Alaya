import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KpiPayload } from "@do-soul/alaya-eval";

import { runCli } from "../../cli/index.js";

import { LONGMEMEVAL_DIAGNOSTICS_FILENAME } from "./cli-merge-validations-fixture.js";

import {
  withEligibleMeasurementContract,
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

  it("fails closed when compact question_count is malformed", async () => {
    const shard = path.join(tmpRoot, "shard-malformed-question-count");
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
        compact_schema_version: 1,
        question_count: "bad",
        questions: undefined,
        report_side_effects: undefined
      })
    );

    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      path.join(tmpRoot, "history-malformed-question-count"),
      "--shards",
      shard
    ]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toContain(
      "invalid compact diagnostics question_count: expected non-negative integer"
    );
  });

  it("reports a clear error when a shard root has no usable pointer", async () => {
    const shard = path.join(tmpRoot, "shard-no-pointer");
    await mkdir(path.join(shard, "public"), { recursive: true });

    const historyRoot = path.join(tmpRoot, "history-no-pointer");
    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      historyRoot,
      "--shards",
      shard
    ]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toContain(
      "no usable shard pointer; checked latest-passing.json, latest-run.json, latest-baseline.json"
    );
  });

  it("fails closed when merged full diagnostics duplicate question ids", async () => {
    const shardA = path.join(tmpRoot, "shard-diagnostics-a");
    const shardB = path.join(tmpRoot, "shard-diagnostics-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({
        evaluated_count: 1,
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "q-diagnostics-a", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      }),
      makeShardDiagnostics({
        questions: [
          {
            question_id: "q-diagnostics-a",
            gold_memory_ids: ["gold-a"],
            delivered_memory_ids: ["delivered-a"],
            delivered_gold_ids: ["gold-a"],
            miss_reasons: [],
            provider_state: "provider_not_requested"
          }
        ]
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        evaluated_count: 1,
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "q-diagnostics-a", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      }),
      makeShardDiagnostics({
        questions: [
          {
            question_id: "q-diagnostics-a",
            gold_memory_ids: ["gold-b"],
            delivered_memory_ids: ["delivered-b"],
            delivered_gold_ids: ["gold-b"],
            miss_reasons: [],
            provider_state: "provider_not_requested"
          }
        ]
      })
    );

    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      path.join(tmpRoot, "history-duplicate-diagnostics"),
      "--shards",
      shardA,
      shardB
    ]);

    expect(exitCode).toBe(2);
    expect(stderrBuf).toContain(
      "merge refused: duplicate question_id 'q-diagnostics-a' across shards"
    );
  });

  it("diffs merged public archives against the newest passing baseline", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "q-shard-a-1", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "abc1234",
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "q-shard-b-1", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      })
    );
    const historyRoot = path.join(tmpRoot, "history-baseline");
    const priorPassingRunAt = "2026-05-13T12:00:00.000Z";
    await writeHistoryEntry(
      historyRoot,
      "2026-05-13T120000Z-aaa1111-policy-stress",
      withEligibleMeasurementContract(makeShardKpi({
        run_at: priorPassingRunAt,
        alaya_commit: "aaa1111",
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0.8
        }
      }))
    );
    await writeHistoryEntry(
      historyRoot,
      "2026-05-13T130000Z-bbb2222-policy-stress",
      makeShardKpi({
        run_at: "2026-05-13T13:00:00.000Z",
        alaya_commit: "bbb2222",
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0.1
        }
      }),
      "# findings\n- regression\n"
    );

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

    expect(exitCode).toBe(0);
    const pointer = JSON.parse(
      await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")
    ) as { slug: string };
    const merged = JSON.parse(
      await readFile(
        path.join(historyRoot, "public", pointer.slug, "kpi.json"),
        "utf8"
      )
    ) as KpiPayload;
    expect(merged.diff_vs_previous?.previous_run).toBe(priorPassingRunAt);
  });

  it("merges diagnostics miss taxonomy distribution while accepting legacy sidecars", async () => {
    const shardA = path.join(tmpRoot, "shard-taxonomy-a");
    const shardB = path.join(tmpRoot, "shard-taxonomy-b");
    const shardLegacy = path.join(tmpRoot, "shard-taxonomy-legacy");
    const baseEvidence = () =>
      makeShardDiagnostics().scored_recall_evidence as Record<string, unknown>;
    const writeTaxonomyShard = (
      shard: string,
      questionId: string,
      hitAt5: boolean,
      missTaxonomyDistribution: Record<string, number>
    ) =>
      writeShardRoot(
        shard,
        makeShardKpi({
          kpi: {
            ...makeShardKpi().kpi,
            per_scenario: [{ id: questionId, version: 1, hit_at_5: hitAt5, tier: "warm" }]
          }
        }),
        makeShardDiagnostics({
          scored_recall_evidence: {
            ...baseEvidence(),
            miss_taxonomy_distribution: missTaxonomyDistribution
          }
        })
      );
    await writeTaxonomyShard(shardA, "q-taxonomy-a", true, {
      candidate_absent: 1,
      materialization_drop: 2,
      budget_drop: 0,
      delivery_order_drop: 0,
      answer_set_coverage_drop: 0,
      evaluation_or_gold_issue: 0
    });
    await writeTaxonomyShard(shardB, "q-taxonomy-b", false, {
      candidate_absent: 0,
      materialization_drop: 0,
      budget_drop: 3,
      delivery_order_drop: 4,
      answer_set_coverage_drop: 0,
      evaluation_or_gold_issue: 5
    });
    const {
      miss_taxonomy_distribution: _legacyTaxonomy,
      ...legacyEvidence
    } = baseEvidence();
    await writeShardRoot(
      shardLegacy,
      makeShardKpi({
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "q-taxonomy-legacy", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      }),
      makeShardDiagnostics({ scored_recall_evidence: legacyEvidence })
    );

    const historyRoot = path.join(tmpRoot, "history-taxonomy");
    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      historyRoot,
      "--shards",
      shardA,
      shardB,
      shardLegacy
    ]);

    expect(exitCode).toBe(0);
    const pointer = JSON.parse(
      await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")
    ) as { slug: string };
    const diagnostics = JSON.parse(
      await readFile(
        path.join(historyRoot, "public", pointer.slug, LONGMEMEVAL_DIAGNOSTICS_FILENAME),
        "utf8"
      )
    ) as {
      scored_recall_evidence?: {
        miss_taxonomy_distribution?: Record<string, number>;
      };
    };
    expect(diagnostics.scored_recall_evidence?.miss_taxonomy_distribution).toEqual({
      candidate_absent: 1,
      materialization_drop: 2,
      budget_drop: 3,
      delivery_order_drop: 4,
      answer_set_coverage_drop: 0,
      evaluation_or_gold_issue: 5
    });
  });

});
