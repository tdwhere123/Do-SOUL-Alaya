import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
  OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE,
  OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT
} from "@do-soul/alaya-soul";
import { inspectQuerySemanticFactorCacheIdentity } from
  "../../../bench/query-factors/query-semantic-factor-cache-identity.js";
import { isRecallEvalRunEvidenceEligible } from
  "../../../bench/provenance/recall-eval/recall-eval-run.js";
import type { RecallEvalRuntimeAttribution } from
  "../../../bench/lifecycle/recall-eval/recall-eval-runtime.js";
import {
  LongMemEvalRunProvenanceSchema,
  type LongMemEvalRunProvenance
} from "../../../bench/provenance/run.js";
import { provenance } from "./recall-eval-provenance-contract-fixture.js";

describe("recall-eval query-cache gate provenance", () => {
  it("gates only absent control or inspect-current v4", () => {
    const current = inspectableCurrent();
    expect(inspectQuerySemanticFactorCacheIdentity(current).kind).toBe("current");
    expect(eligible(current)).toBe(true);
    expect(eligible(undefined)).toBe(true);

    const archived = omitProfile({ ...current, schema_version: 3 });
    expect(inspectQuerySemanticFactorCacheIdentity(archived).kind).toBe("diagnostic_only");
    expect(eligible(archived)).toBe(false);

    expect(inspectQuerySemanticFactorCacheIdentity(omitProfile({ ...current })).kind)
      .toBe("diagnostic_only");
    expect(eligible(omitProfile({ ...current }))).toBe(false);

    const obsolete = { ...current, request_profile: "deepseek-v4-nonthinking-v1" };
    expect(inspectQuerySemanticFactorCacheIdentity(obsolete).kind).toBe("diagnostic_only");
    expect(eligible(obsolete)).toBe(false);
  });
});

function eligible(cache: unknown): boolean {
  const attribution = attributionWith(cache);
  const run = overlayCache(
    LongMemEvalRunProvenanceSchema.parse(provenance(false)),
    cache,
    attribution
  );
  return isRecallEvalRunEvidenceEligible({
    runtimeAttribution: attribution,
    provenance: run,
    expectedQuestionIdDigest: run.selection!.selected_id_digest,
    actualQuestionIdDigest: run.selection!.selected_id_digest,
    evaluatedCount: run.execution.evaluated_count,
    offset: run.execution.offset,
    limit: run.execution.limit
  });
}

function overlayCache(
  run: LongMemEvalRunProvenance,
  cache: unknown,
  attribution: RecallEvalRuntimeAttribution
): LongMemEvalRunProvenance {
  return {
    ...run,
    runtime: {
      ...run.runtime,
      ...attributionRuntime(attribution),
      ...(cache === undefined ? {} : { query_semantic_factor_cache: cache })
    },
    recall_config: attribution.recall_config
  } as LongMemEvalRunProvenance;
}

function attributionWith(cache: unknown): RecallEvalRuntimeAttribution {
  const run = LongMemEvalRunProvenanceSchema.parse(provenance(false));
  return {
    status: "attributed",
    gate_eligible: true,
    node_version: run.runtime.node_version,
    platform: run.runtime.platform,
    arch: run.runtime.arch,
    embedding_mode: run.runtime.embedding_mode,
    embedding_provider_kind: run.runtime.embedding_provider_kind,
    embedding_provider_label: run.runtime.embedding_provider_label,
    onnx_threads: run.runtime.onnx_threads,
    onnx_model_artifact_sha256: run.runtime.onnx_model_artifact_sha256 ?? null,
    embedding_supplement: run.runtime.embedding_supplement,
    answer_rerank: run.runtime.answer_rerank ?? { enabled: false },
    recall_config: run.recall_config,
    query_semantic_factor_cache: cache as RecallEvalRuntimeAttribution["query_semantic_factor_cache"],
    snapshot_binding: {
      commit_sha7: run.code.commit_sha7,
      gate_sha256: run.code.gate_sha256!,
      worktree_state_sha256: run.code.worktree_state_sha256!,
      extraction_cache_manifest_sha256: run.extraction_cache!.manifest_sha256,
      extraction_cache_requested_turns: run.extraction_cache!.requested_turns!,
      extraction_cache_cached_turns: run.extraction_cache!.cached_turns!,
      extraction_cache_coverage: run.extraction_cache!.coverage!,
      dataset_sha256: run.dataset_sha256!,
      question_id_digest: run.selection!.selected_id_digest,
      snapshot_manifest_sha256: "2".repeat(64),
      producer_recall_pipeline_version: "test-v1",
      consumer_recall_pipeline_version: "test-v1",
      producer_schema_migration_version: 1
    }
  };
}

function attributionRuntime(attribution: RecallEvalRuntimeAttribution) {
  return {
    node_version: attribution.node_version,
    platform: attribution.platform,
    arch: attribution.arch,
    embedding_mode: attribution.embedding_mode,
    embedding_provider_kind: attribution.embedding_provider_kind,
    embedding_provider_label: attribution.embedding_provider_label,
    onnx_threads: attribution.onnx_threads,
    onnx_model_artifact_sha256: attribution.onnx_model_artifact_sha256,
    embedding_supplement: attribution.embedding_supplement,
    answer_rerank: attribution.answer_rerank
  };
}

function inspectableCurrent() {
  return {
    schema_version: 4,
    cache_content_sha256: `sha256:${"3".repeat(64)}`,
    compiler_operator_id: OPEN_SEMANTIC_FACTOR_QUERY_OPERATOR_ID,
    request_profile: "provider-default-v1",
    system_prompt_sha256: prefixedSha256(OPEN_SEMANTIC_FACTOR_QUERY_SYSTEM_PROMPT),
    request_template_sha256: prefixedSha256(OPEN_SEMANTIC_FACTOR_QUERY_REQUEST_TEMPLATE),
    model_id: "test-model",
    provider_url_sha256: `sha256:${"5".repeat(64)}`,
    source_set_sha256: `sha256:${"7".repeat(64)}`,
    entry_count: 1,
    transport_routes: [{
      provider_url_sha256: `sha256:${"9".repeat(64)}`,
      model: "test-model"
    }]
  };
}

function omitProfile<T extends { request_profile?: string }>(value: T): Omit<T, "request_profile"> {
  const { request_profile: _profile, ...rest } = value;
  return rest;
}

function prefixedSha256(value: string): string {
  return `sha256:${createHash("sha256").update(value, "utf8").digest("hex")}`;
}
