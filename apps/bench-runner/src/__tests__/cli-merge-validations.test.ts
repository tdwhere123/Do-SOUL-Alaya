import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { KpiPayload } from "@do-soul/alaya-eval";
import { runCli } from "../cli.js";
import {
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME
} from "../longmemeval/archive-evidence.js";

// @anchor merge-validation-tests: see apps/bench-runner/src/cli.ts
// @anchor merge-shard-validations. Each test sets up two shard roots
// containing minimally-valid kpi.json files and invokes the
// merge-longmemeval subcommand. The merge must reject incompatible
// shards BEFORE any per_scenario aggregation runs.

function makeShardKpi(overrides: Partial<KpiPayload> = {}): KpiPayload {
  return {
    bench_name: "public",
    split: "longmemeval-s",
    run_at: "2026-05-14T10:00:00.000Z",
    alaya_commit: "abc1234",
    alaya_version: "0.3.6",
    embedding_provider: "none",
    chat_provider: "none",
    policy_shape: "stress",
    simulate_report: "none",
    seed_policy: {
      mode: "label_independent_all_fact",
      label_independent: true,
      object_kind: "fact"
    },
    dataset: {
      name: "longmemeval_s",
      size: 500,
      source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned"
    },
    sample_size: 500,
    evaluated_count: 5,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: 0.6,
      r_at_5: 0.8,
      r_at_10: 0.9,
      latency_ms_p50: 10,
      latency_ms_p95: 20,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: 0,
      tier_distribution: { hot: 0, warm: 5, cold: 0 },
      degradation_reasons: {
        none: 5,
        warm_cascade_engaged: 0,
        cold_cascade_engaged: 0,
        recall_explainability_partial: 0
      },
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      quality_metrics: makeQualityMetrics(),
      per_scenario: [
        { id: "q-shard-default-1", version: 1, hit_at_5: true, tier: "warm" }
      ]
    },
    ...overrides
  };
}

function makeQualityMetrics(
  input: {
    readonly denominator?: number;
    readonly budgetDropped?: number;
    readonly candidateAbsent?: number;
    readonly nonMonotonic?: number;
  } = {}
): NonNullable<KpiPayload["kpi"]["quality_metrics"]> {
  const denominator = input.denominator ?? 5;
  const budgetDropped = input.budgetDropped ?? 0;
  const candidateAbsent = input.candidateAbsent ?? 0;
  const nonMonotonic = input.nonMonotonic ?? 0;
  return {
    schema_version: "bench-quality-metrics.v1",
    non_monotonic_rate: denominator === 0 ? 0 : nonMonotonic / denominator,
    non_monotonic_count: nonMonotonic,
    non_monotonic_denominator: denominator,
    budget_drop_distribution: {
      max_entries: {
        count: budgetDropped,
        share: denominator === 0 ? 0 : budgetDropped / denominator,
        denominator
      }
    },
    high_lexical_demoted_rate: 0,
    high_lexical_demoted_count: 0,
    high_lexical_demoted_denominator: 0,
    candidate_absent_count: candidateAbsent,
    candidate_absent_denominator: denominator,
    no_gold_count: 0,
    no_gold_denominator: denominator,
    evidence_stream_gold_delivery_rate: 0.2,
    evidence_stream_gold_delivery_count: Math.ceil(denominator * 0.2),
    evidence_stream_gold_delivery_denominator: denominator,
    path_stream_top10_rate: 0.2,
    path_stream_top10_count: Math.ceil(denominator * 0.2),
    path_stream_top10_denominator: denominator,
    miss_distribution: {
      budget_dropped: budgetDropped,
      candidate_absent: candidateAbsent
    }
  };
}

