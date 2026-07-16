import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { createLongMemEvalSelectionContractIdentity } from
  "../../schema/longmemeval-selection-contract.js";
import {
  LongMemEvalExtractionSummarySchema,
  LongMemEvalFanoutAuthoritySchema,
  LongMemEvalShardAuthorityReferenceSchema,
  assertLongMemEvalFanoutReferenceBinding,
  assertLongMemEvalFullExtractionClosure
} from "../../gates/longmemeval-authority-wire.js";

describe("LongMemEval authority wire contract", () => {
  it("keeps request profiles strict and recomputes full closure", () => {
    const compact = extractionSummary();
    expect(() => LongMemEvalExtractionSummarySchema.parse({
      ...compact,
      request_profile: "benchmark-special"
    })).toThrow();
    expect(() => assertLongMemEvalFullExtractionClosure({
      ...compact,
      content_closure_index: closureIndex()
    })).not.toThrow();
    expect(() => assertLongMemEvalFullExtractionClosure({
      ...compact,
      content_closure_index: { [cacheKey()]: ["3".repeat(64), 99, 1] }
    })).toThrow(/content closure/u);
  });

  it("requires exact [0,500) plans and rejects cross-run refs", () => {
    const first = fanout("11111111-1111-4111-8111-111111111111");
    const second = fanout("22222222-2222-4222-8222-222222222222");
    expect(() => LongMemEvalFanoutAuthoritySchema.parse(first)).not.toThrow();
    expect(() => LongMemEvalFanoutAuthoritySchema.parse({
      ...first,
      plans: [{ shard_index: 0, offset: 1, limit: 250 }, first.plans[1]]
    })).toThrow(/exact \[0,500\)/u);
    const ref = reference(first);
    expect(() => assertLongMemEvalFanoutReferenceBinding({
      reference: ref,
      fanout: first,
      fanoutDescriptor: fanoutDescriptor(first),
      extractionDescriptor: extractionDescriptor(),
      sourceManifestSha256: "b".repeat(64)
    })).not.toThrow();
    expect(() => assertLongMemEvalFanoutReferenceBinding({
      reference: ref,
      fanout: second,
      fanoutDescriptor: fanoutDescriptor(second),
      extractionDescriptor: extractionDescriptor(),
      sourceManifestSha256: "b".repeat(64)
    })).toThrow(/fanout/u);
  });
});

function fanout(runNonce: string) {
  const compact = extractionSummary();
  return {
    schema_version: 1 as const,
    kind: "longmemeval_parent_fanout_authority" as const,
    run_nonce: runNonce,
    promotion: promotionIdentity(),
    dataset: { variant: "longmemeval_s" as const, sha256: "a".repeat(64) },
    cache: {
      extraction_authority: extractionDescriptor(),
      source_manifest_sha256: "b".repeat(64),
      content_closure_sha256: compact.content_closure_sha256,
      expansion_source_anchor_sha256: expansionHash(compact.expansion_source_anchor),
      expansion_lineage_sha256: expansionHash(compact.expansion_lineage)
    },
    code: codeIdentity(),
    requested_concurrency: 2,
    effective_concurrency: 2,
    plans: [
      { shard_index: 0, offset: 0, limit: 250 },
      { shard_index: 1, offset: 250, limit: 250 }
    ]
  };
}

function reference(authority: ReturnType<typeof fanout>) {
  return LongMemEvalShardAuthorityReferenceSchema.parse({
    schema_version: 2,
    kind: "longmemeval_extraction_authority_ref",
    authority: extractionDescriptor(),
    fanout: {
      ...fanoutDescriptor(authority),
      run_nonce: authority.run_nonce
    },
    plan: authority.plans[0],
    source_manifest_sha256: "b".repeat(64)
  });
}

function fanoutDescriptor(authority: ReturnType<typeof fanout>) {
  const contents = `${JSON.stringify(authority)}\n`;
  return {
    path: "longmemeval-fanout-authority.json" as const,
    sha256: sha256(contents),
    bytes: Buffer.byteLength(contents)
  };
}

function extractionDescriptor() {
  return {
    path: "longmemeval-extraction-authority.json" as const,
    sha256: "4".repeat(64),
    bytes: 1024
  };
}

