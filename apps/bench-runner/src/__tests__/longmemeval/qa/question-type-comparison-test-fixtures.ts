import type { LongMemEvalQuestion } from "../../../longmemeval/ingestion/dataset.js";
import { createStratifiedQuestionManifest } from "../../../longmemeval/selection/question-manifest.js";
import {
  buildFullLongMemEvalPayload,
  cleanSeedExtractionPath,
  passingQualityMetrics,
  selectionContractForRows
} from "../../../../../../packages/eval/src/__tests__/history/history-fixture.js";
import { syntheticExtractionClosure } from "../extraction/extraction-closure-fixture.js";

export const DATASET_SHA = "a".repeat(64);

export function datasetQuestion(
  questionId: string,
  questionType: string
): LongMemEvalQuestion {
  return {
    question_id: questionId,
    question_type: questionType,
    question: questionId,
    answer: questionId,
    question_date: "2026-01-01",
    haystack_session_ids: [],
    haystack_dates: [],
    haystack_sessions: [],
    answer_session_ids: [`source-${questionId}`]
  };
}

export const dataset = [
  datasetQuestion("b-lost", "multi-session"),
  datasetQuestion("a-gained", "single-session-user"),
  datasetQuestion("d-still-miss_abs", "single-session-user"),
  datasetQuestion("c-still-hit", "multi-session")
];

export function kpi(
  rows: readonly { id: string; hit_at_5: boolean }[],
  latencyP95 = 100,
  datasetChecksum = DATASET_SHA
): unknown {
  const perScenario = rows.map((row) => {
    const abstention = row.id.endsWith("_abs");
    return {
      id: row.id,
      version: 1,
      hit_at_5: row.hit_at_5,
      scorable: !abstention,
      measurement_cohort: abstention
        ? "dataset_declared_abstention" as const
        : "answerable" as const,
      tier: "hot" as const
    };
  });
  const answerableRows = perScenario.filter((row) => row.scorable);
  const abstentionCount = perScenario.length - answerableRows.length;
  const hitCount = answerableRows.filter((row) => row.hit_at_5).length;
  const selectionDatasetSha = /^[a-f0-9]{64}$/u.test(datasetChecksum)
    ? datasetChecksum
    : DATASET_SHA;
  const selection = safeSelectionContract(perScenario, selectionDatasetSha);
  const base = buildFullLongMemEvalPayload("public", "05d98df", 0.95);
  return {
    ...base,
    bench_name: "public",
    split: "longmemeval-s",
    run_at: "2026-07-15T00:00:00.000Z",
    alaya_commit: "05d98df",
    alaya_version: "0.3.11",
    recall_pipeline_version: "test-v1",
    embedding_provider: "local_onnx:Xenova/test",
    chat_provider: "none",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: {
      name: "longmemeval_s",
      size: dataset.length,
      source: "fixture",
      checksum_sha256: datasetChecksum
    },
    selection_contract: selection,
    sample_size: dataset.length,
    evaluated_count: rows.length,
    answerable_evaluated_count: answerableRows.length,
    recall_eval_attribution: recallAttribution(
      selectionDatasetSha,
      selection.selected_id_digest,
      rows.length
    ),
    harness_mode: "mcp_propose_review",
    kpi: {
      ...base.kpi,
      r_at_5: answerableRows.length === 0 ? 0 : hitCount / answerableRows.length,
      latency_ms_p95: latencyP95,
      per_scenario: perScenario,
      quality_metrics: {
        ...passingQualityMetrics(),
        non_monotonic_denominator: rows.length,
        budget_drop_distribution: {
          max_entries: { count: 0, share: 0, denominator: rows.length }
        },
        candidate_absent_denominator: answerableRows.length,
        no_gold_denominator: answerableRows.length,
        evaluator_identity_issue_denominator: rows.length,
        evaluator_identity_unscorable_denominator: rows.length,
        evidence_stream_gold_delivery_denominator: answerableRows.length,
        path_stream_top10_denominator: answerableRows.length,
        measurement_cohort_counts: {
          evaluated: rows.length,
          non_abstention: answerableRows.length,
          abstention: abstentionCount,
          scorable_answerable: answerableRows.length,
          unscorable_answerable: 0,
          hit_at_5: hitCount,
          miss_at_5: answerableRows.length - hitCount
        },
        unscorable_reason_distribution: {
          dataset_declared_abstention: abstentionCount
        },
        miss_taxonomy_distribution: {
          candidate_absent: 0,
          materialization_drop: 0,
          budget_drop: 0,
          delivery_order_drop: answerableRows.length - hitCount,
          answer_set_coverage_drop: 0,
          evaluation_or_gold_issue: 0
        },
        abstention: {
          schema_version: "bench-abstention.v2",
          total: abstentionCount,
          scored: 0,
          unscorable: abstentionCount,
          method: "fused_margin_diagnostic_only",
          calibration_status: "uncalibrated",
          gate_eligible: false
        }
      },
      seed_extraction_path: {
        ...cleanSeedExtractionPath(),
        extraction_attempts: rows.length,
        cache_hits: rows.length,
        facts_produced: Math.max(1, rows.length),
        signals_dropped: 0,
        parse_dropped: 0,
        compile_overflow_dropped: 0,
        signals_dropped_by_reason: { candidate_absent: 0, materialization_drop: 0 }
      }
    }
  };
}