function makeShardDiagnostics(
  overrides: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    schema_version: 1,
    bench_name: "public",
    split: "longmemeval-s",
    run_at: "2026-05-14T10:00:00.000Z",
    alaya_commit: "abc1234",
    embedding_provider: "none",
    embedding_mode: "disabled",
    policy_shape: "chat",
    simulate_report: "mixed",
    report_usage: {
      mode: "mixed",
      reports_attempted: 1,
      reports_used: 1,
      reports_skipped: 0,
      used_object_count: 2
    },
    report_side_effects: {
      mode: "mixed",
      workspaces_observed: 1,
      memory_graph_edges_total: 2,
      memory_graph_edges_by_type: { recalls: 2 },
      recalls_edge_count: 2,
      path_relations_total: 0,
      latest_path_event_at: null,
      snapshots: [
        {
          question_id: "q-chat-mixed-1",
          workspace_id: "workspace-1",
          memory_graph_edges_total: 2,
          memory_graph_edges_by_type: { recalls: 2 },
          recalls_edge_count: 2,
          path_relations_total: 0,
          latest_path_event_at: null,
          warnings: ["path_relations_empty"]
        }
      ]
    },
    scored_recall_evidence: {
      delivered_result_count: 2,
      graph_support_gold_count: 1,
      path_plasticity_gold_count: 0,
      graph_expansion_plane_count: 1,
      path_expansion_plane_count: 0,
      delivered_plane_counts: {
        first_admitted: { graph_expansion: 1, lexical: 1 },
        winning_admission: { graph_expansion: 1, lexical: 1 }
      },
      gold_source_channel_counts: { graph_support: 1 },
      gold_source_plane_counts: { graph_expansion: 1 }
    },
    provider_state_summary: {
      total: 1,
      provider_returned: 0,
      provider_pending: 0,
      provider_failed: 0,
      provider_not_requested: 1,
      unknown: 0,
      provider_returned_rate: 0,
      provider_pending_rate: 0,
      provider_failed_rate: 0,
      provider_not_requested_rate: 1,
      unknown_rate: 0
    },
    questions: [],
    ...overrides
  };
}

type ShardPointerKind = "run" | "passing" | "baseline";

async function writeShardRoot(
  root: string,
  kpi: KpiPayload,
  diagnostics?: unknown,
  pointerKinds: readonly ShardPointerKind[] = ["run"]
): Promise<void> {
  const slug = "2026-05-14T100000Z-" + kpi.alaya_commit;
  const entryRoot = path.join(root, "public", slug);
  await mkdir(entryRoot, { recursive: true });
  await writeFile(
    path.join(entryRoot, "kpi.json"),
    JSON.stringify(kpi, null, 2) + "\n",
    "utf8"
  );
  await writeFile(path.join(entryRoot, "report.md"), "report\n", "utf8");
  if (diagnostics !== undefined) {
    await writeFile(
      path.join(entryRoot, LONGMEMEVAL_DIAGNOSTICS_FILENAME),
      JSON.stringify(diagnostics, null, 2) + "\n",
      "utf8"
    );
  }
  const pointerBody =
    JSON.stringify({ slug, kpi_path: `${slug}/kpi.json` }, null, 2) + "\n";
  const pointerFilenames: Record<ShardPointerKind, string> = {
    run: "latest-run.json",
    passing: "latest-passing.json",
    baseline: "latest-baseline.json"
  };
  for (const pointerKind of pointerKinds) {
    await writeFile(
      path.join(root, "public", pointerFilenames[pointerKind]),
      pointerBody,
      "utf8"
    );
  }
}

