import {
  KpiPayloadSchema,
  type KpiPayload
} from "../../schema/kpi-schema.js";
import { createLongMemEvalSelectionContractIdentity } from
  "../../schema/longmemeval-selection-contract.js";
import { VERIFIED_TEST_DATASET_SHA256 } from "./verified-dataset-fixture.js";

const FIXTURE_DATASET_SHA = VERIFIED_TEST_DATASET_SHA256;

export function makeSeedExtractionPath(
  input: Partial<NonNullable<KpiPayload["kpi"]["seed_extraction_path"]>> = {}
): NonNullable<KpiPayload["kpi"]["seed_extraction_path"]> {
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
    signals_dropped_by_reason: { candidate_absent: 1, materialization_drop: 0 },
    ...input
  };
}

export function buildPayload(commit: string): KpiPayload {
  return {
    bench_name: "self",
    split: "synthetic",
    run_at: "2026-05-14T10:00:00.000Z",
    alaya_commit: commit,
    alaya_version: "0.3.11",
    embedding_provider: "none",
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

export function buildLimitedTier1Payload(
  benchName: "public" | "public-multiturn" | "public-crossquestion",
  datasetName: string
): KpiPayload {
  return {
    ...buildPayload("abc1234"),
    bench_name: benchName,
    split: "longmemeval-s",
    dataset: { name: datasetName, size: 500, source: "fixture" },
    sample_size: 500,
    evaluated_count: 20
  };
}

export function buildLocomoPayload(
  sampleSize: number,
  evaluatedCount: number,
  rAt5: number
): KpiPayload {
  return {
    ...buildPayload("abc1234"),
    bench_name: "public-locomo",
    split: "locomo10",
    dataset: { name: "locomo10", size: 10, source: "fixture" },
    sample_size: sampleSize,
    evaluated_count: evaluatedCount,
    kpi: {
      ...buildPayload("abc1234").kpi,
      r_at_5: rAt5,
      latency_ms_p95: 110
    }
  };
}

export function eligibleMeasurementAttribution(): NonNullable<
  KpiPayload["measurement_attribution"]
> {
  return {
    schema_version: "bench-measurement-attribution.v3",
    status: "eligible",
    gate_eligible: true,
    evidence_status: "complete",
    candidate_pool_complete: true,
    provenance_complete: true,
    measurement_scope: "answerable_recall",
    abstention_evaluation_status: "excluded_not_evaluated",
    abstention_calibration_status: "uncalibrated",
    abstention_gate_eligible: false,
    abstention_evidence_status: "current_uncalibrated",
    evaluator_identity_status: "complete"
  };
}

export function legacyAbstention(): NonNullable<
  NonNullable<KpiPayload["kpi"]["quality_metrics"]>["abstention"]
> {
  return {
    schema_version: "bench-abstention.v1",
    total: 6,
    false_confident_threshold: 0.91,
    correct_at_1: 1,
    correct_at_5: 1,
    correct_at_10: 1,
    false_confident_at_1: 5,
    false_confident_at_5: 5,
    false_confident_at_10: 5
  };
}

export function passingQualityMetrics(
  denominator: number
): NonNullable<KpiPayload["kpi"]["quality_metrics"]> {
  const evidenceCount = Math.floor(denominator * 0.2);
  const pathCount = Math.floor(denominator * 0.12);
  const rate = (count: number): number => denominator === 0 ? 0 : count / denominator;
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
    high_lexical_demoted_denominator: denominator,
    candidate_absent_count: 0,
    candidate_absent_denominator: denominator,
    no_gold_count: 0,
    no_gold_denominator: denominator,
    evaluator_identity_issue_count: 0,
    evaluator_identity_issue_denominator: denominator,
    evaluator_identity_unscorable_count: 0,
    evaluator_identity_unscorable_denominator: denominator,
    evidence_stream_gold_delivery_rate: rate(evidenceCount),
    evidence_stream_gold_delivery_count: evidenceCount,
    evidence_stream_gold_delivery_denominator: denominator,
    path_stream_top10_rate: rate(pathCount),
    path_stream_top10_count: pathCount,
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
    miss_distribution: {}
  };
}

export function withEligibleMeasurementContract(payload: KpiPayload): KpiPayload {
  const evaluated = payload.evaluated_count;
  const hitCount = Math.round(payload.kpi.r_at_5 * evaluated);
  const missCount = evaluated - hitCount;
  const rows = Array.from({ length: evaluated }, (_, index) => ({
    id: `question-${index + 1}`,
    version: 1,
    hit_at_5: index < hitCount,
    scorable: true,
    measurement_cohort: "answerable" as const,
    tier: "hot" as const
  }));
  const datasetSha256 = payload.dataset.checksum_sha256 ?? FIXTURE_DATASET_SHA;
  return KpiPayloadSchema.parse({
    ...payload,
    dataset: { ...payload.dataset, checksum_sha256: datasetSha256 },
    answerable_evaluated_count: evaluated,
    measurement_attribution: eligibleMeasurementAttribution(),
    selection_contract: createLongMemEvalSelectionContractIdentity({
      datasetSha256,
      assignments: rows.map((row) => ({
        question_id: row.id,
        dataset_cohort: "answerable"
      }))
    }),
    kpi: {
      ...payload.kpi,
      per_scenario: rows,
      quality_metrics: {
        ...passingQualityMetrics(evaluated),
        measurement_cohort_counts: {
          evaluated,
          non_abstention: evaluated,
          abstention: 0,
          scorable_answerable: evaluated,
          unscorable_answerable: 0,
          hit_at_5: hitCount,
          miss_at_5: missCount
        },
        unscorable_reason_distribution: {},
        miss_taxonomy_distribution: {
          candidate_absent: 0,
          materialization_drop: 0,
          budget_drop: 0,
          delivery_order_drop: missCount,
          answer_set_coverage_drop: 0,
          evaluation_or_gold_issue: 0
        },
        abstention: {
          schema_version: "bench-abstention.v2",
          total: 0,
          scored: 0,
          unscorable: 0,
          method: "fused_margin_diagnostic_only",
          calibration_status: "uncalibrated",
          gate_eligible: false
        }
      }
    }
  });
}

export function buildReleaseGradePublic(
  seedExtractionPath?: KpiPayload["kpi"]["seed_extraction_path"]
): KpiPayload {
  const base = buildPayload("abc1234");
  return withEligibleMeasurementContract({
    ...base,
    bench_name: "public",
    split: "longmemeval-s",
    dataset: { name: "longmemeval_s", size: 500, source: "fixture" },
    sample_size: 500,
    evaluated_count: 500,
    kpi: {
      ...base.kpi,
      r_at_5: 0.95,
      latency_ms_p95: 110,
      ...(seedExtractionPath === undefined
        ? {}
        : { seed_extraction_path: seedExtractionPath })
    }
  });
}
