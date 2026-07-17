import { writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LONGMEMEVAL_FANOUT_AUTHORITY_FILENAME,
  LongMemEvalFanoutAuthoritySchema,
  longMemEvalArtifactDescriptor
} from "@do-soul/alaya-eval/internal";
import { DEFAULT_LOCAL_ONNX_MODEL_ID } from "@do-soul/alaya-core";
import { createLongMemEvalSelectionContractIdentity } from
  "@do-soul/alaya-eval";
import { makeShardProvenance } from "../runner/runner-concurrency-fixture.js";
import {
  LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME,
  bindShardRunProvenanceAuthority,
  buildShardExtractionAuthorityReference,
  loadGlobalExtractionAuthority,
  renderShardExtractionAuthorityReference
} from "../../../longmemeval/provenance/contract/extraction-authority-reference.js";
import {
  buildSnapshotExtractionAuthority,
  buildSnapshotExtractionSummary,
  renderSnapshotExtractionAuthority
} from "../../../longmemeval/snapshot/extraction-authority.js";
import { compactSnapshotRunProvenance } from "../../../longmemeval/snapshot/run-provenance.js";
import { verifyShardRunProvenance } from
  "../../../cli/merge/shard/shard-provenance-verifier.js";
import { canonicalProductRecallProvenanceConfig } from "../../../longmemeval/promotion/verifiers/product-policy-verifier.js";
import { resolveMergedRequestedConcurrency } from "../../../longmemeval/provenance/shard-aggregate.js";

const roots: string[] = [];
afterEach(async () => Promise.all(roots.splice(0).map((root) =>
  rm(root, { recursive: true, force: true }))));

describe("shard extraction authority references", () => {
  it("hydrates compact provenance from one descriptor-bound global authority", async () => {
    const fixture = await authorityFixture();
    const loaded = await loadGlobalExtractionAuthority(fixture.root);
    expect(resolveMergedRequestedConcurrency({
      shardCount: 2,
      globalExtractionAuthority: loaded
    })).toBe(2);
    expect(() => resolveMergedRequestedConcurrency({
      requestedConcurrency: 3,
      shardCount: 2,
      globalExtractionAuthority: loaded
    })).toThrow(/differs from fanout authority/u);
    const hydrated = bindShardRunProvenanceAuthority({
      compact: fixture.compact,
      reference: fixture.reference,
      global: loaded!
    });
    const hydratedCache = hydrated.extraction_cache;
    if (hydratedCache?.schema_version !== 3) {
      throw new Error("hydrated fixture requires v3 cache");
    }

    expect(hydratedCache.content_closure_index)
      .toEqual(fixture.authority.content_closure_index);
    expect(renderShardExtractionAuthorityReference(fixture.reference).length)
      .toBeLessThan(1_024);
  });

  it("rejects ref, compact summary, and authority drift independently", async () => {
    const fixture = await authorityFixture();
    const loaded = (await loadGlobalExtractionAuthority(fixture.root))!;
    const compactCache = fixture.compact.extraction_cache;
    if (compactCache?.schema_version !== 3) {
      throw new Error("compact fixture requires v3 cache");
    }
    expect(() => bindShardRunProvenanceAuthority({
      compact: fixture.compact,
      reference: {
        ...fixture.reference,
        authority: { ...fixture.reference.authority, sha256: "0".repeat(64) }
      },
      global: loaded
    })).toThrow(/descriptor/u);
    expect(() => bindShardRunProvenanceAuthority({
      compact: {
        ...fixture.compact,
        extraction_cache: {
          ...compactCache,
          content_closure_sha256: "0".repeat(64)
        }
      },
      reference: fixture.reference,
      global: loaded
    })).toThrow(/compact summary/u);
    await writeFile(
      join(fixture.root, LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME),
      "{}\n",
      "utf8"
    );
    await expect(loadGlobalExtractionAuthority(fixture.root))
      .rejects.toThrow(/invalid/u);
  });

  it("keeps the descriptor-open authority snapshot stable across path replacement", async () => {
    const fixture = await authorityFixture();
    const loaded = await loadGlobalExtractionAuthority(fixture.root, {
      afterSnapshot: async () => writeFile(
        join(fixture.root, LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME),
        "{}\n",
        "utf8"
      )
    });

    expect(() => bindShardRunProvenanceAuthority({
      compact: fixture.compact,
      reference: fixture.reference,
      global: loaded!
    })).not.toThrow();
  });

  it("enforces Product-B policy while hydrating compact merge provenance", async () => {
    const fixture = await authorityFixture();
    const globalAuthority = await loadGlobalExtractionAuthority(fixture.root);
    const referenceContents = renderShardExtractionAuthorityReference(fixture.reference);
    const input = {
      provenanceContents: JSON.stringify(fixture.compact),
      referenceContents,
      globalAuthority
    };

    expect(verifyShardRunProvenance(input).hydrated.extraction_cache)
      .toHaveProperty("content_closure_index");
    expect(() => verifyShardRunProvenance({
      ...input,
      provenanceContents: JSON.stringify({
        ...fixture.compact,
        seed_capabilities: { facet_tags_enabled: true }
      })
    })).toThrow(/product-default/u);
  });
});