async function writeHistoryEntry(
  root: string,
  slug: string,
  kpi: KpiPayload,
  findingsMarkdown: string | null = null
): Promise<void> {
  const entryRoot = path.join(root, "public", slug);
  await mkdir(entryRoot, { recursive: true });
  await writeFile(
    path.join(entryRoot, "kpi.json"),
    JSON.stringify(kpi, null, 2) + "\n",
    "utf8"
  );
  await writeFile(path.join(entryRoot, "report.md"), "report\n", "utf8");
  if (findingsMarkdown !== null) {
    await writeFile(path.join(entryRoot, "findings.md"), findingsMarkdown, "utf8");
  }
}

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
    expect(merged.evaluated_count).toBe(10);
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

    expect(exitCode).toBe(0);
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
      makeShardKpi({
        run_at: priorPassingRunAt,
        alaya_commit: "aaa1111",
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0.9
        }
      })
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

  it("refuses shards whose split differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(shardA, makeShardKpi({ alaya_commit: "0000aaa" }));
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "0000bbb",
        split: "longmemeval-oracle",
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
    expect(stderrBuf).toMatch(/split=longmemeval-oracle.*split=longmemeval-s/);
  });

  it("refuses shards whose sample_size differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({
        alaya_commit: "0000aaa",
        sample_size: 500,
        evaluated_count: 5
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "0000bbb",
        sample_size: 250,
        evaluated_count: 5,
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
    expect(stderrBuf).toMatch(/sample_size=250 != shard\[0\] sample_size=500/);
  });

  it("refuses shards whose dataset identity differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    // Same alaya_commit so scalar-identity loop reaches the dataset
    // composite check (dataset is not in SCALAR_IDENTITY_FIELDS).
    await writeShardRoot(shardA, makeShardKpi({ alaya_commit: "abc1234" }));
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "abc1234",
        dataset: {
          name: "longmemeval_s_tampered",
          size: 500,
          source: "https://example.com/fake"
        },
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
    expect(stderrBuf).toMatch(/dataset identity/);
  });

  it("refuses shards whose duplicate question ids overlap", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    const dupId = "q-collide";
    // Same alaya_commit for both shards so the new alaya_commit check
    // does not fire first; the test exercises the duplicate-id branch.
    await writeShardRoot(
      shardA,
      makeShardKpi({
        alaya_commit: "abc1234",
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: dupId, version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "abc1234",
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: dupId, version: 1, hit_at_5: false, tier: "warm" }
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
    expect(stderrBuf).toMatch(/duplicate question_id 'q-collide'/);
  });

  it("refuses shards whose harness_mode differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({ alaya_commit: "0000aaa", harness_mode: "mcp_propose_review" })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "0000bbb",
        harness_mode: "direct_db_seed",
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
      /harness_mode=direct_db_seed != shard\[0\] harness_mode=mcp_propose_review/
    );
  });

  it("refuses shards whose embedding_provider differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({ alaya_commit: "0000aaa", embedding_provider: "none" })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "0000bbb",
        embedding_provider: "yunwu:text-embedding-3-small",
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
      /embedding_provider=yunwu:text-embedding-3-small != shard\[0\] embedding_provider=none/
    );
  });

  it("refuses shards whose chat_provider differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({ alaya_commit: "0000aaa", chat_provider: "none" })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "0000bbb",
        chat_provider: "yunwu:gpt-5.4-mini",
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
      /chat_provider=yunwu:gpt-5.4-mini != shard\[0\] chat_provider=none/
    );
  });

  it("refuses shards whose policy_shape differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({ alaya_commit: "abc1234", policy_shape: "stress" })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "abc1234",
        policy_shape: "chat",
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
      /policy_shape=chat != shard\[0\] policy_shape=stress/
    );
  });

  it("refuses shards whose simulate_report mode differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({ alaya_commit: "abc1234", simulate_report: "none" })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "abc1234",
        simulate_report: "mixed",
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
      /simulate_report=mixed != shard\[0\] simulate_report=none/
    );
  });

  it("refuses shards whose seed policy differs", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(shardA, makeShardKpi({ alaya_commit: "abc1234" }));
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "abc1234",
        seed_policy: {
          mode: "rotating_object_kind",
          label_independent: true
        },
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
    expect(stderrBuf).toMatch(/seed_policy differs from shard\[0\]/);
  });

  it("refuses shards whose recall weight overrides differ", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    await writeShardRoot(
      shardA,
      makeShardKpi({
        alaya_commit: "abc1234",
        recall_weight_overrides: {
          source: "cli",
          fusion_weights: { lexical_fts: 0.5 }
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "abc1234",
        recall_weight_overrides: {
          source: "cli",
          fusion_weights: { lexical_fts: 0.6 }
        },
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
    expect(stderrBuf).toMatch(/recall_weight_overrides != shard\[0\] recall_weight_overrides/);
  });

  it("writes merged policy-shape slugs and diffs against the matching policy baseline", async () => {
    const shard = path.join(tmpRoot, "shard-chat");
    const rows = Array.from({ length: 5 }, (_, index) => ({
      id: `q-chat-${index + 1}`,
      version: 1,
      hit_at_5: index < 4,
      tier: "warm" as const
    }));
    await writeShardRoot(
      shard,
      makeShardKpi({
        alaya_commit: "abc1234",
        policy_shape: "chat",
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0.8,
          per_scenario: rows
        }
      }),
      makeShardDiagnostics()
    );

    const historyRoot = path.join(tmpRoot, "history");
    await writeHistoryEntry(
      historyRoot,
      "2026-05-14T100000Z-abc1234-policy-stress",
      makeShardKpi({
        alaya_commit: "abc1234",
        policy_shape: "stress",
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 1
        }
      })
    );
    await writeHistoryEntry(
      historyRoot,
      "2026-05-14T100001Z-abc1234-policy-chat",
      makeShardKpi({
        alaya_commit: "abc1234",
        policy_shape: "chat",
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0.4
        }
      })
    );
    await writeFile(
      path.join(historyRoot, "public", "latest-baseline.json"),
      JSON.stringify(
        {
          slug: "2026-05-14T100000Z-abc1234-policy-stress",
          kpi_path: "2026-05-14T100000Z-abc1234-policy-stress/kpi.json"
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
    expect(pointer.slug).toMatch(/-policy-chat$/);

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
    expect(merged.policy_shape).toBe("chat");
    expect(merged.seed_policy?.mode).toBe("label_independent_all_fact");
    expect(report).toContain("Seed policy: label_independent_all_fact");
    expect(report).toContain("| r_at_5 | 0.4000 | 0.8000 | +0.4000 |");
    expect(report).not.toContain("| r_at_5 | 1.0000 | 0.8000 |");
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
      "longmemeval_s_budget_dropped_max_entries budget_dropped_entries: 9 > target 8"
    );
    expect(findings).toContain("Release hard gate gaps");
  });

  it("fails the hard gate when max_entries budget drops exceed the target even without direct hit loss", async () => {
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
      "longmemeval_s_budget_dropped_max_entries budget_dropped_entries: 9 > target 8"
    );
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
    await writeHistoryEntry(
      historyRoot,
      "2026-05-14T100001Z-abc1234-policy-chat-report-mixed",
      makeShardKpi({
        alaya_commit: "abc1234",
        policy_shape: "chat",
        simulate_report: "mixed",
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0.4
        }
      })
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
      scored_recall_evidence?: { graph_support_gold_count: number };
      provider_state_summary: { total: number; provider_not_requested: number };
      question_count: number;
      full_diagnostics_artifact_path: string;
      questions?: unknown[];
    };
    expect(merged.simulate_report).toBe("mixed");
    expect(report).toContain("| r_at_5 | 0.4000 | 0.8000 | +0.4000 |");
    expect(report).not.toContain("| r_at_5 | 1.0000 | 0.8000 |");
    expect(diagnostics.report_usage?.reports_attempted).toBe(1);
    expect(diagnostics.scored_recall_evidence?.graph_support_gold_count).toBe(1);
    expect(diagnostics.provider_state_summary.total).toBe(0);
    expect(diagnostics.provider_state_summary.provider_not_requested).toBe(0);
    expect(diagnostics.question_count).toBe(0);
    expect(diagnostics.questions).toBeUndefined();
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
        scored_recall_evidence: { graph_support_gold_count: number } | null;
      };
      opposite: { simulate_report: string; r_at_5: number } | null;
      delta_current_minus_opposite: {
        r_at_5: number;
        report_side_effects: { recalls_edge_count: number | null };
        scored_recall_evidence: { graph_support_gold_count: number | null };
      } | null;
    };
    expect(comparison.current.simulate_report).toBe("mixed");
    expect(comparison.current.report_side_effects?.recalls_edge_count).toBe(2);
    expect(comparison.current.scored_recall_evidence?.graph_support_gold_count).toBe(1);
    expect(comparison.opposite?.simulate_report).toBe("none");
    expect(comparison.opposite?.r_at_5).toBe(1);
    expect(comparison.delta_current_minus_opposite?.r_at_5).toBeCloseTo(-0.2);
    expect(
      comparison.delta_current_minus_opposite?.report_side_effects.recalls_edge_count
    ).toBeNull();
    expect(
      comparison.delta_current_minus_opposite?.scored_recall_evidence.graph_support_gold_count
    ).toBeNull();
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
    await writeShardRoot(
      shardA,
      makeShardKpi({ alaya_commit: "abc1234" })
    );
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

  it("refuses shards whose evaluated_total exceeds dataset sample_size", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    // Same alaya_commit so the test exercises the evaluated_total cap,
    // not the alaya_commit equality check (which runs earlier).
    await writeShardRoot(
      shardA,
      makeShardKpi({
        alaya_commit: "abc1234",
        sample_size: 10,
        evaluated_count: 8,
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "qA-1", version: 1, hit_at_5: true, tier: "warm" }
          ]
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "abc1234",
        sample_size: 10,
        evaluated_count: 8,
        kpi: {
          ...makeShardKpi().kpi,
          per_scenario: [
            { id: "qB-1", version: 1, hit_at_5: true, tier: "warm" }
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
    expect(stderrBuf).toMatch(/evaluated_total=16 > sample_size=10/);
  });

  it("merges env provider-rate KPIs by evaluated count and cache rates by cache counts", async () => {
    const shardA = path.join(tmpRoot, "shard-a");
    const shardB = path.join(tmpRoot, "shard-b");
    const rowsA = Array.from({ length: 5 }, (_, index) => ({
      id: `qA-${index + 1}`,
      version: 1,
      hit_at_5: index < 4,
      tier: "warm" as const
    }));
    const rowsB = Array.from({ length: 5 }, (_, index) => ({
      id: `qB-${index + 1}`,
      version: 1,
      hit_at_5: index < 3,
      tier: "warm" as const
    }));
    await writeShardRoot(
      shardA,
      makeShardKpi({
        alaya_commit: "abc1234",
        embedding_provider: "yunwu:text-embedding-3-small",
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0.8,
          r_at_5_overall: 0.8,
          r_at_5_with_embedding_returned: 2 / 3,
          provider_returned_rate: 3 / 5,
          provider_pending_rate: 1 / 5,
          provider_failed_rate: 1 / 5,
          embedding_vector_cache_ready_rate: 1,
          query_embedding_cache_ready_rate: 1,
          per_scenario: rowsA
        }
      }),
      makeShardDiagnostics({
        embedding_provider: "yunwu:text-embedding-3-small",
        embedding_mode: "env",
        embedding_vector_cache: {
          expected_count: 50,
          ready_count: 50,
          not_ready_count: 0,
          ready_rate: 1,
          max_pass_count: 2
        },
        query_embedding_cache: {
          requested_count: 5,
          ready_count: 5,
          not_ready_count: 0,
          ready_rate: 1,
          cache_hit_count: 0,
          provider_requested_count: 5
        }
      })
    );
    await writeShardRoot(
      shardB,
      makeShardKpi({
        alaya_commit: "abc1234",
        embedding_provider: "yunwu:text-embedding-3-small",
        evaluated_count: 5,
        kpi: {
          ...makeShardKpi().kpi,
          r_at_5: 0.6,
          r_at_5_overall: 0.6,
          r_at_5_with_embedding_returned: 1,
          provider_returned_rate: 2 / 5,
          provider_pending_rate: 2 / 5,
          provider_failed_rate: 1 / 5,
          // Deliberately inconsistent with diagnostics. Merged cache KPIs
          // must use cache denominators, not evaluated question counts or
          // shard-level scalar claims.
          embedding_vector_cache_ready_rate: 1,
          query_embedding_cache_ready_rate: 1,
          per_scenario: rowsB
        }
      }),
      makeShardDiagnostics({
        embedding_provider: "yunwu:text-embedding-3-small",
        embedding_mode: "env",
        embedding_vector_cache: {
          expected_count: 100,
          ready_count: 0,
          not_ready_count: 100,
          ready_rate: 0,
          max_pass_count: 3
        },
        query_embedding_cache: {
          requested_count: 15,
          ready_count: 0,
          not_ready_count: 15,
          ready_rate: 0,
          cache_hit_count: 1,
          provider_requested_count: 14
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
    expect(merged.kpi.r_at_5).toBe(0.7);
    expect(merged.kpi.r_at_5_overall).toBe(0.7);
    expect(merged.kpi.provider_returned_rate).toBe(0.5);
    expect(merged.kpi.provider_pending_rate).toBe(0.3);
    expect(merged.kpi.provider_failed_rate).toBe(0.2);
    expect(merged.kpi.r_at_5_with_embedding_returned).toBe(0.8);
    expect(merged.kpi.embedding_vector_cache_ready_rate).toBe(50 / 150);
    expect(merged.kpi.query_embedding_cache_ready_rate).toBe(5 / 20);

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
      embedding_vector_cache?: { expected_count: number; max_pass_count: number };
      query_embedding_cache?: {
        requested_count: number;
        ready_count: number;
        cache_hit_count: number;
        provider_requested_count: number;
      };
    };
    expect(diagnostics.embedding_vector_cache).toMatchObject({
      expected_count: 150,
      ready_count: 50,
      max_pass_count: 3
    });
    expect(diagnostics.query_embedding_cache).toMatchObject({
      requested_count: 20,
      ready_count: 5,
      cache_hit_count: 1,
      provider_requested_count: 19
    });
  });
});
