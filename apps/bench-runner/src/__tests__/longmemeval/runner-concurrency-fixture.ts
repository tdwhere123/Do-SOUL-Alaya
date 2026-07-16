import {
  makeShardDiagnostics,
  makeShardKpi
} from "../cli/cli-merge-validations-fixture.js";
import type { LongMemEvalRunProvenance } from "../../longmemeval/provenance/run.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION
} from "../../longmemeval/extraction-cache-manifest.js";
import { syntheticExtractionClosure } from "./extraction-closure-fixture.js";
import { computeQuestionIdDigest } from "../../longmemeval/selection/question-manifest.js";
import { computeCohortAssignmentDigest } from "../../longmemeval/selection/contract.js";
import { MERGE_TEST_DATASET_SHA256 } from
  "../cli/cli-merge-dataset-fixture.js";

const DATASET_SHA = MERGE_TEST_DATASET_SHA256;
const EXTRACTION_CLOSURE = syntheticExtractionClosure({
  count: 10,
  model: "fixture-model",
  requestProfile: "provider-default-v1",
  seed: "runner-concurrency"
});

export function makeShardProvenance(
  offset: number,
  limit: number
): LongMemEvalRunProvenance {
  const questionIds = Array.from({ length: limit }, (_, index) => `q-${offset + index + 1}`);
  const assignments = questionIds.map((question_id) => ({
    question_id,
    dataset_cohort: "answerable" as const
  }));
  return {
    schema_version: 1,
    dataset_sha256: DATASET_SHA,
    selection: {
      schema_version: 1,
      dataset_sha256: DATASET_SHA,
      selected_id_digest: computeQuestionIdDigest(questionIds),
      selected_count: questionIds.length,
      expected_cohort_counts: { answerable: questionIds.length, abstention: 0 },
      cohort_assignment_digest: computeCohortAssignmentDigest(assignments)
    },
    code: {
      commit_sha7: "abc1234",
      commit_sha: "abc1234" + "0".repeat(33),
      gate_sha256: "a".repeat(64),
      gate_contract_path: "/tmp/frozen-contract.json",
      worktree_state_sha256: "b".repeat(64),
      worktree_clean: true,
      executed_dist: {
        algorithm: "sha256-reachable-path-file-sha256-v1",
        sha256: "9".repeat(64),
        file_count: 3
      }
    },
    extraction_cache: {
      manifest_sha256: "c".repeat(64),
      schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
      extraction_model: "fixture-model",
      model_family: "fixture-model-family",
      request_profile: "provider-default-v1",
      provider_url: `sha256:${"d".repeat(64)}`,
      system_prompt_sha256: "e".repeat(64),
      cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
      dataset: "longmemeval-s",
      dataset_revision: DATASET_SHA,
      requested_turns: EXTRACTION_CLOSURE.expected_turns,
      cached_turns: EXTRACTION_CLOSURE.expected_turns,
      coverage: 1,
      fill_status: "complete",
      window_offset: 0,
      window_limit: 4,
      ...EXTRACTION_CLOSURE,
      storage: "git-tracked",
      built_at: "2026-07-01T00:00:00.000Z",
      builder: "test"
    },
    runtime: {
      node_version: "v24.0.0",
      platform: "linux",
      arch: "x64",
      embedding_mode: "disabled",
      embedding_provider_kind: "openai",
      embedding_provider_label: "none",
      onnx_threads: null,
      embedding_supplement: { enabled: false },
      answer_rerank: { enabled: false },
      paired_env: {}
    },
    execution: {
      protocol: "sequential",
      concurrency: 1,
      offset,
      limit,
      evaluated_count: limit
    },
    recall_config: {
      conf_slice_compatibility: false,
      schema_version: 2,
      max_results: 10,
      conflict_awareness: true,
      effective_config_sha256: "8".repeat(64)
    },
    question_manifest: null
  };
}

export function makeRangeKpi(offset: number, limit: number) {
  const questionIds = Array.from(
    { length: limit },
    (_, index) => `q-${offset + index + 1}`
  );
  const assignments = questionIds.map((question_id) => ({
    question_id,
    dataset_cohort: "answerable" as const
  }));
  return makeShardKpi({
    evaluated_count: limit,
    selection_contract: {
      schema_version: 1,
      dataset_sha256: DATASET_SHA,
      selected_id_digest: computeQuestionIdDigest(questionIds),
      selected_count: limit,
      expected_cohort_counts: { answerable: limit, abstention: 0 },
      cohort_assignment_digest: computeCohortAssignmentDigest(assignments)
    },
    kpi: {
      ...makeShardKpi().kpi,
      per_scenario: questionIds.map((id) => ({
        id,
        version: 1,
        hit_at_5: true,
        scorable: true,
        measurement_cohort: "answerable" as const,
        tier: "warm" as const
      }))
    }
  });
}

export function makeRangeDiagnostics(offset: number, limit: number) {
  return makeShardDiagnostics({
    questions: Array.from({ length: limit }, (_, index) => ({
      question_id: `q-${offset + index + 1}`,
      candidate_pool_complete: true,
      cohort_ledger: answerableCohortLedger(),
      candidates: []
    }))
  });
}

function answerableCohortLedger() {
  return {
    dataset_cohort: "answerable" as const,
    extraction_materialization: {
      status: "memory_emitted" as const,
      emitted_memory_count: 1,
      reason: null
    },
    evaluator_gold_identity: { status: "present" as const, object_ids: ["gold"] },
    retrieval_status: "hit_at_5" as const,
    evidence_status: "complete" as const,
    evaluation_issue_reason: null,
    candidate_pool_complete: true,
    stage_ranks: [],
    final_verdict: "hit_at_5" as const
  };
}