async function authorityFixture() {
  const root = await mkdtemp(join(tmpdir(), "lme-global-authority-"));
  roots.push(root);
  const source = makeShardProvenance(0, 1);
  const promotion = promotionIdentity(source.dataset_sha256!);
  const base = {
    ...source,
    code: {
      ...source.code,
      ...promotion.code,
      gate_sha256: promotion.contract_sha256
    },
    runtime: productRuntime(),
    recall_config: canonicalProductRecallProvenanceConfig(),
    seed_capabilities: { facet_tags_enabled: false }
  };
  const cache = expansionCache(base.extraction_cache!);
  if (cache.schema_version !== 3) throw new Error("fixture requires v3 cache");
  const { manifest_sha256: manifestSha256, ...manifest } = cache;
  const summary = buildSnapshotExtractionSummary(manifest, manifestSha256);
  const authority = buildSnapshotExtractionAuthority(manifest, manifestSha256, summary);
  const full = {
    ...base,
    extraction_cache: {
      ...summary,
      content_closure_index: manifest.content_closure_index,
      storage: cache.storage,
      built_at: cache.built_at,
      builder: cache.builder
    }
  };
  const bytes = renderSnapshotExtractionAuthority(authority);
  await writeFile(join(root, LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME), bytes);
  const fanout = buildFanout(authority, bytes);
  const fanoutBytes = Buffer.from(`${JSON.stringify(fanout)}\n`, "utf8");
  const fanoutDescriptor = longMemEvalArtifactDescriptor(
    LONGMEMEVAL_FANOUT_AUTHORITY_FILENAME,
    fanoutBytes
  );
  await writeFile(join(root, LONGMEMEVAL_FANOUT_AUTHORITY_FILENAME), fanoutBytes);
  const compact = compactSnapshotRunProvenance(full);
  const reference = buildShardExtractionAuthorityReference({
    compact,
    captured: { compact: summary, authority, bytes },
    fanoutChild: {
      authority: fanout,
      descriptor: fanoutDescriptor,
      plan: fanout.plans[0]!
    }
  });
  return { root, compact, authority, reference };
}

function productRuntime() {
  const modelArtifactSha256 = "f".repeat(64);
  return {
    node_version: "v24.0.0",
    platform: "linux",
    arch: "x64",
    embedding_mode: "env" as const,
    embedding_provider_kind: "local_onnx" as const,
    embedding_provider_label: `local_onnx:${DEFAULT_LOCAL_ONNX_MODEL_ID}`,
    onnx_threads: null,
    onnx_model_artifact_sha256: modelArtifactSha256,
    embedding_supplement: {
      enabled: true as const,
      provider_kind: "local_onnx" as const,
      effective_model_id: DEFAULT_LOCAL_ONNX_MODEL_ID,
      model_artifact_sha256: modelArtifactSha256,
      effective_schema_version: 1 as const,
      d2q_input: "raw_content" as const
    },
    answer_rerank: { enabled: false as const },
    paired_env: {}
  };
}

