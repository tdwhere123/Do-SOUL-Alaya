import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import type { KpiPayload } from "../../schema/kpi-schema.js";

export function buildPayload(commit: string): KpiPayload {
  return {
    bench_name: "self",
    split: "synthetic",
    run_at: "2026-05-14T10:00:00.000Z",
    alaya_commit: commit,
    alaya_version: "0.3.6",
    embedding_provider: "local-heuristic",
    chat_provider: "n/a",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: { name: "synthetic", size: 12, source: "internal" },
    sample_size: 10,
    evaluated_count: 10,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: 0.6,
      r_at_5: 0.85,
      r_at_10: 0.9,
      latency_ms_p50: 60,
      latency_ms_p95: 110,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: 0.88,
      tier_distribution: { hot: 50, warm: 30, cold: 20 },
      degradation_reasons: {
        none: 80,
        warm_cascade_engaged: 12,
        cold_cascade_engaged: 8,
        recall_explainability_partial: 0
      },
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      per_scenario: []
    }
  };
}

export function passingQualityMetrics(): NonNullable<KpiPayload["kpi"]["quality_metrics"]> {
  return {
    schema_version: "bench-quality-metrics.v1",
    non_monotonic_rate: 0,
    non_monotonic_count: 0,
    non_monotonic_denominator: 100,
    budget_drop_distribution: {
      max_entries: {
        count: 0,
        share: 0,
        denominator: 100
      }
    },
    high_lexical_demoted_rate: 0,
    high_lexical_demoted_count: 0,
    high_lexical_demoted_denominator: 0,
    candidate_absent_count: 0,
    candidate_absent_denominator: 100,
    no_gold_count: 0,
    no_gold_denominator: 100,
    evidence_stream_gold_delivery_rate: 0.2,
    evidence_stream_gold_delivery_count: 20,
    evidence_stream_gold_delivery_denominator: 100,
    path_stream_top10_rate: 0.12,
    path_stream_top10_count: 12,
    path_stream_top10_denominator: 100,
    per_plane_recall_coverage: {},
    miss_distribution: {}
  };
}

export function perCallStat(value: number) {
  return { mean: value, p50: value, p95: value, max: value };
}

// @anchor seed-extraction-release-blocker
// invariant: release-grade LongMemEval archives require
// seed_extraction_path provenance; missing the field on these benches
// is treated as degraded and blocked from latest_passing.
export function cleanSeedExtractionPath(): NonNullable<
  KpiPayload["kpi"]["seed_extraction_path"]
> {
  return {
    path: "official_api_compile",
    cache_hits: 276,
    llm_calls: 0,
    offline_fallbacks: 0,
    live_extraction_failures: 0,
    cached_extraction_failures: 0,
    facts_produced: 1872,
    signals_dropped: 4,
    parse_dropped: 3,
    compile_overflow_dropped: 0,
    signals_dropped_by_reason: { candidate_absent: 1, materialization_drop: 0 }
  };
}

export function buildFullLongMemEvalPayload(
  benchName: "public" | "public-multiturn" | "public-crossquestion",
  commit: string,
  rAt5: number
): KpiPayload {
  return {
    ...buildPayload(commit),
    alaya_version: "0.3.11",
    bench_name: benchName,
    split: "longmemeval-s",
    embedding_provider: "none",
    dataset: {
      name:
        benchName === "public"
          ? "longmemeval_s"
          : benchName === "public-multiturn"
            ? "longmemeval_s:multiturn"
            : "longmemeval_s:crossquestion",
      size: 500,
      source: "fixture"
    },
    sample_size: 500,
    evaluated_count: 500,
    kpi: {
      ...buildPayload(commit).kpi,
      r_at_5: rAt5,
      latency_ms_p95: 120,
      quality_metrics: passingQualityMetrics(),
      seed_extraction_path: cleanSeedExtractionPath()
    }
  };
}

export function buildLivePayload(commit: string): KpiPayload {
  return {
    ...buildPayload(commit),
    alaya_version: "0.3.11",
    bench_name: "live",
    split: "strict-real",
    dataset: {
      name: "alaya-live-strict-real",
      size: 500,
      source: "var/checks/alaya-live/main-check.json#run-1"
    },
    sample_size: 500,
    evaluated_count: 500,
    harness_mode: "live_strict_real"
  };
}

export function buildLocomoPayload(
  commit: string,
  sampleSize: number,
  evaluatedCount: number,
  rAt5: number
): KpiPayload {
  return {
    ...buildPayload(commit),
    alaya_version: "0.3.11",
    bench_name: "public-locomo",
    split: "locomo10",
    embedding_provider: "none",
    dataset: {
      name: "locomo10",
      size: 10,
      source: "fixture"
    },
    sample_size: sampleSize,
    evaluated_count: evaluatedCount,
    kpi: {
      ...buildPayload(commit).kpi,
      r_at_5: rAt5,
      latency_ms_p95: 110
    }
  };
}

export async function writePointerlessPayload(
  historyRoot: string,
  benchName: KpiPayload["bench_name"],
  slug: string,
  payload: KpiPayload,
  findingsMarkdown: string | null = null
): Promise<void> {
  const entryRoot = path.join(historyRoot, benchName, slug);
  await mkdir(entryRoot, { recursive: true });
  await writeFile(path.join(entryRoot, "kpi.json"), JSON.stringify(payload, null, 2) + "\n", "utf8");
  await writeFile(path.join(entryRoot, "report.md"), "report\n", "utf8");
  if (findingsMarkdown !== null) {
    await writeFile(path.join(entryRoot, "findings.md"), findingsMarkdown, "utf8");
  }
}

export async function writeBenchPointer(
  historyRoot: string,
  benchName: KpiPayload["bench_name"],
  filename: string,
  slug: string
): Promise<void> {
  await writeFile(
    path.join(historyRoot, benchName, filename),
    JSON.stringify({ slug, kpi_path: path.join(slug, "kpi.json") }, null, 2) + "\n",
    "utf8"
  );
}

export async function plantSchemaInvalidArchive(root: string, slug: string): Promise<void> {
  const invalid = {
    ...buildPayload("0ff0ff0"),
    kpi: {
      ...buildPayload("0ff0ff0").kpi,
      per_scenario: [
        {
          id: "q-47",
          version: 1,
          hit_at_5: true,
          tier: "hot",
          latency_ms: -5507
        }
      ]
    }
  };
  const entryRoot = path.join(root, "self", slug);
  await mkdir(entryRoot, { recursive: true });
  await writeFile(
    path.join(entryRoot, "kpi.json"),
    JSON.stringify(invalid, null, 2) + "\n",
    "utf8"
  );
  await writeFile(path.join(entryRoot, "report.md"), "report\n", "utf8");
}
