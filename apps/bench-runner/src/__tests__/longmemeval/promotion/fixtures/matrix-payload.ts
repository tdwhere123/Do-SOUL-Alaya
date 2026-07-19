import { DEFAULT_LOCAL_ONNX_MODEL_ID } from "@do-soul/alaya-core";
import {
  createLongMemEvalSelectionContractIdentity,
  type KpiPayload
} from "@do-soul/alaya-eval";
import {
  buildPayload,
  makeSeedExtractionPath,
  withEligibleMeasurementContract
} from "../../../../../../../packages/eval/src/__tests__/gates/release-gates-fixture.js";
import { buildEffectiveRecallConfigIdentity } from
  "../../../../longmemeval/provenance/effective-recall-config.js";

export function productPayloadFixture(
  effect: "control" | "product",
  runAt: string
): KpiPayload {
  const base = buildPayload("abc1234");
  const eligible = withEligibleMeasurementContract({
    ...base,
    bench_name: "public",
    split: "longmemeval-s",
    recall_pipeline_version: "recall-eval-v1",
    embedding_provider: `local_onnx:${DEFAULT_LOCAL_ONNX_MODEL_ID}`,
    dataset: {
      name: "longmemeval_s",
      size: 100,
      source: "fixture",
      checksum_sha256: "d".repeat(64)
    },
    sample_size: 100,
    evaluated_count: 100,
    kpi: {
      ...base.kpi,
      r_at_5: 0.95,
      latency_ms_p50: 100,
      latency_ms_p95: 100,
      seed_extraction_path: makeSeedExtractionPath()
    }
  });
  const answerableCount = 94;
  const hitCount = effect === "control" ? 80 : 89;
  const assignments = Array.from({ length: 100 }, (_, index) => ({
    question_id: `question-${index + 1}`,
    dataset_cohort: index < answerableCount
      ? "answerable" as const
      : "abstention" as const
  }));
  const selection = createLongMemEvalSelectionContractIdentity({
    datasetSha256: eligible.selection_contract!.dataset_sha256,
    assignments
  });
  return {
    ...eligible,
    run_at: runAt,
    answerable_evaluated_count: answerableCount,
    selection_contract: selection,
    recall_eval_attribution: recallAttribution(selection),
    kpi: {
      ...eligible.kpi,
      r_at_1: effect === "control" ? 0.8 : 0.81,
      r_at_5: hitCount / answerableCount,
      r_at_10: effect === "control" ? 0.9 : 0.91,
      token_saved_ratio_vs_full_prompt: 0.9,
      full_gold_coverage: {
        gold_bearing_questions: answerableCount,
        full_gold_at_5: effect === "control" ? 0.7 : 0.71,
        full_gold_at_10: 0.8,
        gold_coverage_at_5: effect === "control" ? 0.75 : 0.76,
        gold_coverage_at_10: 0.85,
        pool_recall_at_50: 0.9,
        pool_recall_at_100: 0.95
      },
      provider_returned_rate: 1,
      provider_pending_rate: 0,
      provider_failed_rate: 0,
      provider_not_requested_rate: 0,
      r_at_5_with_embedding_returned: 0.95,
      recall_token_economy: recallTokenEconomy(100),
      quality_metrics: {
        ...eligible.kpi.quality_metrics!,
        measurement_cohort_counts: {
          evaluated: 100,
          non_abstention: answerableCount,
          abstention: 6,
          scorable_answerable: answerableCount,
          unscorable_answerable: 0,
          hit_at_5: hitCount,
          miss_at_5: answerableCount - hitCount
        },
        abstention: {
          schema_version: "bench-abstention.v2",
          total: 6,
          scored: 0,
          unscorable: 6,
          method: "fused_margin_diagnostic_only",
          calibration_status: "uncalibrated",
          gate_eligible: false
        }
      },
      per_scenario: assignments.map((assignment, index) => ({
        id: assignment.question_id,
        version: 1,
        hit_at_5: index < hitCount,
        scorable: assignment.dataset_cohort === "answerable",
        measurement_cohort: assignment.dataset_cohort === "answerable"
          ? "answerable" as const
          : "dataset_declared_abstention" as const,
        tier: "hot" as const
      }))
    }
  } as KpiPayload;
}

export function biEncoderIdentityFixture() {
  return {
    enabled: true as const,
    provider_kind: "local_onnx" as const,
    effective_model_id: DEFAULT_LOCAL_ONNX_MODEL_ID,
    model_artifact_sha256: "4".repeat(64),
    effective_schema_version: 1,
    d2q_input: "raw_content" as const
  };
}

export function recallConfigFixture() {
  return buildEffectiveRecallConfigIdentity({}, {
    maxResults: 10,
    conflictAwareness: true
  });
}

function recallAttribution(
  selection: NonNullable<KpiPayload["selection_contract"]>
): NonNullable<KpiPayload["recall_eval_attribution"]> {
  return {
    status: "attributed",
    gate_eligible: true,
    node_version: process.version,
    platform: process.platform,
    arch: process.arch,
    embedding_mode: "env",
    embedding_provider_kind: "local_onnx",
    embedding_provider_label: `local_onnx:${DEFAULT_LOCAL_ONNX_MODEL_ID}`,
    onnx_threads: null,
    onnx_model_artifact_sha256: "4".repeat(64),
    embedding_supplement: biEncoderIdentityFixture(),
    answer_rerank: { enabled: false },
    recall_config: recallConfigFixture(),
    evaluation_slice: {
      offset: 0,
      limit: null,
      evaluated_count: selection.selected_count,
      question_id_digest: selection.selected_id_digest
    },
    hydration_binding: {
      dataset_sha256: selection.dataset_sha256,
      source: "external_expected_sha256"
    },
    snapshot_binding: {
      commit_sha7: "abc1234",
      gate_sha256: "a".repeat(64),
      worktree_state_sha256: "b".repeat(64),
      extraction_cache_manifest_sha256: "c".repeat(64),
      extraction_cache_requested_turns: 100,
      extraction_cache_cached_turns: 100,
      extraction_cache_coverage: 1,
      dataset_sha256: selection.dataset_sha256,
      question_id_digest: selection.selected_id_digest,
      snapshot_manifest_sha256: "f".repeat(64),
      producer_recall_pipeline_version: "recall-eval-v1",
      consumer_recall_pipeline_version: "recall-eval-v1",
      producer_schema_migration_version: 1
    }
  };
}

function recallTokenEconomy(count: number) {
  const stat = (value: number) => ({ mean: value, p50: value, p95: value, max: value });
  return {
    schema_version: "bench-recall-token-economy.v1" as const,
    sample_count: count,
    delivered_context_tokens_estimate: stat(10),
    coarse_pool_size: stat(5),
    fine_evaluated: stat(3),
    fine_pruned_count: stat(2),
    fine_priority_overflow_count: stat(0),
    fusion_families_with_hits: stat(1),
    embedding_inference_calls: stat(1)
  };
}
