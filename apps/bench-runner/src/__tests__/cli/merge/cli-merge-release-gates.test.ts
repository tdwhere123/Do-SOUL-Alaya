import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { evaluateSeedExtractionReleaseBlocker, type KpiPayload } from "@do-soul/alaya-eval";
import { runMergeCli } from "./cli-merge-dataset-fixture.js";
import { mergeSeedExtractionPath } from "../../../cli/merge-shared.js";
import {
  makeQualityMetrics,
  makeSeedExtractionPath,
  makeShardDiagnostics,
  makeShardKpi,
  withEligibleMeasurementContract,
  writeHistoryEntry,
  writeShardRoot
} from "./cli-merge-validations-fixture.js";

describe("merge-longmemeval release gates", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(path.join(tmpdir(), "merge-validations-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  async function readRunOutputs(historyRoot: string) {
    const pointer = JSON.parse(await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")) as { slug: string };
    const dir = path.join(historyRoot, "public", pointer.slug);
    const merged = JSON.parse(await readFile(path.join(dir, "kpi.json"), "utf8")) as KpiPayload;
    const report = await readFile(path.join(dir, "report.md"), "utf8");
    const findings = await readFile(path.join(dir, "findings.md"), "utf8").catch(() => "");
    return { slug: pointer.slug, merged, report, findings };
  }

  it("writes policy-shape slugs without diffing an unverified matching baseline", async () => {
    const shard = path.join(tmpRoot, "shard-chat");
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `q-chat-${index + 1}`, version: 1, hit_at_5: index < 4, tier: "warm" as const
    }));
    await writeShardRoot(shard, makeShardKpi({
      alaya_commit: "abc1234", policy_shape: "chat",
      kpi: { ...makeShardKpi().kpi, r_at_5: 0.8, per_scenario: rows }
    }), makeShardDiagnostics());

    const historyRoot = path.join(tmpRoot, "history");
    await writeHistoryEntry(historyRoot, "2026-05-14T100000Z-abc1234-policy-stress", makeShardKpi({
      alaya_commit: "abc1234", policy_shape: "stress", kpi: { ...makeShardKpi().kpi, r_at_5: 1 }
    }));
    await writeHistoryEntry(
      historyRoot,
      "2026-05-14T100001Z-abc1234-policy-chat",
      withEligibleMeasurementContract(makeShardKpi({
        alaya_commit: "abc1234", policy_shape: "chat", kpi: { ...makeShardKpi().kpi, r_at_5: 0.4 }
      }))
    );
    await writeFile(
      path.join(historyRoot, "public", "latest-baseline.json"),
      JSON.stringify({ slug: "2026-05-14T100000Z-abc1234-policy-stress", kpi_path: "2026-05-14T100000Z-abc1234-policy-stress/kpi.json" }, null, 2) + "\n",
      "utf8"
    );

    expect(await runMergeCli(tmpRoot, ["merge-longmemeval", "--variant", "s", "--history-root", historyRoot, "--shards", shard])).toBe(1);
    const { slug, merged, report } = await readRunOutputs(historyRoot);
    expect(slug).toMatch(/-policy-chat(?:-wt-[0-9a-f]{64})?$/);
    expect(merged.policy_shape).toBe("chat");
    expect(merged.seed_policy?.mode).toBe("label_independent_all_fact");
    expect(report).toContain("Seed policy: label_independent_all_fact");
    expect(merged.diff_vs_previous).toBeNull();
    expect(report).toContain("_No previous baseline; this is the first entry._");
    expect(report).not.toContain("| r_at_5 | 1.0000 | 0.8000 |");
  });

  it("preserves merged seed extraction provenance and blocks degraded fallback evidence", async () => {
    const shardA = path.join(tmpRoot, "shard-official-seed-path");
    const shardB = path.join(tmpRoot, "shard-fallback-seed-path");
    const rows = (prefix: string) => Array.from({ length: 5 }, (_, index) => ({
      id: `${prefix}-${index + 1}`, version: 1, hit_at_5: true, tier: "warm" as const
    }));
    await writeShardRoot(shardA, makeShardKpi({
      evaluated_count: 5,
      kpi: {
        ...makeShardKpi().kpi, r_at_5: 1, per_scenario: rows("q-seed-official"),
        seed_extraction_path: makeSeedExtractionPath({ path: "official_api_compile", extraction_attempts: 3, cache_hits: 1, llm_calls: 2, facts_produced: 3 })
      }
    }));
    await writeShardRoot(shardB, makeShardKpi({
      evaluated_count: 5,
      kpi: {
        ...makeShardKpi().kpi, r_at_5: 1, per_scenario: rows("q-seed-fallback"),
        seed_extraction_path: makeSeedExtractionPath({ path: "no_credentials_fallback", llm_calls: 0, offline_fallbacks: 8, facts_produced: 9, signals_dropped: 2, parse_dropped: 1 })
      }
    }));

    const historyRoot = path.join(tmpRoot, "history-seed-extraction-path");
    expect(await runMergeCli(tmpRoot, ["merge-longmemeval", "--variant", "s", "--history-root", historyRoot, "--shards", shardA, shardB])).toBe(1);
    const { merged, report, findings } = await readRunOutputs(historyRoot);
    expect(merged.kpi.seed_extraction_path).toEqual({
      path: "no_credentials_fallback",
      extraction_attempts: 3, cache_hits: 1, llm_calls: 2, offline_fallbacks: 8,
      live_extraction_failures: 0, cached_extraction_failures: 0, facts_produced: 12,
      signals_dropped: 2, parse_dropped: 1, compile_overflow_dropped: 0,
      signals_dropped_by_reason: { candidate_absent: 0, materialization_drop: 0 }
    });
    expect(report).toContain("Seed extraction path: no_credentials_fallback");
    expect(report).toContain("Release evidence blockers");
    expect(findings).toContain("seed_extraction_path no_credentials_fallback");
  });

  it("blocks merged official seed extraction when any offline fallback occurs", async () => {
    const shardA = path.join(tmpRoot, "shard-official-clean-seed");
    const shardB = path.join(tmpRoot, "shard-official-offline-seed");
    const rows = (prefix: string) => Array.from({ length: 5 }, (_, index) => ({
      id: `${prefix}-${index + 1}`, version: 1, hit_at_5: true, tier: "warm" as const
    }));
    await writeShardRoot(shardA, makeShardKpi({
      evaluated_count: 5,
      kpi: {
        ...makeShardKpi().kpi, r_at_5: 1, per_scenario: rows("q-seed-clean"),
        seed_extraction_path: makeSeedExtractionPath({ path: "official_api_compile", cache_hits: 10, facts_produced: 20 })
      }
    }));
    await writeShardRoot(shardB, makeShardKpi({
      evaluated_count: 5,
      kpi: {
        ...makeShardKpi().kpi, r_at_5: 1, per_scenario: rows("q-seed-offline"),
        seed_extraction_path: makeSeedExtractionPath({
          path: "official_api_compile", cache_hits: 11, offline_fallbacks: 1,
          live_extraction_failures: 1, facts_produced: 21, signals_dropped: 4, parse_dropped: 3
        })
      }
    }));

    const historyRoot = path.join(tmpRoot, "history-seed-offline-fallback");
    expect(await runMergeCli(tmpRoot, ["merge-longmemeval", "--variant", "s", "--history-root", historyRoot, "--shards", shardA, shardB])).toBe(1);
    const { merged, report, findings } = await readRunOutputs(historyRoot);
    expect(merged.kpi.seed_extraction_path).toMatchObject({
      path: "official_api_compile", extraction_attempts: 21, cache_hits: 21, offline_fallbacks: 1,
      live_extraction_failures: 1, cached_extraction_failures: 0, facts_produced: 41, signals_dropped: 4, parse_dropped: 3
    });
    expect(report).toContain("Seed extraction path: official_api_compile");
    expect(report).toContain("Release evidence blockers");
    expect(findings).toContain("seed_extraction_path live_extraction_failures");
    expect(findings).toContain("offline_fallbacks=1");
    expect(findings).toContain("live_failures=1");
  });

  it("does not add an offline-fallback blocker when merged official extraction has none", async () => {
    const shardA = path.join(tmpRoot, "shard-official-zero-a");
    const shardB = path.join(tmpRoot, "shard-official-zero-b");
    const rows = (prefix: string) => Array.from({ length: 5 }, (_, index) => ({
      id: `${prefix}-${index + 1}`, version: 1, hit_at_5: true, tier: "warm" as const
    }));
    await writeShardRoot(shardA, makeShardKpi({
      evaluated_count: 5,
      kpi: {
        ...makeShardKpi().kpi, r_at_5: 1, per_scenario: rows("q-seed-zero-a"),
        seed_extraction_path: makeSeedExtractionPath({ path: "official_api_compile", cache_hits: 5, facts_produced: 10 })
      }
    }));
    await writeShardRoot(shardB, makeShardKpi({
      evaluated_count: 5,
      kpi: {
        ...makeShardKpi().kpi, r_at_5: 1, per_scenario: rows("q-seed-zero-b"),
        seed_extraction_path: makeSeedExtractionPath({ path: "official_api_compile", cache_hits: 6, facts_produced: 11 })
      }
    }));

    const historyRoot = path.join(tmpRoot, "history-seed-official-zero");
    expect(await runMergeCli(tmpRoot, ["merge-longmemeval", "--variant", "s", "--history-root", historyRoot, "--shards", shardA, shardB])).toBe(1);
    const { merged } = await readRunOutputs(historyRoot);
    expect(evaluateSeedExtractionReleaseBlocker(merged)).toBeNull();
  });

  it("keeps extraction attempts unknown when any shard predates the counter", () => {
    const complete = makeShardKpi();
    const { extraction_attempts: _omitted, ...legacyCounters } = makeSeedExtractionPath({ cache_hits: 2 });
    const legacy = makeShardKpi({ kpi: { ...makeShardKpi().kpi, seed_extraction_path: legacyCounters } });
    const mergedPath = mergeSeedExtractionPath([complete, legacy]);
    const merged = makeShardKpi({ kpi: { ...makeShardKpi().kpi, seed_extraction_path: mergedPath } });

    expect(mergedPath).toMatchObject({ cache_hits: 3 });
    expect(mergedPath?.extraction_attempts).toBeUndefined();
    expect(evaluateSeedExtractionReleaseBlocker(merged)).toMatchObject({
      id: "seed_extraction_path missing_extraction_attempts"
    });
  });

  it("returns non-zero when release hard gates fail without a previous baseline", async () => {
    const shardA = path.join(tmpRoot, "shard-gate-a");
    const shardB = path.join(tmpRoot, "shard-gate-b");
    const rows = (prefix: string, hits: number) => Array.from({ length: 50 }, (_, index) => ({
      id: `${prefix}-${index}`, version: 1, hit_at_5: index < hits, tier: "warm" as const
    }));
    await writeShardRoot(shardA, makeShardKpi({
      evaluated_count: 50,
      kpi: { ...makeShardKpi().kpi, r_at_5: 36 / 50, quality_metrics: makeQualityMetrics({ denominator: 50, budgetDropped: 4 }), per_scenario: rows("gate-a", 36) }
    }));
    await writeShardRoot(shardB, makeShardKpi({
      evaluated_count: 50,
      kpi: { ...makeShardKpi().kpi, r_at_5: 35 / 50, quality_metrics: makeQualityMetrics({ denominator: 50, budgetDropped: 5 }), per_scenario: rows("gate-b", 35) }
    }));

    const historyRoot = path.join(tmpRoot, "history-hard-gates");
    expect(await runMergeCli(tmpRoot, ["merge-longmemeval", "--variant", "s", "--history-root", historyRoot, "--shards", shardA, shardB])).toBe(1);
    const { report, findings } = await readRunOutputs(historyRoot);
    expect(report).toContain("Worst verdict: **FAIL**");
    expect(report).toContain("longmemeval_s_budget_dropped_rate budget_dropped_share (9/100 max_entries): 9.00% > target 2.00%");
    expect(findings).toContain("Release hard gate gaps");
  });

  it("fails the hard gate when max_entries budget drop share exceeds the target even without direct hit loss", async () => {
    const shardA = path.join(tmpRoot, "shard-gate-drops-a");
    const shardB = path.join(tmpRoot, "shard-gate-drops-b");
    const rows = (prefix: string) => Array.from({ length: 50 }, (_, index) => ({
      id: `${prefix}-${index + 1}`, version: 1, hit_at_5: index < 40, tier: "hot" as const
    }));
    const metricsA = makeQualityMetrics({ denominator: 50, budgetDropped: 5 });
    const metricsB = makeQualityMetrics({ denominator: 50, budgetDropped: 4 });
    metricsA.miss_distribution.budget_dropped = 0;
    metricsB.miss_distribution.budget_dropped = 0;
    await writeShardRoot(shardA, makeShardKpi({
      evaluated_count: 50, kpi: { ...makeShardKpi().kpi, r_at_5: 40 / 50, quality_metrics: metricsA, per_scenario: rows("q-gate-drops-a") }
    }));
    await writeShardRoot(shardB, makeShardKpi({
      evaluated_count: 50, kpi: { ...makeShardKpi().kpi, r_at_5: 40 / 50, quality_metrics: metricsB, per_scenario: rows("q-gate-drops-b") }
    }));

    const historyRoot = path.join(tmpRoot, "history-budget-entry-gate");
    expect(await runMergeCli(tmpRoot, ["merge-longmemeval", "--variant", "s", "--history-root", historyRoot, "--shards", shardA, shardB])).toBe(1);
    const { report } = await readRunOutputs(historyRoot);
    expect(report).toContain("longmemeval_s_budget_dropped_rate budget_dropped_share (9/100 max_entries): 9.00% > target 2.00%");
  });
});