function expansionCache(cache: NonNullable<ReturnType<typeof makeShardProvenance>["extraction_cache"]>) {
  if (cache.schema_version !== 3) throw new Error("fixture requires v3 cache");
  const expectedTurns = cache.expected_turns;
  const expectedKeySetSha256 = cache.expected_key_set_sha256;
  const contentClosureSha256 = cache.content_closure_sha256;
  if (expectedTurns === undefined || expectedKeySetSha256 === undefined ||
      contentClosureSha256 === undefined) {
    throw new Error("fixture requires extraction closure identity");
  }
  const promotion = promotionIdentity(cache.dataset_revision);
  const target = {
    extraction_model: cache.extraction_model,
    model_family: cache.model_family,
    request_profile: cache.request_profile,
    provider_url: cache.provider_url,
    system_prompt_sha256: cache.system_prompt_sha256,
    cache_key_algo: cache.cache_key_algo,
    dataset: cache.dataset,
    dataset_revision: cache.dataset_revision,
    window_offset: 0 as const,
    window_limit: 500 as const,
    expected_turns: expectedTurns,
    expected_key_set_sha256: expectedKeySetSha256
  };
  const shared = {
    ...promotion,
    source_snapshot: {
      db_path: "source.sqlite",
      manifest_sha256: "1".repeat(64),
      db_sha256: "2".repeat(64),
      sidecar_sha256: "3".repeat(64)
    },
    source_cache: {
      manifest_sha256: "4".repeat(64),
      extraction_model: cache.extraction_model,
      model_family: cache.model_family,
      request_profile: cache.request_profile,
      provider_url: cache.provider_url,
      system_prompt_sha256: cache.system_prompt_sha256,
      cache_key_algo: cache.cache_key_algo,
      dataset: cache.dataset,
      dataset_revision: cache.dataset_revision,
      window_offset: 0 as const,
      window_limit: 100 as const,
      expected_turns: expectedTurns,
      expected_key_set_sha256: expectedKeySetSha256,
      content_closure_sha256: contentClosureSha256
    }
  };
  return {
    ...cache,
    window_limit: 500,
    expansion_source_anchor: {
      schema_version: 1 as const,
      kind: "longmemeval_100_to_500_source_anchor" as const,
      ...shared,
      target_cache: target
    },
    expansion_lineage: {
      schema_version: 1 as const,
      kind: "longmemeval_100_to_500_expansion" as const,
      ...shared,
      target_cache: { ...target, content_closure_sha256: contentClosureSha256 }
    }
  };
}

function buildFanout(
  authority: ReturnType<typeof buildSnapshotExtractionAuthority>,
  bytes: Uint8Array
) {
  const descriptor = longMemEvalArtifactDescriptor(
    LONGMEMEVAL_EXTRACTION_AUTHORITY_FILENAME,
    bytes
  );
  const promotion = promotionIdentity(authority.dataset_revision);
  return LongMemEvalFanoutAuthoritySchema.parse({
    schema_version: 1,
    kind: "longmemeval_parent_fanout_authority",
    run_nonce: "11111111-1111-4111-8111-111111111111",
    promotion,
    dataset: { variant: "longmemeval_s", sha256: authority.dataset_revision },
    cache: {
      extraction_authority: descriptor,
      source_manifest_sha256: authority.source_manifest_sha256,
      content_closure_sha256: authority.content_closure_sha256,
      expansion_source_anchor_sha256: authority.expansion_source_anchor_sha256,
      expansion_lineage_sha256: authority.expansion_lineage_sha256
    },
    code: promotion.code,
    requested_concurrency: 2,
    effective_concurrency: 2,
    plans: [
      { shard_index: 0, offset: 0, limit: 1 },
      { shard_index: 1, offset: 1, limit: 499 }
    ]
  });
}

function promotionIdentity(datasetSha256: string) {
  return {
    contract_sha256: "5".repeat(64),
    policy_version: "longmemeval-product-default-v1" as const,
    code: {
      commit_sha: "8".repeat(40),
      commit_sha7: "8".repeat(7),
      worktree_state_sha256: "9".repeat(64),
      executed_dist: {
        algorithm: "sha256-reachable-path-file-sha256-v1" as const,
        sha256: "a".repeat(64),
        file_count: 10
      }
    },
    source_selection: selection(datasetSha256, 100),
    next_selection: selection(datasetSha256, 500),
    matrix_sha256: "6".repeat(64),
    product_default: {
      cell: "B" as const,
      treatment: { embedding_supplement: true, answer_rerank: false },
      bundle_sha256: "7".repeat(64)
    }
  };
}

function selection(datasetSha256: string, count: number) {
  return createLongMemEvalSelectionContractIdentity({
    datasetSha256,
    assignments: Array.from({ length: count }, (_, index) => ({
      question_id: `q-${index}`,
      dataset_cohort: "answerable" as const
    }))
  });
}
