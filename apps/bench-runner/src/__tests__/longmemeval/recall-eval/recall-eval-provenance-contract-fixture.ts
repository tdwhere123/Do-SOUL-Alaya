import type { LongMemEvalQuestion } from "../../../longmemeval/ingestion/dataset.js";
import {
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

function extractionCacheIdentity(evaluatedCount: number) {
  const closure = syntheticExtractionClosure({
    count: 10,
    model: "cached-model",
    requestProfile: "provider-default-v1",
    seed: "recall-eval-provenance-contract"
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
