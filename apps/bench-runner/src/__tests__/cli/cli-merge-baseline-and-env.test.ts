import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";

import { tmpdir } from "node:os";

import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { KpiPayload } from "@do-soul/alaya-eval";

import { runCli } from "../../cli/index.js";

import {
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  withEligibleMeasurementContract,
  makeShardDiagnostics,
  makeShardKpi,
  writeHistoryEntry,
  writeShardRoot
} from "./cli-merge-validations-fixture.js";

describe("merge-longmemeval baseline and env aggregation", () => {

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

  it("diffs merged shards against the matching simulate_report baseline", async () => {
    const shard = path.join(tmpRoot, "shard-chat-mixed");
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `q-chat-mixed-${index + 1}`,
      version: 1,
      hit_at_5: index < 4,
      tier: "warm" as const
    }));
    await writeShardRoot(
      shard,
      makeShardKpi({
        alaya_commit: "abc1234",
        policy_shape: "chat",
        simulate_report: "mixed",
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0.8,
          per_scenario: rows
        }
      }),
      makeShardDiagnostics()
    );

    const historyRoot = path.join(tmpRoot, "history-simulate-report");
    await writeHistoryEntry(
      historyRoot,
      "2026-05-14T100000Z-abc1234-policy-chat",
      makeShardKpi({
        alaya_commit: "abc1234",
        policy_shape: "chat",
        simulate_report: "none",
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 1
        }
      })
    );
    await writeFile(
      path.join(
        historyRoot,
        "public",
        "2026-05-14T100000Z-abc1234-policy-chat",
        LONGMEMEVAL_DIAGNOSTICS_FILENAME
      ),
      JSON.stringify(
        makeShardDiagnostics({
          simulate_report: "none",
          report_side_effects: undefined,
          scored_recall_evidence: {
            delivered_result_count: 2,
            graph_support_gold_count: 0,
            path_plasticity_gold_count: 0,
            graph_expansion_plane_count: 0,
            path_expansion_plane_count: 0,
            delivered_plane_counts: {
              first_admitted: {},
              winning_admission: {}
            },
            gold_source_channel_counts: {},
            gold_source_plane_counts: {}
          }
        }),
        null,
        2
      ) + "\n",
      "utf8"
    );
    await writeHistoryEntry(
      historyRoot,
      "2026-05-14T100001Z-abc1234-policy-chat-report-mixed",
      withEligibleMeasurementContract(makeShardKpi({
        alaya_commit: "abc1234",
        policy_shape: "chat",
        simulate_report: "mixed",
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0.4
        }
      }))
    );
    await writeFile(
      path.join(historyRoot, "public", "latest-baseline.json"),
      JSON.stringify(
        {
          slug: "2026-05-14T100000Z-abc1234-policy-chat",
          kpi_path: "2026-05-14T100000Z-abc1234-policy-chat/kpi.json"
        },
        null,
        2
      ) + "\n",
      "utf8"
    );

    const exitCode = await runCli([
      "merge-longmemeval",
      "--variant",
      "s",
      "--history-root",
      historyRoot,
      "--shards",
      shard
    ]);
    expect(exitCode).toBe(0);

    const pointer = JSON.parse(
      await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")
    ) as { slug: string };
    expect(pointer.slug).toMatch(/-policy-chat-report-mixed$/);

    const merged = JSON.parse(
      await readFile(
        path.join(historyRoot, "public", pointer.slug, "kpi.json"),
        "utf8"
      )
    ) as KpiPayload;
    const report = await readFile(
      path.join(historyRoot, "public", pointer.slug, "report.md"),
      "utf8"
    );
    const diagnostics = JSON.parse(
      await readFile(
        path.join(
          historyRoot,
          "public",
          pointer.slug,
          LONGMEMEVAL_DIAGNOSTICS_FILENAME
        ),
        "utf8"
      )
    ) as {
      report_usage?: { reports_attempted: number };
      scored_recall_evidence?: {
        graph_support_gold_count: number;
        graph_expansion_plane_count_per_hop: [number, number];
        graph_expansion_plane_count_per_edge_type: {
          derives_from: number;
          recalls: number;
          supports: number;
        };
      };
      provider_state_summary: { total: number; provider_not_requested: number };
      question_count: number;
      full_diagnostics_artifact_path: string;
      questions?: Array<{ question_id: string }>;
    };
    expect(merged.simulate_report).toBe("mixed");
    expect(report).toContain("| r_at_5 | 0.4000 | 0.8000 | +0.4000 |");
    expect(report).not.toContain("| r_at_5 | 1.0000 | 0.8000 |");
    expect(diagnostics.report_usage?.reports_attempted).toBe(1);
    expect(diagnostics.scored_recall_evidence?.graph_support_gold_count).toBe(1);
    expect(diagnostics.scored_recall_evidence?.graph_expansion_plane_count_per_hop).toEqual([1, 0]);
    expect(diagnostics.scored_recall_evidence?.graph_expansion_plane_count_per_edge_type).toEqual({
      derives_from: 0,
      recalls: 0,
      supports: 1
    });
    expect(diagnostics.provider_state_summary.total).toBe(5);
    expect(diagnostics.provider_state_summary.provider_not_requested).toBe(5);
    expect(diagnostics.question_count).toBe(5);
    expect(diagnostics.questions?.map((question) => question.question_id)).toEqual(
      rows.map((row) => row.id)
    );
    expect(diagnostics.full_diagnostics_artifact_path).not.toContain(
      "docs/bench-history"
    );
    const comparison = JSON.parse(
      await readFile(
        path.join(
          historyRoot,
          "public",
          pointer.slug,
          LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME
        ),
        "utf8"
      )
    ) as {
      current: {
        simulate_report: string;
        report_side_effects: { recalls_edge_count: number } | null;
        scored_recall_evidence: {
          graph_support_gold_count: number;
          graph_expansion_plane_count_per_hop: [number, number];
          graph_expansion_plane_count_per_edge_type: {
            derives_from: number;
            recalls: number;
            supports: number;
          };
        } | null;
      };
      opposite: {
        simulate_report: string;
        r_at_5: number;
        scored_recall_evidence: {
          graph_expansion_plane_count_per_hop: [number, number];
          graph_expansion_plane_count_per_edge_type: {
            derives_from: number;
            recalls: number;
            supports: number;
          };
        } | null;
      } | null;
      delta_current_minus_opposite: {
        r_at_5: number;
        report_side_effects: { recalls_edge_count: number | null };
        scored_recall_evidence: {
          graph_support_gold_count: number | null;
          graph_expansion_plane_count_per_hop: [number | null, number | null];
          graph_expansion_plane_count_per_edge_type: {
            derives_from: number | null;
            recalls: number | null;
            supports: number | null;
          };
        };
      } | null;
    };
    expect(comparison.current.simulate_report).toBe("mixed");
    expect(comparison.current.report_side_effects?.recalls_edge_count).toBe(2);
    expect(comparison.current.scored_recall_evidence?.graph_support_gold_count).toBe(1);
    expect(comparison.current.scored_recall_evidence?.graph_expansion_plane_count_per_hop).toEqual([1, 0]);
    expect(comparison.opposite?.simulate_report).toBe("none");
    expect(comparison.opposite?.r_at_5).toBe(1);
    expect(comparison.opposite?.scored_recall_evidence?.graph_expansion_plane_count_per_hop).toEqual([0, 0]);
    expect(comparison.opposite?.scored_recall_evidence?.graph_expansion_plane_count_per_edge_type).toEqual({
      derives_from: 0,
      recalls: 0,
      supports: 0
    });
    expect(comparison.delta_current_minus_opposite?.r_at_5).toBeCloseTo(-0.2);
    expect(
      comparison.delta_current_minus_opposite?.report_side_effects.recalls_edge_count
    ).toBeNull();
    expect(
      comparison.delta_current_minus_opposite?.scored_recall_evidence.graph_support_gold_count
    ).toBe(1);
    expect(
      comparison.delta_current_minus_opposite?.scored_recall_evidence.graph_expansion_plane_count_per_hop
    ).toEqual([1, 0]);
    expect(
      comparison.delta_current_minus_opposite?.scored_recall_evidence.graph_expansion_plane_count_per_edge_type
    ).toEqual({
      derives_from: 0,
      recalls: 0,
      supports: 1
    });
  });

  it("refuses shards whose bench_name differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({ alaya_commit: "0000aaa", bench_name: "public" })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "0000bbb",
        bench_name: "self",
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "q-shard-b-1", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      })
    );
    const historyRoot = path.join(tmpRoot, "history");
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
    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/bench_name=self != shard\[0\] bench_name=public/);
  });

  it("refuses shards whose alaya_commit differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(shardA, makeShardKpi({ alaya_commit: "abc1234" }));
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "def5678",
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "q-shard-b-1", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      })
    );
    const historyRoot = path.join(tmpRoot, "history");
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
    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(
      /alaya_commit=def5678 != shard\[0\] alaya_commit=abc1234/
    );
  });

  it("refuses shards whose alaya_version differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({ alaya_commit: "0000aaa", alaya_version: "0.3.6" })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "0000bbb",
        alaya_version: "0.3.8",
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "q-shard-b-1", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      })
    );
    const historyRoot = path.join(tmpRoot, "history");
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
    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(
      /alaya_version=0.3.8 != shard\[0\] alaya_version=0.3.6/
    );
  });
});
