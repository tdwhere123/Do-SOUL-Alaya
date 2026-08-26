import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KpiPayload } from "@do-soul/alaya-eval";

import { runMergeCli } from "./cli-merge-dataset-fixture.js";

import { LONGMEMEVAL_DIAGNOSTICS_FILENAME } from "./cli-merge-validations-fixture.js";
import {
  makeQualityMetrics,
  makeShardDiagnostics,
  makeShardKpi,
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
    const exitCode = await runMergeCli(tmpRoot, [
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
  }, MERGE_ARCHIVE_TEST_TIMEOUT_MS);

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
    const exitCode = await runMergeCli(tmpRoot, [
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
  }, MERGE_ARCHIVE_TEST_TIMEOUT_MS);

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
    const exitCode = await runMergeCli(tmpRoot, [
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
    const exitCode = await runMergeCli(tmpRoot, [
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
  }, MERGE_ARCHIVE_TEST_TIMEOUT_MS);

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

    const exitCode = await runMergeCli(tmpRoot, [
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

    const exitCode = await runMergeCli(tmpRoot, [
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
