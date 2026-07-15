import type { KpiPayload } from "@do-soul/alaya-eval";
import { RECALL_EVAL_ARCHIVE_MARKER } from "../../../longmemeval/recall-eval-archive.js";
import { snapshotQuestionIdDigest } from "../../../longmemeval/snapshot.js";
import { withEligibleMeasurementContract } from "../longmemeval-runner-fixture.js";
import { VERIFIED_TEST_DATASET_SHA256 } from
  "../../../../../../packages/eval/src/__tests__/gates/verified-dataset-fixture.js";

function passingQualityMetrics(): NonNullable<KpiPayload["kpi"]["quality_metrics"]> {
  return {
    schema_version: "bench-quality-metrics.v1",
    non_monotonic_rate: 0,
    non_monotonic_count: 0,
    non_monotonic_denominator: 100,
    budget_drop_distribution: {
      max_entries: { count: 0, share: 0, denominator: 100 }
    },
    high_lexical_demoted_rate: 0,
    high_lexical_demoted_count: 0,
    high_lexical_demoted_denominator: 0,
    candidate_absent_count: 0,
    candidate_absent_denominator: 100,
    no_gold_count: 0,
    no_gold_denominator: 100,
    evaluator_identity_issue_count: 0,
    evaluator_identity_issue_denominator: 100,
    evaluator_identity_unscorable_count: 0,
    evaluator_identity_unscorable_denominator: 100,
    evidence_stream_gold_delivery_rate: 0.2,
    evidence_stream_gold_delivery_count: 20,
    evidence_stream_gold_delivery_denominator: 100,
    path_stream_top10_rate: 0.12,
    path_stream_top10_count: 12,
    path_stream_top10_denominator: 100,
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

function cleanSeedExtractionPath(): NonNullable<KpiPayload["kpi"]["seed_extraction_path"]> {
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

export function buildPublicPayload(input: {
  readonly commit: string;
  readonly rAt5: number;
  readonly recallEval: boolean;
}): KpiPayload {
  return withEligibleMeasurementContract({
    bench_name: "public",
    split: "longmemeval-oracle",
    run_at: "2026-05-20T10:00:00.000Z",
    alaya_commit: input.commit,
    alaya_version: "0.3.11",
    embedding_provider: "none",
    chat_provider: "none",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: {
      name: "longmemeval_oracle",
      size: 500,
      source: "fixture",
      checksum_sha256: VERIFIED_TEST_DATASET_SHA256,
      checksum_source: input.recallEval
        ? `${RECALL_EVAL_ARCHIVE_MARKER} snapshot.db`
        : "pinned longmemeval_oracle.meta.json"
    },
    sample_size: 500,
    evaluated_count: 500,
    harness_mode: "mcp_propose_review",
    kpi: {
      r_at_1: 0.6,
      r_at_5: input.rAt5,
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
      quality_metrics: passingQualityMetrics(),
      seed_extraction_path: cleanSeedExtractionPath(),
      seed_truncation: {
        seed_turns_truncated: 0,
        answer_turns_truncated: 0,
        seed_chars_clipped: 0
      },
      per_scenario: Array.from({ length: 500 }, (_, index) => ({
        id: `q-${index + 1}`,
        version: 1,
        hit_at_5: index < Math.round(input.rAt5 * 500),
        tier: "hot" as const
      }))
    }
  });
}

export function withAnswerRerank(
  payload: KpiPayload,
  answerRerank: NonNullable<KpiPayload["recall_eval_attribution"]>["answer_rerank"]
): KpiPayload {
  const questionIdDigest = snapshotQuestionIdDigest(
    payload.kpi.per_scenario.map((row) => ({ questionId: row.id }))
  );
  return {
    ...payload,
    recall_eval_attribution: {
      status: "attributed",
      gate_eligible: true,
      node_version: process.version,
      platform: process.platform,
      arch: process.arch,
      embedding_mode: "disabled",
      embedding_provider_kind: "openai",
      embedding_provider_label: "none",
      onnx_threads: null,
      onnx_model_artifact_sha256: null,
      embedding_supplement: { enabled: false },
      answer_rerank: answerRerank,
      recall_config: {
        schema_version: 2,
        max_results: 10,
        conflict_awareness: true,
        effective_config_sha256: "e".repeat(64)
      },
      evaluation_slice: {
        offset: 0,
        limit: null,
        evaluated_count: payload.evaluated_count,
        question_id_digest: questionIdDigest
      },
      hydration_binding: {
        dataset_sha256: "a".repeat(64),
        source: "external_expected_sha256"
      },
      snapshot_binding: {
        commit_sha7: "1".repeat(7),
        gate_sha256: "2".repeat(64),
        worktree_state_sha256: "3".repeat(64),
        extraction_cache_manifest_sha256: "4".repeat(64),
        extraction_cache_requested_turns: 10,
        extraction_cache_cached_turns: 10,
        extraction_cache_coverage: 1,
        dataset_sha256: "a".repeat(64),
        question_id_digest: questionIdDigest,
        snapshot_manifest_sha256: "9".repeat(64),
        producer_recall_pipeline_version: "producer-v1",
        consumer_recall_pipeline_version: "consumer-v1",
        producer_schema_migration_version: 1
      }
    }
  };
}

export function withBiIdentity(
  payload: KpiPayload,
  input: Readonly<{
    artifact: string;
    schema: number;
    d2q: "raw_content" | "content_plus_hq";
  }>
): KpiPayload {
  const attributed = withAnswerRerank(payload, {
    enabled: true,
    provider_kind: "local_onnx_cross_encoder",
    effective_model_id: "Xenova/reranker",
    model_artifact_sha256: "b".repeat(64)
  });
  return {
    ...attributed,
    embedding_provider: "local_onnx:Xenova/bi",
    recall_pipeline_version: "consumer-v1",
    recall_eval_attribution: {
      ...attributed.recall_eval_attribution!,
      embedding_mode: "env",
      embedding_provider_kind: "local_onnx",
      embedding_provider_label: "local_onnx:Xenova/bi",
      onnx_threads: 2,
      onnx_model_artifact_sha256: input.artifact,
      embedding_supplement: {
        enabled: true,
        provider_kind: "local_onnx",
        effective_model_id: "Xenova/bi",
        model_artifact_sha256: input.artifact,
        effective_schema_version: input.schema,
        d2q_input: input.d2q
      }
    }
  };
}
