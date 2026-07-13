import {
  makeShardDiagnostics,
  makeShardKpi
} from "../cli/cli-merge-validations-fixture.js";
import type { LongMemEvalRunProvenance } from "../../longmemeval/provenance/run.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION
} from "../../longmemeval/extraction-cache-manifest.js";

export function makeShardProvenance(
  offset: number,
  limit: number
): LongMemEvalRunProvenance {
  return {
    schema_version: 1,
    code: {
      commit_sha7: "abc1234",
      gate_sha256: "a".repeat(64),
      worktree_state_sha256: "b".repeat(64),
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
      dataset_revision: "f".repeat(64),
      requested_turns: 10,
      cached_turns: 10,
      coverage: 1,
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
  return makeShardKpi({
    evaluated_count: limit,
    kpi: {
      ...makeShardKpi().kpi,
      per_scenario: Array.from({ length: limit }, (_, index) => ({
        id: `range-${offset + index}`,
        version: 1,
        hit_at_5: true,
        tier: "warm" as const
      }))
    }
  });
}

export function makeRangeDiagnostics(offset: number, limit: number) {
  return makeShardDiagnostics({
    questions: Array.from({ length: limit }, (_, index) => ({
      question_id: `range-${offset + index}`,
      candidates: []
    }))
  });
}
