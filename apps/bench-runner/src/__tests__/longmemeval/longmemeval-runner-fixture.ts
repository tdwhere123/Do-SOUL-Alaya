import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { KpiPayload } from "@do-soul/alaya-eval";
import type { LongMemEvalQuestion } from "../../longmemeval/dataset.js";

export function buildMockQuestion(
  id: string,
  answerSessionId: string
): LongMemEvalQuestion {
  return {
    question_id: id,
    question_type: "single_session",
    question: `What did the user say about topic ${id}?`,
    answer: `The answer for ${id}`,
    question_date: "2026-01-01",
    haystack_session_ids: [answerSessionId, "decoy-session"],
    haystack_dates: ["2025-12-01", "2025-11-01"],
    haystack_sessions: [
      [
        { role: "user", content: `The correct fact about ${id} is stored here.`, has_answer: true },
        { role: "assistant", content: "Acknowledged." }
      ],
      [
        { role: "user", content: "Unrelated conversation about cooking pasta." }
      ]
    ],
    answer_session_ids: [answerSessionId]
  };
}

export function buildLongMemEvalArchivePayload(
  overrides: Partial<KpiPayload> = {}
): KpiPayload {
  return {
    bench_name: "public",
    split: "longmemeval-oracle",
    run_at: "2026-05-14T10:00:00.000Z",
    alaya_commit: "abc1234",
    alaya_version: "0.3.10-test",
    embedding_provider: "none",
    chat_provider: "none",
    policy_shape: "chat",
    simulate_report: "none",
    dataset: {
      name: "longmemeval_oracle",
      size: 2,
      source: "https://huggingface.co/datasets/xiaowu0162/longmemeval-cleaned"
    },
    sample_size: 2,
    evaluated_count: 2,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: 0,
      r_at_5: 0.5,
      r_at_10: 0.5,
      latency_ms_p50: 10,
      latency_ms_p95: 20,
      latency_source: "exact",
      token_saved_ratio_vs_full_prompt: 0,
      tier_distribution: { hot: 0, warm: 1, cold: 1 },
      degradation_reasons: {
        none: 2,
        warm_cascade_engaged: 0,
        cold_cascade_engaged: 0,
        recall_explainability_partial: 0
      },
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      seed_extraction_path: {
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
        signals_dropped_by_reason: { candidate_absent: 0, materialization_drop: 0 }
      },
      per_scenario: [
        { id: "q001", version: 1, hit_at_5: false, tier: "cold" },
        { id: "q002", version: 1, hit_at_5: true, tier: "warm" }
      ]
    },
    ...overrides
  };
}

export function makeEligibleMeasurementAttribution(): NonNullable<
  KpiPayload["measurement_attribution"]
> {
  return {
    schema_version: "bench-measurement-attribution.v2",
    status: "eligible",
    gate_eligible: true,
    evidence_status: "complete",
    candidate_pool_complete: true,
    provenance_complete: true,
    abstention_calibration_status: "not_applicable",
    evaluator_identity_status: "complete"
  };
}

export function withEligibleMeasurementContract(payload: KpiPayload): KpiPayload {
  const evaluated = payload.evaluated_count;
  return {
    ...payload,
    answerable_evaluated_count: evaluated,
    measurement_attribution: makeEligibleMeasurementAttribution(),
    kpi: {
      ...payload.kpi,
      seed_extraction_path: payload.kpi.seed_extraction_path === undefined
        ? undefined
        : { ...payload.kpi.seed_extraction_path, llm_calls: 0 },
      per_scenario: payload.kpi.per_scenario.length === evaluated
        ? payload.kpi.per_scenario.map((row) => ({ ...row, scorable: true }))
        : Array.from({ length: evaluated }, (_, index) => ({
            id: `question-${index + 1}`,
            version: 1,
            hit_at_5: index < Math.round(payload.kpi.r_at_5 * evaluated),
            scorable: true,
            tier: "warm" as const
          })),
      quality_metrics: currentQualityMetrics(evaluated)
    }
  };
}

function currentQualityMetrics(
  denominator: number
): NonNullable<KpiPayload["kpi"]["quality_metrics"]> {
  return {
    schema_version: "bench-quality-metrics.v1",
    non_monotonic_rate: 0,
    non_monotonic_count: 0,
    non_monotonic_denominator: denominator,
    budget_drop_distribution: {
      max_entries: { count: 0, share: 0, denominator }
    },
    high_lexical_demoted_rate: 0,
    high_lexical_demoted_count: 0,
    high_lexical_demoted_denominator: 0,
    candidate_absent_count: 0,
    candidate_absent_denominator: denominator,
    no_gold_count: 0,
    no_gold_denominator: denominator,
    evaluator_identity_issue_count: 0,
    evaluator_identity_issue_denominator: denominator,
    evaluator_identity_unscorable_count: 0,
    evaluator_identity_unscorable_denominator: denominator,
    evidence_stream_gold_delivery_rate: 0,
    evidence_stream_gold_delivery_count: 0,
    evidence_stream_gold_delivery_denominator: denominator,
    path_stream_top10_rate: 0,
    path_stream_top10_count: 0,
    path_stream_top10_denominator: denominator,
    per_plane_recall_coverage: {},
    miss_taxonomy_distribution: {
      candidate_absent: 0,
      materialization_drop: 0,
      budget_drop: 0,
      delivery_order_drop: 0,
      answer_set_coverage_drop: 0,
      evaluation_or_gold_issue: 0
    },
    miss_distribution: {},
    abstention: {
      schema_version: "bench-abstention.v2",
      total: 0,
      scored: 0,
      unscorable: 0,
      method: "fused_margin_diagnostic_only",
      calibration_status: "uncalibrated",
      gate_eligible: false
    }
  };
}

export async function writeArchiveEntry(
  historyRoot: string,
  benchName: KpiPayload["bench_name"],
  slug: string,
  payload: KpiPayload,
  findingsMarkdown: string | null = null
): Promise<void> {
  const entryRoot = join(historyRoot, benchName, slug);
  await mkdir(entryRoot, { recursive: true });
  await writeFile(
    join(entryRoot, "kpi.json"),
    JSON.stringify(payload, null, 2) + "\n",
    "utf8"
  );
  await writeFile(join(entryRoot, "report.md"), "report\n", "utf8");
  if (findingsMarkdown !== null) {
    await writeFile(join(entryRoot, "findings.md"), findingsMarkdown, "utf8");
  }
}

export function buildRecallResult(
  deliveryId: string,
  objectIds: readonly string[]
) {
  return {
    delivery_id: deliveryId,
    results: objectIds.map((objectId, index) => ({
      object_id: objectId,
      object_kind: "memory_entry",
      relevance_score: 0.9 - index * 0.1,
      content_preview: objectId,
      evidence_pointers: [objectId],
      selection_reason: "test",
      source_channels: [],
      score_factors: { relevance: 0.9 - index * 0.1 },
      budget_state: {
        token_estimate: 1,
        max_entries: 10,
        max_total_tokens: 2000,
        remaining_entries: 9 - index,
        remaining_tokens: 1999 - index,
        within_budget: true
      }
    })),
    total_count: objectIds.length,
    strategy_mix: {
      deterministic_match: true,
      precomputed_rank: true,
      semantic_supplement: false,
      graph_support: false,
      path_plasticity: false,
      global_recall: false
    },
    degradation_reason: null
  };
}