function extractionSummary() {
  const target = targetCache();
  return {
    schema_version: 3 as const,
    manifest_sha256: "b".repeat(64),
    extraction_model: target.extraction_model,
    model_family: target.model_family,
    request_profile: target.request_profile,
    provider_url: target.provider_url,
    system_prompt_sha256: target.system_prompt_sha256,
    cache_key_algo: target.cache_key_algo,
    dataset: target.dataset,
    dataset_revision: target.dataset_revision,
    requested_turns: 1,
    cached_turns: 1,
    coverage: 1 as const,
    storage: "git-tracked" as const,
    built_at: "2026-07-17T00:00:00.000Z",
    builder: "fixture",
    fill_status: "complete" as const,
    window_offset: 0 as const,
    window_limit: 500 as const,
    expected_turns: 1,
    expected_key_set_sha256: sha256(cacheKey()),
    content_closure_sha256: closureSha256(),
    expansion_source_anchor: sourceAnchor(),
    expansion_lineage: expansionLineage()
  };
}

function sourceAnchor() {
  return {
    schema_version: 1 as const,
    kind: "longmemeval_100_to_500_source_anchor" as const,
    ...promotionIdentity(),
    source_snapshot: sourceSnapshot(),
    source_cache: sourceCache(),
    target_cache: targetCache()
  };
}

function expansionLineage() {
  return {
    schema_version: 1 as const,
    kind: "longmemeval_100_to_500_expansion" as const,
    ...promotionIdentity(),
    source_snapshot: sourceSnapshot(),
    source_cache: sourceCache(),
    target_cache: { ...targetCache(), content_closure_sha256: closureSha256() }
  };
}

function promotionIdentity() {
  return {
    contract_sha256: "5".repeat(64),
    policy_version: "longmemeval-product-default-v1" as const,
    code: codeIdentity(),
    source_selection: selection(100),
    next_selection: selection(500),
    matrix_sha256: "6".repeat(64),
    product_default: {
      cell: "B" as const,
      treatment: { embedding_supplement: true, answer_rerank: false },
      bundle_sha256: "7".repeat(64)
    }
  };
}

function codeIdentity() {
  return {
    commit_sha: "8".repeat(40),
    commit_sha7: "8".repeat(7),
    worktree_state_sha256: "9".repeat(64),
    executed_dist: {
      algorithm: "sha256-reachable-path-file-sha256-v1" as const,
      sha256: "a".repeat(64),
      file_count: 10
    }
  };
}

function selection(count: number) {
  return createLongMemEvalSelectionContractIdentity({
    datasetSha256: "a".repeat(64),
    assignments: Array.from({ length: count }, (_, index) => ({
      question_id: `q-${index}`,
      dataset_cohort: "answerable" as const
    }))
  });
}

function sourceSnapshot() {
  return {
    db_path: "source.sqlite",
    manifest_sha256: "1".repeat(64),
    db_sha256: "2".repeat(64),
    sidecar_sha256: "3".repeat(64)
  };
}

function sourceCache() {
  return {
    manifest_sha256: "4".repeat(64),
    extraction_model: "fixture-model",
    model_family: "fixture-family",
    request_profile: "provider-default-v1" as const,
    provider_url: "redacted",
    system_prompt_sha256: "5".repeat(64),
    cache_key_algo: "fixture-key-v1",
    dataset: "longmemeval-s",
    dataset_revision: "a".repeat(64),
    window_offset: 0 as const,
    window_limit: 100 as const,
    expected_turns: 1,
    expected_key_set_sha256: "6".repeat(64),
    content_closure_sha256: "7".repeat(64)
  };
}

function targetCache() {
  return {
    extraction_model: "fixture-model",
    model_family: "fixture-family",
    request_profile: "provider-default-v1" as const,
    provider_url: "redacted",
    system_prompt_sha256: "5".repeat(64),
    cache_key_algo: "fixture-key-v1",
    dataset: "longmemeval-s",
    dataset_revision: "a".repeat(64),
    window_offset: 0 as const,
    window_limit: 500 as const,
    expected_turns: 1,
    expected_key_set_sha256: sha256(cacheKey())
  };
}

function closureIndex() {
  return { [cacheKey()]: ["3".repeat(64), 1, 1] as const };
}

function cacheKey(): string {
  return "2".repeat(64);
}

function closureSha256(): string {
  return sha256(JSON.stringify([
    cacheKey(), "fixture-model", "provider-default-v1", "3".repeat(64), 1, 1
  ]));
}

function expansionHash(value: unknown): string {
  return sha256(JSON.stringify(value, (key, nested: unknown) =>
    key === "provider_url" ? undefined : nested));
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}
