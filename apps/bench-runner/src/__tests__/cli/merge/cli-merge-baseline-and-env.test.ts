import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KpiPayload } from "@do-soul/alaya-eval";
import { runMergeCli } from "./cli-merge-dataset-fixture.js";
import {
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME,
  makeShardDiagnostics,
  makeShardKpi,
  withEligibleMeasurementContract,
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

  it("does not diff merged shards against an unverified simulate_report baseline", async () => {
    const shard = path.join(tmpRoot, "shard-chat-mixed");
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `q-chat-mixed-${index + 1}`,
      version: 1,
      hit_at_5: index < 4,
      tier: "warm" as const
    }));
    await writeShardRoot(shard, makeShardKpi({
      alaya_commit: "abc1234",
      policy_shape: "chat",
      simulate_report: "mixed",
      kpi: { ...makeShardKpi().kpi, r_at_5: 0.8, per_scenario: rows }
    }), makeShardDiagnostics());

    const historyRoot = path.join(tmpRoot, "history-simulate-report");
    await writeHistoryEntry(historyRoot, "2026-05-14T100000Z-abc1234-policy-chat", makeShardKpi({
      alaya_commit: "abc1234", policy_shape: "chat", simulate_report: "none", kpi: { ...makeShardKpi().kpi, r_at_5: 1 }
    }));
    await writeFile(
      path.join(historyRoot, "public", "2026-05-14T100000Z-abc1234-policy-chat", LONGMEMEVAL_DIAGNOSTICS_FILENAME),
      JSON.stringify(makeShardDiagnostics({
        simulate_report: "none",
        report_side_effects: undefined,
        scored_recall_evidence: {
          delivered_result_count: 2, graph_support_gold_count: 0, path_plasticity_gold_count: 0,
          graph_expansion_plane_count: 0, path_expansion_plane_count: 0,
          delivered_plane_counts: { first_admitted: {}, winning_admission: {} },
          gold_source_channel_counts: {}, gold_source_plane_counts: {}
        }
      }), null, 2) + "\n",
      "utf8"
    );
    await writeHistoryEntry(
      historyRoot,
      "2026-05-14T100001Z-abc1234-policy-chat-report-mixed",
      withEligibleMeasurementContract(makeShardKpi({
        alaya_commit: "abc1234", policy_shape: "chat", simulate_report: "mixed", kpi: { ...makeShardKpi().kpi, r_at_5: 0.4 }
      }))
    );
    await writeFile(
      path.join(historyRoot, "public", "latest-baseline.json"),
      JSON.stringify({ slug: "2026-05-14T100000Z-abc1234-policy-chat", kpi_path: "2026-05-14T100000Z-abc1234-policy-chat/kpi.json" }, null, 2) + "\n",
      "utf8"
    );

    expect(await runMergeCli(tmpRoot, ["merge-longmemeval", "--variant", "s", "--history-root", historyRoot, "--shards", shard])).toBe(1);
    const pointer = JSON.parse(await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")) as { slug: string };
    expect(pointer.slug).toMatch(/-policy-chat-report-mixed(?:-wt-[0-9a-f]{64})?$/);

    const merged = JSON.parse(await readFile(path.join(historyRoot, "public", pointer.slug, "kpi.json"), "utf8")) as KpiPayload;
    const report = await readFile(path.join(historyRoot, "public", pointer.slug, "report.md"), "utf8");
    const diagnostics = JSON.parse(
      await readFile(path.join(historyRoot, "public", pointer.slug, LONGMEMEVAL_DIAGNOSTICS_FILENAME), "utf8")
    ) as {
      report_usage?: { reports_attempted: number };
      scored_recall_evidence?: {
        graph_support_gold_count: number;
        graph_expansion_plane_count_per_hop: [number, number];
        graph_expansion_plane_count_per_edge_type: { derives_from: number; recalls: number; supports: number };
      };
      provider_state_summary: { total: number; provider_not_requested: number };
      question_count: number;
      full_diagnostics_artifact_path: string;
      questions?: Array<{ question_id: string }>;
    };
    expect(merged.simulate_report).toBe("mixed");
    expect(merged.diff_vs_previous).toBeNull();
    expect(report).toContain("_No previous baseline; this is the first entry._");
    expect(report).not.toContain("| r_at_5 | 1.0000 | 0.8000 |");
    expect(diagnostics.report_usage?.reports_attempted).toBe(1);
    expect(diagnostics.scored_recall_evidence?.graph_support_gold_count).toBe(1);
    expect(diagnostics.scored_recall_evidence?.graph_expansion_plane_count_per_hop).toEqual([1, 0]);
    expect(diagnostics.scored_recall_evidence?.graph_expansion_plane_count_per_edge_type).toEqual({
      derives_from: 0, recalls: 0, supports: 1
    });
    expect(diagnostics.provider_state_summary.total).toBe(5);
    expect(diagnostics.provider_state_summary.provider_not_requested).toBe(5);
    expect(diagnostics.question_count).toBe(5);
    expect(diagnostics.questions?.map((question) => question.question_id)).toEqual(rows.map((row) => row.id));
    expect(diagnostics.full_diagnostics_artifact_path).not.toContain("docs/bench-history");

    const comparison = JSON.parse(
      await readFile(path.join(historyRoot, "public", pointer.slug, LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME), "utf8")
    ) as {
      current: {
        simulate_report: string;
        report_side_effects: { recalls_edge_count: number } | null;
        scored_recall_evidence: {
          graph_support_gold_count: number;
          graph_expansion_plane_count_per_hop: [number, number];
          graph_expansion_plane_count_per_edge_type: { derives_from: number; recalls: number; supports: number };
        } | null;
      };
      opposite: {
        simulate_report: string;
        r_at_5: number;
        scored_recall_evidence: {
          graph_expansion_plane_count_per_hop: [number, number];
          graph_expansion_plane_count_per_edge_type: { derives_from: number; recalls: number; supports: number };
        } | null;
      } | null;
      delta_current_minus_opposite: {
        r_at_5: number;
        report_side_effects: { recalls_edge_count: number | null };
        scored_recall_evidence: {
          graph_support_gold_count: number | null;
          graph_expansion_plane_count_per_hop: [number | null, number | null];
          graph_expansion_plane_count_per_edge_type: { derives_from: number | null; recalls: number | null; supports: number | null };
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
      derives_from: 0, recalls: 0, supports: 0
    });
    expect(comparison.delta_current_minus_opposite?.r_at_5).toBeCloseTo(-0.2);
    expect(comparison.delta_current_minus_opposite?.report_side_effects.recalls_edge_count).toBeNull();
    expect(comparison.delta_current_minus_opposite?.scored_recall_evidence.graph_support_gold_count).toBe(1);
    expect(comparison.delta_current_minus_opposite?.scored_recall_evidence.graph_expansion_plane_count_per_hop).toEqual([1, 0]);
    expect(comparison.delta_current_minus_opposite?.scored_recall_evidence.graph_expansion_plane_count_per_edge_type).toEqual({
      derives_from: 0, recalls: 0, supports: 1
    });
  }, 20_000);

  it.each<{
    readonly label: string;
    readonly shardA: Partial<KpiPayload>;
    readonly shardB: Partial<KpiPayload>;
    readonly pattern: RegExp;
  }>([
    {
      label: "bench_name",
      shardA: { alaya_commit: "0000aaa", bench_name: "public" },
      shardB: { alaya_commit: "0000bbb", bench_name: "self" },
      pattern: /bench_name=self != shard\[0\] bench_name=public/
    },
    {
      label: "alaya_commit",
      shardA: { alaya_commit: "abc1234" },
      shardB: { alaya_commit: "def5678" },
      pattern: /alaya_commit=def5678 != shard\[0\] alaya_commit=abc1234/
    },
    {
      label: "alaya_version",
      shardA: { alaya_commit: "0000aaa", alaya_version: "0.3.6" },
      shardB: { alaya_commit: "0000bbb", alaya_version: "0.3.8" },
      pattern: /alaya_version=0\.3\.8 != shard\[0\] alaya_version=0\.3\.6/
    }
  ])("refuses shards whose $label differs", async ({ shardA: overrideA, shardB: overrideB, pattern }) => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(shardA, makeShardKpi(overrideA));
    await writeShardRoot(shardB, makeShardKpi({
      ...overrideB,
      kpi: { ...makeShardKpi().kpi, per_scenario: [{ id: "q-shard-b-1", version: 1, hit_at_5: true, tier: "warm" }] }
    }));
    const exitCode = await runMergeCli(tmpRoot, [
      "merge-longmemeval", "--variant", "s", "--history-root", path.join(tmpRoot, "history"), "--shards", shardA, shardB
    ]);
    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(pattern);
  });

  it("refuses shards whose evaluated_total exceeds dataset sample_size", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(shardA, makeShardKpi({
      alaya_commit: "abc1234", sample_size: 10, evaluated_count: 8,
      kpi: { ...makeShardKpi().kpi, per_scenario: [{ id: "qA-1", version: 1, hit_at_5: true, tier: "warm" }] }
    }));
    await writeShardRoot(shardB, makeShardKpi({
      alaya_commit: "abc1234", sample_size: 10, evaluated_count: 8,
      kpi: { ...makeShardKpi().kpi, per_scenario: [{ id: "qB-1", version: 1, hit_at_5: true, tier: "warm" }] }
    }));
    const exitCode = await runMergeCli(tmpRoot, [
      "merge-longmemeval", "--variant", "s", "--history-root", path.join(tmpRoot, "history"), "--shards", shardA, shardB
    ]);
    expect(exitCode).toBe(2);
    expect(stderrBuf).toMatch(/evaluated_total=16 > sample_size=10/);
  });

  it("merges env provider-rate KPIs by evaluated count and cache rates by cache counts", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    const rowsFor = (prefix: string, hits: number) => Array.from({ length: 5 }, (_, index) => ({
      id: `${prefix}-${index + 1}`, version: 1, hit_at_5: index < hits, tier: "warm" as const
    }));
    await writeShardRoot(shardA, makeShardKpi({
      alaya_commit: "abc1234",
      embedding_provider: "yunwu:text-embedding-3-small",
      evaluated_count: 5,
      kpi: {
        ...makeShardKpi().kpi,
        r_at_5: 0.8, r_at_5_overall: 0.8, r_at_5_with_embedding_returned: 2 / 3,
        provider_returned_rate: 3 / 5, provider_pending_rate: 1 / 5, provider_failed_rate: 1 / 5,
        embedding_vector_cache_ready_rate: 1, query_embedding_cache_ready_rate: 1,
        per_scenario: rowsFor("qA", 4)
      }
    }), makeShardDiagnostics({
      embedding_provider: "yunwu:text-embedding-3-small",
      embedding_mode: "env",
      embedding_vector_cache: { expected_count: 50, ready_count: 50, not_ready_count: 0, ready_rate: 1, max_pass_count: 2 },
      query_embedding_cache: { requested_count: 5, ready_count: 5, not_ready_count: 0, ready_rate: 1, cache_hit_count: 0, provider_requested_count: 5 }
    }));
    await writeShardRoot(shardB, makeShardKpi({
      alaya_commit: "abc1234",
      embedding_provider: "yunwu:text-embedding-3-small",
      evaluated_count: 5,
      kpi: {
        ...makeShardKpi().kpi,
        r_at_5: 0.6, r_at_5_overall: 0.6, r_at_5_with_embedding_returned: 1,
        provider_returned_rate: 2 / 5, provider_pending_rate: 2 / 5, provider_failed_rate: 1 / 5,
        embedding_vector_cache_ready_rate: 1, query_embedding_cache_ready_rate: 1,
        per_scenario: rowsFor("qB", 3)
      }
    }), makeShardDiagnostics({
      embedding_provider: "yunwu:text-embedding-3-small",
      embedding_mode: "env",
      embedding_vector_cache: { expected_count: 100, ready_count: 0, not_ready_count: 100, ready_rate: 0, max_pass_count: 3 },
      query_embedding_cache: { requested_count: 15, ready_count: 0, not_ready_count: 15, ready_rate: 0, cache_hit_count: 1, provider_requested_count: 14 }
    }));
    const historyRoot = path.join(tmpRoot, "history");
    expect(await runMergeCli(tmpRoot, [
      "merge-longmemeval", "--variant", "s", "--history-root", historyRoot, "--shards", shardA, shardB
    ])).toBe(1);

    const pointer = JSON.parse(await readFile(path.join(historyRoot, "public", "latest-run.json"), "utf8")) as { slug: string };
    const merged = JSON.parse(await readFile(path.join(historyRoot, "public", pointer.slug, "kpi.json"), "utf8")) as KpiPayload;
    expect(merged.kpi.r_at_5).toBe(0.7);
    expect(merged.kpi.r_at_5_overall).toBe(0.7);
    expect(merged.kpi.provider_returned_rate).toBe(0.5);
    expect(merged.kpi.provider_pending_rate).toBe(0.3);
    expect(merged.kpi.provider_failed_rate).toBe(0.2);
    // Fields absent from every shard stay unavailable instead of becoming zero.
    expect(merged.kpi.provider_not_requested_rate).toBeUndefined();
    expect(merged.kpi.query_embedding_unusable_rate).toBeUndefined();
    // Legacy rates do not bind the returned-and-scorable denominator.
    expect(merged.kpi.r_at_5_with_embedding_returned).toBeUndefined();
    expect(merged.kpi.embedding_vector_cache_ready_rate).toBe(50 / 150);
    expect(merged.kpi.query_embedding_cache_ready_rate).toBe(5 / 20);

    const diagnostics = JSON.parse(
      await readFile(path.join(historyRoot, "public", pointer.slug, LONGMEMEVAL_DIAGNOSTICS_FILENAME), "utf8")
    ) as {
      embedding_vector_cache?: { expected_count: number; max_pass_count: number };
      query_embedding_cache?: { requested_count: number; ready_count: number; cache_hit_count: number; provider_requested_count: number };
    };
    expect(diagnostics.embedding_vector_cache).toMatchObject({ expected_count: 150, ready_count: 50, max_pass_count: 3 });
    expect(diagnostics.query_embedding_cache).toMatchObject({
      requested_count: 20, ready_count: 5, cache_hit_count: 1, provider_requested_count: 19
    });
  }, 20_000);
});
