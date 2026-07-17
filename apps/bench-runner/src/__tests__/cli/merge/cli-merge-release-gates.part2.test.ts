import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KpiPayload } from "@do-soul/alaya-eval";

import { runCli } from "../../../cli/index.js";

import {
  makeQualityMetrics,
  makeSeedExtractionPath,
  makeShardDiagnostics,
  makeShardKpi,
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

  it("returns non-zero when release hard gates fail without a previous baseline", async () => {
    const shardA = path.join(tmpRoot, "shard-gate-a");
    const shardB = path.join(tmpRoot, "shard-gate-b");
    const rowsA = Array.from({ length: 50 }, (_, index) => ({
      id: `gate-a-${index}`,
      version: 1,
      hit_at_5: index < 36,
      tier: "warm" as const
    }));
    const rowsB = Array.from({ length: 50 }, (_, index) => ({
      id: `gate-b-${index}`,
      version: 1,
      hit_at_5: index < 35,
      tier: "warm" as const
    }));
    await writeShardRoot(
      shardA,
      makeShardKpi({
        evaluated_count: 50,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 36 / 50,
          quality_metrics: makeQualityMetrics({
            denominator: 50,
            budgetDropped: 4
          }),
          per_scenario: rowsA
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        evaluated_count: 50,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 35 / 50,
          quality_metrics: makeQualityMetrics({
            denominator: 50,
            budgetDropped: 5
          }),
          per_scenario: rowsB
        }
      })
    );
    const historyRoot = path.join(tmpRoot, "history-hard-gates");
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
    const report = await readFile(
      path.join(historyRoot, "public", pointer.slug, "report.md"),
      "utf8"
    );
    const findings = await readFile(
      path.join(historyRoot, "public", pointer.slug, "findings.md"),
      "utf8"
    );
    expect(report).toContain("Worst verdict: **FAIL**");
    expect(report).toContain(
      "longmemeval_s_budget_dropped_rate budget_dropped_share (9/100 max_entries): 9.00% > target 2.00%"
    );
    expect(findings).toContain("Release hard gate gaps");
  });

  it("fails the hard gate when max_entries budget drop share exceeds the target even without direct hit loss", async () => {
    const shardA = path.join(tmpRoot, "shard-gate-drops-a");
    const shardB = path.join(tmpRoot, "shard-gate-drops-b");
    const rowsA = Array.from({ length: 50 }, (_, index) => ({
      id: `q-gate-drops-a-${index + 1}`,
      version: 1,
      hit_at_5: index < 40,
      tier: "hot" as const
    }));
    const rowsB = Array.from({ length: 50 }, (_, index) => ({
      id: `q-gate-drops-b-${index + 1}`,
      version: 1,
      hit_at_5: index < 40,
      tier: "hot" as const
    }));
    const metricsA = makeQualityMetrics({
      denominator: 50,
      budgetDropped: 5
    });
    const metricsB = makeQualityMetrics({
      denominator: 50,
      budgetDropped: 4
    });
    metricsA.miss_distribution.budget_dropped = 0;
    metricsB.miss_distribution.budget_dropped = 0;
    await writeShardRoot(
      shardA,
      makeShardKpi({
        evaluated_count: 50,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 40 / 50,
          quality_metrics: metricsA,
          per_scenario: rowsA
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        evaluated_count: 50,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 40 / 50,
          quality_metrics: metricsB,
          per_scenario: rowsB
        }
      })
    );

    const historyRoot = path.join(tmpRoot, "history-budget-entry-gate");
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
    const report = await readFile(
      path.join(historyRoot, "public", pointer.slug, "report.md"),
      "utf8"
    );
    expect(report).toContain(
      "longmemeval_s_budget_dropped_rate budget_dropped_share (9/100 max_entries): 9.00% > target 2.00%"
    );
  });
});
