import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { collectReleaseHardGates, type KpiPayload } from "@do-soul/alaya-eval";
import { createMergeDatasetSource, runMergeCli } from "./cli-merge-dataset-fixture.js";
import { setupShard } from "./cli-merge-evidence-fixture.js";
import {
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  makeQualityMetrics,
  makeShardDiagnostics,
  makeShardKpi,
  withEligibleMeasurementContract,
  writeHistoryEntry,
  writeShardRoot
} from "./cli-merge-validations-fixture.js";

const MERGE_ARCHIVE_TEST_TIMEOUT_MS = 15_000;

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

  function mergeShards(historyName: string, shards: readonly string[]): Promise<number> {
    return runMergeCli(tmpRoot, [
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      path.join(tmpRoot, historyName),
      "--shards",
      ...shards
    ]);
  }

  async function readLatestRunFile<T>(historyName: string, filename: string): Promise<T> {
    const historyRoot = path.join(tmpRoot, historyName);
    const pointer = JSON.parse(
      await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")
    ) as { slug: string };
    return JSON.parse(
      await readFile(path.join(historyRoot, "public", pointer.slug, filename), "utf8")
    ) as T;
  }

  it("uses exact merged latency when shard rows carry per-question latency", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    const rowsFor = (prefix: string, offset: number) => Array.from({ length: 10 }, (_, index) => ({
      id: `lat-${prefix}-${index}`,
      version: 1,
      hit_at_5: true,
      tier: "warm" as const,
      latency_ms: index + offset
    }));
    for (const [shard, rows] of [[shardA, rowsFor("a", 1)], [shardB, rowsFor("b", 11)]] as const) {
      await writeShardRoot(shard, makeShardKpi({
        evaluated_count: 10,
        kpi: {
          ...makeShardKpi().kpi,
          latency_ms_p50: 500,
          latency_ms_p95: 1000,
          tier_distribution: { hot: 0, warm: 10, cold: 0 },
          quality_metrics: makeQualityMetrics({ denominator: 10 }),
          per_scenario: rows
        }
      }));
    }

    expect(await mergeShards("history-latency", [shardA, shardB])).toBe(1);
    const merged = await readLatestRunFile<KpiPayload>("history-latency", "kpi.json");
    expect(merged.kpi.latency_source).toBe("exact");
    expect(merged.kpi.latency_ms_p50).toBe(10);
    expect(merged.kpi.latency_ms_p95).toBe(19);
  }, MERGE_ARCHIVE_TEST_TIMEOUT_MS);

  it("merges shard roots that only expose latest-run pointers", async () => {
    const shardA = path.join(tmpRoot, "shard-latest-run-a");
    const shardB = path.join(tmpRoot, "shard-latest-run-b");
    await writeShardRoot(shardA, makeShardKpi({
      evaluated_count: 5,
      kpi: { ...makeShardKpi().kpi, per_scenario: [{ id: "q-latest-run-a-1", version: 1, hit_at_5: true, tier: "warm" }] }
    }));
    await writeShardRoot(shardB, makeShardKpi({
      evaluated_count: 5,
      kpi: { ...makeShardKpi().kpi, per_scenario: [{ id: "q-latest-run-b-1", version: 1, hit_at_5: true, tier: "warm" }] }
    }));

    await expect(readFile(path.join(shardA, "public", "latest-passing.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(path.join(shardB, "public", "latest-baseline.json"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });
    expect(await mergeShards("history-latest-run", [shardA, shardB])).toBe(1);
    const merged = await readLatestRunFile<KpiPayload>("history-latest-run", "kpi.json");
    expect(merged.evaluated_count).toBe(10);
  }, MERGE_ARCHIVE_TEST_TIMEOUT_MS);

  it("fails merge when a shard is missing its diagnostics sidecar", async () => {
    const shard = path.join(tmpRoot, "shard-missing-diagnostics");
    await writeShardRoot(shard, makeShardKpi({
      evaluated_count: 1,
      kpi: { ...makeShardKpi().kpi, per_scenario: [{ id: "q-missing-diag", version: 1, hit_at_5: true, tier: "warm" }] }
    }), null);

    expect(await mergeShards("history-missing-diagnostics", [shard])).not.toBe(0);
    expect(stderrBuf).toMatch(/missing diagnostics sidecar for shard root=.*slug=/);
  });

  it("accepts latest-passing and legacy latest-baseline shard pointers", async () => {
    const shardA = path.join(tmpRoot, "shard-passing");
    const shardB = path.join(tmpRoot, "shard-baseline");
    await writeShardRoot(shardA, makeShardKpi({
      evaluated_count: 5,
      kpi: { ...makeShardKpi().kpi, per_scenario: [{ id: "q-passing-1", version: 1, hit_at_5: true, tier: "warm" }] }
    }), undefined, ["passing"]);
    await writeShardRoot(shardB, makeShardKpi({
      evaluated_count: 5,
      kpi: { ...makeShardKpi().kpi, per_scenario: [{ id: "q-baseline-1", version: 1, hit_at_5: true, tier: "warm" }] }
    }), undefined, ["baseline"]);

    expect(await mergeShards("history-compatible-pointers", [shardA, shardB])).toBe(1);
  }, MERGE_ARCHIVE_TEST_TIMEOUT_MS);

  it("fails closed when present side-effect counters are malformed", async () => {
    const shard = path.join(tmpRoot, "shard-malformed-side-effects");
    await writeShardRoot(
      shard,
      makeShardKpi({ policy_shape: "chat", simulate_report: "mixed", kpi: { ...makeShardKpi().kpi, r_at_5: 1 } }),
      makeShardDiagnostics({
        report_side_effects: {
          ...(makeShardDiagnostics().report_side_effects as Record<string, unknown>),
          memory_graph_edges_total: "bad"
        }
      })
    );
    expect(await mergeShards("history-malformed-side-effects", [shard])).toBe(2);
    expect(stderrBuf).toContain("invalid report_side_effects.memory_graph_edges_total: expected finite number");
  });

  it("fails closed when compact side-effect snapshot_count is malformed", async () => {
    const shard = path.join(tmpRoot, "shard-malformed-snapshot-count");
    const fullReportSideEffects = makeShardDiagnostics().report_side_effects as Record<string, unknown>;
    const compactReportSideEffects = {
      ...Object.fromEntries(Object.entries(fullReportSideEffects).filter(([key]) => key !== "snapshots")),
      snapshot_count: "bad"
    };
    await writeShardRoot(
      shard,
      makeShardKpi({ policy_shape: "chat", simulate_report: "mixed", evaluated_count: 0, kpi: { ...makeShardKpi().kpi, r_at_5: 1, per_scenario: [] } }),
      makeShardDiagnostics({ compact_schema_version: 1, question_count: 0, questions: undefined, report_side_effects: compactReportSideEffects })
    );
    expect(await mergeShards("history-malformed-snapshot-count", [shard])).toBe(2);
    expect(stderrBuf).toContain("invalid report_side_effects.snapshot_count: expected non-negative integer");
  });

  it("fails closed when compact question_count is malformed", async () => {
    const shard = path.join(tmpRoot, "shard-malformed-question-count");
    await writeShardRoot(
      shard,
      makeShardKpi({ policy_shape: "chat", simulate_report: "mixed", kpi: { ...makeShardKpi().kpi, r_at_5: 1 } }),
      makeShardDiagnostics({ compact_schema_version: 1, question_count: "bad", questions: undefined, report_side_effects: undefined })
    );
    expect(await mergeShards("history-malformed-question-count", [shard])).toBe(2);
    expect(stderrBuf).toContain("invalid compact diagnostics question_count: expected non-negative integer");
  });

  it("reports a clear error when a shard root has no usable pointer", async () => {
    const shard = path.join(tmpRoot, "shard-no-pointer");
    await mkdir(path.join(shard, "public"), { recursive: true });
    expect(await mergeShards("history-no-pointer", [shard])).toBe(2);
    expect(stderrBuf).toContain("no usable shard pointer; checked latest-passing.json, latest-run.json, latest-baseline.json");
  });

  it("fails closed when merged full diagnostics duplicate question ids", async () => {
    const shardA = path.join(tmpRoot, "shard-diagnostics-a");
    const shardB = path.join(tmpRoot, "shard-diagnostics-b");
    for (const [shard, suffix] of [[shardA, "a"], [shardB, "b"]] as const) {
      await writeShardRoot(shard, makeShardKpi({
        evaluated_count: 1,
        kpi: { ...makeShardKpi().kpi, per_scenario: [{ id: "q-diagnostics-a", version: 1, hit_at_5: true, tier: "warm" }] }
      }), makeShardDiagnostics({
        questions: [{
          question_id: "q-diagnostics-a",
          gold_memory_ids: [`gold-${suffix}`],
          delivered_memory_ids: [`delivered-${suffix}`],
          delivered_gold_ids: [`gold-${suffix}`],
          miss_reasons: [],
          provider_state: "provider_not_requested"
        }]
      }));
    }
    expect(await mergeShards("history-duplicate-diagnostics", [shardA, shardB])).toBe(2);
    expect(stderrBuf).toContain("merge refused: duplicate question_id 'q-diagnostics-a' across shards");
  });

  it("omits passing-history diffs for a custom pinned dataset source", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    const dataset = await createMergeDatasetSource(tmpRoot);
    await setupShard(shardA, "q-a", 0);
    await setupShard(shardB, "q-b", 1);
    const historyRoot = path.join(tmpRoot, "history-baseline");
    await writeHistoryEntry(
      historyRoot,
      "2026-05-13T120000Z-aaa1111-policy-stress",
      withEligibleMeasurementContract(makeShardKpi({
        run_at: "2026-05-13T12:00:00.000Z", alaya_commit: "aaa1111", kpi: { ...makeShardKpi().kpi, r_at_5: 0.8 }
      }))
    );
    await writeHistoryEntry(
      historyRoot,
      "2026-05-13T130000Z-bbb2222-policy-stress",
      makeShardKpi({ run_at: "2026-05-13T13:00:00.000Z", alaya_commit: "bbb2222", kpi: { ...makeShardKpi().kpi, r_at_5: 0.1 } }),
      "# findings\n- regression\n"
    );

    const exitCode = await runMergeCli(tmpRoot, [
      "merge-longmemeval", "--variant", "s", "--history-root", historyRoot,
      "--concurrency", "2", ...dataset.cliArgs, "--shards", shardA, shardB
    ]);
    const merged = await readLatestRunFile<KpiPayload>("history-baseline", "kpi.json");
    expect(collectReleaseHardGates(merged)).toEqual([]);
    expect(merged.measurement_attribution?.gate_eligible).toBe(true);
    expect(merged.selection_contract).toBeDefined();
    expect(merged.diff_vs_previous).toBeNull();
    expect(exitCode, stderrBuf).toBe(1);
  });

  it("merges diagnostics miss taxonomy distribution while accepting legacy sidecars", async () => {
    const shardA = path.join(tmpRoot, "shard-taxonomy-a");
    const shardB = path.join(tmpRoot, "shard-taxonomy-b");
    const shardLegacy = path.join(tmpRoot, "shard-taxonomy-legacy");
    const baseEvidence = makeShardDiagnostics().scored_recall_evidence as Record<string, unknown>;
    const writeTaxonomy = (shard: string, questionId: string, hitAt5: boolean, missTaxonomyDistribution: Record<string, number>) =>
      writeShardRoot(
        shard,
        makeShardKpi({ kpi: { ...makeShardKpi().kpi, per_scenario: [{ id: questionId, version: 1, hit_at_5: hitAt5, tier: "warm" }] } }),
        makeShardDiagnostics({ scored_recall_evidence: { ...baseEvidence, miss_taxonomy_distribution: missTaxonomyDistribution } })
      );
    await writeTaxonomy(shardA, "q-taxonomy-a", true, {
      candidate_absent: 1, materialization_drop: 2, fine_assessment_drop: 6,
      budget_drop: 0, delivery_order_drop: 0, answer_set_coverage_drop: 0, evaluation_or_gold_issue: 0
    });
    await writeTaxonomy(shardB, "q-taxonomy-b", false, {
      candidate_absent: 0, materialization_drop: 0, fine_assessment_drop: 7,
      budget_drop: 3, delivery_order_drop: 4, answer_set_coverage_drop: 0, evaluation_or_gold_issue: 5
    });
    const { miss_taxonomy_distribution: _legacyTaxonomy, ...legacyEvidence } = baseEvidence;
    await writeShardRoot(
      shardLegacy,
      makeShardKpi({ kpi: { ...makeShardKpi().kpi, per_scenario: [{ id: "q-taxonomy-legacy", version: 1, hit_at_5: true, tier: "warm" }] } }),
      makeShardDiagnostics({ scored_recall_evidence: legacyEvidence })
    );

    expect(await mergeShards("history-taxonomy", [shardA, shardB, shardLegacy])).toBe(1);
    const diagnostics = await readLatestRunFile<{
      scored_recall_evidence?: { miss_taxonomy_distribution?: Record<string, number> };
      questions?: Array<{ question_id: string; cohort_ledger?: { measurement_evidence_mode?: string } }>;
    }>("history-taxonomy", LONGMEMEVAL_DIAGNOSTICS_FILENAME);
    expect(diagnostics.scored_recall_evidence?.miss_taxonomy_distribution).toEqual({
      candidate_absent: 1, materialization_drop: 2, fine_assessment_drop: 13,
      budget_drop: 3, delivery_order_drop: 4, answer_set_coverage_drop: 0, evaluation_or_gold_issue: 5
    });
    expect(diagnostics.questions?.find((question) => question.question_id === "q-taxonomy-legacy")
      ?.cohort_ledger?.measurement_evidence_mode).toBe("legacy_synthesized");
  }, 20_000);

  it("refuses shards whose duplicate question ids overlap", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(shardA, makeShardKpi({
      alaya_commit: "abc1234",
      kpi: { ...makeShardKpi().kpi, per_scenario: [{ id: "q-collide", version: 1, hit_at_5: true, tier: "warm" }] }
    }));
    await writeShardRoot(shardB, makeShardKpi({
      alaya_commit: "abc1234",
      kpi: { ...makeShardKpi().kpi, per_scenario: [{ id: "q-collide", version: 1, hit_at_5: false, tier: "warm" }] }
    }));
    expect(await mergeShards("history-collide", [shardA, shardB])).toBe(2);
    expect(stderrBuf).toMatch(/duplicate question_id 'q-collide'/);
  });

  it.each<{
    readonly label: string;
    readonly shardA: Partial<KpiPayload>;
    readonly shardB: Partial<KpiPayload>;
    readonly pattern: RegExp;
  }>([
    {
      label: "chat_provider",
      shardA: { alaya_commit: "0000aaa", chat_provider: "none" },
      shardB: { alaya_commit: "0000bbb", chat_provider: "yunwu:gpt-5.4-mini" },
      pattern: /chat_provider=yunwu:gpt-5\.4-mini != shard\[0\] chat_provider=none/
    },
    {
      label: "policy_shape",
      shardA: { alaya_commit: "abc1234", policy_shape: "stress" },
      shardB: { alaya_commit: "abc1234", policy_shape: "chat" },
      pattern: /policy_shape=chat != shard\[0\] policy_shape=stress/
    },
    {
      label: "simulate_report",
      shardA: { alaya_commit: "abc1234", simulate_report: "none" },
      shardB: { alaya_commit: "abc1234", simulate_report: "mixed" },
      pattern: /simulate_report=mixed != shard\[0\] simulate_report=none/
    },
    {
      label: "seed_policy",
      shardA: { alaya_commit: "abc1234" },
      shardB: { alaya_commit: "abc1234", seed_policy: { mode: "rotating_object_kind", label_independent: true } },
      pattern: /seed_policy differs from shard\[0\]/
    },
    {
      label: "recall_weight_overrides",
      shardA: { alaya_commit: "abc1234", recall_weight_overrides: { source: "cli", fusion_weights: { lexical_fts: 0.5 } } },
      shardB: { alaya_commit: "abc1234", recall_weight_overrides: { source: "cli", fusion_weights: { lexical_fts: 0.6 } } },
      pattern: /recall_weight_overrides != shard\[0\] recall_weight_overrides/
    },
    {
      label: "split",
      shardA: { alaya_commit: "0000aaa" },
      shardB: { alaya_commit: "0000bbb", split: "longmemeval-oracle" },
      pattern: /split=longmemeval-oracle.*split=longmemeval-s/
    },
    {
      label: "sample_size",
      shardA: { alaya_commit: "0000aaa", sample_size: 500, evaluated_count: 5 },
      shardB: { alaya_commit: "0000bbb", sample_size: 250, evaluated_count: 5 },
      pattern: /sample_size=250 != shard\[0\] sample_size=500/
    },
    {
      label: "dataset identity",
      shardA: { alaya_commit: "abc1234" },
      shardB: { alaya_commit: "abc1234", dataset: { name: "longmemeval_s_tampered", size: 500, source: "https://example.com/fake" } },
      pattern: /dataset identity/
    },
    {
      label: "harness_mode",
      shardA: { alaya_commit: "0000aaa", harness_mode: "mcp_propose_review" },
      shardB: { alaya_commit: "0000bbb", harness_mode: "direct_db_seed" },
      pattern: /harness_mode=direct_db_seed != shard\[0\] harness_mode=mcp_propose_review/
    },
    {
      label: "embedding_provider",
      shardA: { alaya_commit: "0000aaa", embedding_provider: "none" },
      shardB: { alaya_commit: "0000bbb", embedding_provider: "yunwu:text-embedding-3-small" },
      pattern: /embedding_provider=yunwu:text-embedding-3-small != shard\[0\] embedding_provider=none/
    }
  ])("refuses shards whose $label differs", async ({ shardA: overrideA, shardB: overrideB, pattern }) => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(shardA, makeShardKpi(overrideA));
    await writeShardRoot(shardB, makeShardKpi({
      ...overrideB,
      kpi: { ...makeShardKpi().kpi, per_scenario: [{ id: "q-shard-b-1", version: 1, hit_at_5: true, tier: "warm" }] }
    }));
    expect(await mergeShards("history", [shardA, shardB])).toBe(2);
    expect(stderrBuf).toMatch(pattern);
  });
});