function safeSelectionContract(
  rows: Parameters<typeof selectionContractForRows>[0],
  datasetSha256: string
) {
  try {
    return selectionContractForRows(rows, datasetSha256);
  } catch {
    return selectionContractForRows(dataset.map((row) => ({
      id: row.question_id,
      version: 1,
      hit_at_5: true,
      scorable: !row.question_id.endsWith("_abs"),
      measurement_cohort: row.question_id.endsWith("_abs")
        ? "dataset_declared_abstention" as const
        : "answerable" as const,
      tier: "hot" as const
    })), datasetSha256);
  }
}

function recallAttribution(
  datasetSha256: string,
  questionIdDigest: string,
  evaluatedCount: number
) {
  return {
    status: "attributed" as const,
    gate_eligible: true,
    node_version: "v24.0.0",
    platform: "linux",
    arch: "x64",
    embedding_mode: "env" as const,
    embedding_provider_kind: "local_onnx" as const,
    embedding_provider_label: "local_onnx:Xenova/test",
    onnx_threads: 2,
    onnx_model_artifact_sha256: "9".repeat(64),
    embedding_supplement: {
      enabled: true as const,
      provider_kind: "local_onnx" as const,
      effective_model_id: "Xenova/test",
      model_artifact_sha256: "9".repeat(64),
      effective_schema_version: 1,
      d2q_input: "raw_content" as const
    },
    answer_rerank: { enabled: false as const },
    recall_config: stableRecallConfig(),
    evaluation_slice: {
      offset: 0,
      limit: null,
      evaluated_count: evaluatedCount,
      question_id_digest: questionIdDigest
    },
    hydration_binding: {
      dataset_sha256: datasetSha256,
      source: "external_expected_sha256" as const
    },
    snapshot_binding: {
      commit_sha7: "05d98df",
      gate_sha256: "d".repeat(64),
      worktree_state_sha256: "1".repeat(64),
      extraction_cache_manifest_sha256: "e".repeat(64),
      extraction_cache_requested_turns: 10,
      extraction_cache_cached_turns: 10,
      extraction_cache_coverage: 1,
      dataset_sha256: datasetSha256,
      question_id_digest: questionIdDigest,
      snapshot_manifest_sha256: "8".repeat(64),
      producer_recall_pipeline_version: "test-v1",
      consumer_recall_pipeline_version: "test-v1",
      producer_schema_migration_version: 103
    }
  };
}

function extractionCacheIdentity(evaluatedCount: number) {
  const closure = syntheticExtractionClosure({
    count: 10,
    model: "cached-model",
    requestProfile: "provider-default-v1",
    seed: "question-type-comparison"
  });
  return {
    manifest_sha256: "e".repeat(64),
    schema_version: 3,
    extraction_model: "cached-model",
    model_family: "cached-model",
    request_profile: "provider-default-v1",
    provider_url: "https://provider.invalid/v1",
    system_prompt_sha256: "f".repeat(64),
    cache_key_algo: "sha256(model\\0systemPrompt\\0turnContent)",
    dataset: "longmemeval-s",
    dataset_revision: DATASET_SHA,
    requested_turns: 10,
    cached_turns: 10,
    coverage: 1,
    fill_status: "complete",
    window_offset: 0,
    window_limit: evaluatedCount,
    ...closure,
    storage: "archive",
    built_at: "2026-07-01T00:00:00.000Z",
    builder: "test"
  };
}

