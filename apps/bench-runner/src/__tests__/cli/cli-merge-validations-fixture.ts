import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KpiPayload } from "@do-soul/alaya-eval";
import {
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME
} from "../../longmemeval/archive-evidence.js";

export {
  LONGMEMEVAL_COLD_WARM_COMPARISON_FILENAME,
  LONGMEMEVAL_DIAGNOSTICS_FILENAME
};

export function makeShardKpi(overrides: Partial<KpiPayload> = {}): KpiPayload {
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
      seed_extraction_path: makeSeedExtractionPath(),
      per_scenario: [
        { id: "q-shard-default-1", version: 1, hit_at_5: true, tier: "warm" }
      ]
    },
    ...overrides
  };
}

export function makeQualityMetrics(
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
    per_plane_recall_coverage: {},
    miss_distribution: {
      budget_dropped: budgetDropped,
      candidate_absent: candidateAbsent
    }
  };
}

export function makeSeedExtractionPath(
  input: Partial<NonNullable<KpiPayload["kpi"]["seed_extraction_path"]>> = {}
): NonNullable<KpiPayload["kpi"]["seed_extraction_path"]> {
  return {
    path: "official_api_compile",
    cache_hits: 0,
    llm_calls: 1,
    offline_fallbacks: 0,
    live_extraction_failures: 0,
    cached_extraction_failures: 0,
    facts_produced: 5,
    signals_dropped: 0,
    parse_dropped: 0,
    compile_overflow_dropped: 0,
    signals_dropped_by_reason: { candidate_absent: 0, materialization_error: 0 },
    ...input
  };
}

export function makeShardDiagnostics(
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
      graph_expansion_plane_count_per_hop: [1, 0],
      graph_expansion_plane_count_per_edge_type: {
        derives_from: 0,
        recalls: 0,
        supports: 1
      },
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

export async function writeShardRoot(
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

export async function writeHistoryEntry(
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
