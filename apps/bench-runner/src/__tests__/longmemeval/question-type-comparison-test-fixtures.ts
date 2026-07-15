import type { LongMemEvalQuestion } from "../../longmemeval/dataset.js";
import { createStratifiedQuestionManifest } from "../../longmemeval/selection/question-manifest.js";

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
  return {
    bench_name: "public",
    split: "longmemeval-s",
    alaya_commit: "05d98df",
    alaya_version: "0.3.11",
    recall_pipeline_version: "test-v1",
    embedding_provider: "local_onnx:Xenova/test",
    chat_provider: "none",
    policy_shape: "stress",
    simulate_report: "none",
    dataset: { name: "longmemeval_s", checksum_sha256: datasetChecksum },
    sample_size: dataset.length,
    evaluated_count: rows.length,
    harness_mode: "mcp_propose_review",
    kpi: { latency_ms_p95: latencyP95, per_scenario: rows }
  };
}

function extractionCacheIdentity() {
  return {
    manifest_sha256: "e".repeat(64),
    schema_version: 1,
    extraction_model: "cached-model",
    provider_url: "https://provider.invalid/v1",
    system_prompt_sha256: "f".repeat(64),
    cache_key_algo: "sha256(model\\0systemPrompt\\0turnContent)",
    dataset: "longmemeval-s",
    dataset_revision: DATASET_SHA,
    requested_turns: 10,
    cached_turns: 10,
    coverage: 1,
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
    paired_env: {
      ALAYA_BENCH_ALLOW_LIVE_EXTRACTION: "0",
      ALAYA_BENCH_EXTRACTION_CACHE_MIN_COVERAGE: "1",
      OFFICIAL_API_GARDEN_MODEL: "cached-model",
      ALAYA_RECALL_ANSWERS_WITH: "1",
      ALAYA_RECALL_FACET_TAGS: "1",
      ALAYA_INGEST_RECONCILIATION_ENABLED: "0",
      ALAYA_CONFLICT_DETECTION_ENABLED: "0",
      ALAYA_GARDEN_PROVIDER_KIND: "local_heuristics"
    }
  };
}

export function provenance(
  confSliceCompatibility: boolean,
  evaluatedCount = dataset.length
): unknown {
  return {
    schema_version: 1,
    code: {
      commit_sha7: "05d98df",
      commit_sha: "05d98df" + "0".repeat(33),
      gate_sha256: "d".repeat(64),
      gate_contract_path: "/tmp/frozen-contract.json",
      worktree_state_sha256: "1".repeat(64),
      worktree_clean: true
    },
    extraction_cache: extractionCacheIdentity(),
    runtime: runtimeIdentity(),
    execution: {
      protocol: "sequential",
      concurrency: 1,
      offset: 0,
      limit: null,
      evaluated_count: evaluatedCount
    },
    recall_config: { conf_slice_compatibility: confSliceCompatibility },
    seed_capabilities: { facet_tags_enabled: true },
    question_manifest: null
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