function runtimeIdentity() {
  return {
    node_version: "v24.0.0",
    platform: "linux",
    arch: "x64",
    embedding_mode: "env",
    embedding_provider_kind: "local_onnx",
    embedding_provider_label: "local_onnx:Xenova/test",
    onnx_threads: 2,
    onnx_model_artifact_sha256: "9".repeat(64),
    embedding_supplement: {
      enabled: true,
      provider_kind: "local_onnx",
      effective_model_id: "Xenova/test",
      model_artifact_sha256: "9".repeat(64),
      effective_schema_version: 1,
      d2q_input: "raw_content"
    },
    answer_rerank: { enabled: false },
    paired_env: {
      ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "0",
      ALAYA_BENCH_EXTRACTION_CACHE_MIN_COVERAGE: "1",
      OFFICIAL_API_GARDEN_MODEL: "cached-model",
      ALAYA_RECALL_ANSWERS_WITH: "1",
      ALAYA_RECALL_FACET_TAGS: "1",
      ALAYA_ENABLE_EMBEDDING_SUPPLEMENT: "1",
      ALAYA_INGEST_RECONCILIATION_ENABLED: "1",
      ALAYA_CONFLICT_DETECTION_ENABLED: "1",
      ALAYA_GARDEN_PROVIDER_KIND: "host_worker"
    }
  };
}

export function provenance(
  confSliceCompatibility: boolean,
  evaluatedCount = dataset.length
): unknown {
  return {
    schema_version: 1,
    dataset_sha256: DATASET_SHA,
    selection: selectionContractForRows(
      dataset.slice(0, evaluatedCount).map((row) => ({
        id: row.question_id,
        version: 1,
        hit_at_5: true,
        scorable: !row.question_id.endsWith("_abs"),
        measurement_cohort: row.question_id.endsWith("_abs")
          ? "dataset_declared_abstention" as const
          : "answerable" as const,
        tier: "hot" as const
      })),
      DATASET_SHA
    ),
    code: {
      commit_sha7: "05d98df",
      commit_sha: "05d98df" + "0".repeat(33),
      gate_sha256: "d".repeat(64),
      gate_contract_path: "/tmp/frozen-contract.json",
      worktree_state_sha256: "1".repeat(64),
      worktree_clean: true,
      executed_dist: {
        algorithm: "sha256-reachable-path-file-sha256-v1",
        sha256: "7".repeat(64),
        file_count: 1
      }
    },
    extraction_cache: extractionCacheIdentity(evaluatedCount),
    runtime: runtimeIdentity(),
    execution: {
      protocol: "sequential",
      concurrency: 1,
      offset: 0,
      limit: null,
      evaluated_count: evaluatedCount
    },
    recall_config: {
      conf_slice_compatibility: confSliceCompatibility,
      ...stableRecallConfig()
    },
    seed_capabilities: { facet_tags_enabled: true },
    question_manifest: null
  };
}

function stableRecallConfig() {
  return {
    schema_version: 2 as const,
    max_results: 10,
    conflict_awareness: true,
    effective_config_sha256: "6".repeat(64)
  };
}

export function buildManifestFixture() {
  const manifest = createStratifiedQuestionManifest({
    variant: "longmemeval_s",
    datasetSha256: DATASET_SHA,
    questions: dataset,
    targetCount: dataset.length
  });
  const identity = {
    schema_version: manifest.schema_version,
    variant: manifest.variant,
    dataset_sha256: manifest.dataset_sha256,
    algorithm_version: manifest.algorithm_version,
    target_count: manifest.target_count,
    selected_id_digest: manifest.selected_id_digest,
    file_sha256: "c".repeat(64)
  };
  const rows = dataset.map((row) => ({ id: row.question_id, hit_at_5: true }));
  const withManifest = (enabled: boolean) => ({
    ...(provenance(enabled) as object),
    question_manifest: identity
  });
  return {
    manifest,
    identity,
    rows,
    base: {
      dataset,
      datasetSha256: DATASET_SHA,
      control: kpi(rows),
      treatment: kpi(rows),
      controlProvenance: withManifest(false),
      treatmentProvenance: withManifest(true),
      manifestFileSha256: "c".repeat(64)
    }
  };
}
