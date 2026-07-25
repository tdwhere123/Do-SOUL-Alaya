import {
  EXTRACTION_CACHE_KEY_ALGO,
  computeSystemPromptSha256,
  type ExtractionCacheManifestV3
} from "../../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import type { LongMemEvalExpansionSourceAnchor } from
  "../../../../longmemeval/promotion/expansion/lineage/expansion-source-anchor-schema.js";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import type { CompileSeedExtractionConfig } from
  "../../../../longmemeval/compile-seed/compile-seed-types.js";
import {
  buildSupplementalSourceReceiptExtension,
  createSupplementalSourceReceipt,
  supplementalSourceManifestBinding
} from "../../../../longmemeval/extraction/cache/supplemental-source-receipt.js";
import { syntheticExtractionClosure } from "../../extraction/extraction-closure-fixture.js";

type FixtureExtractionConfig = CompileSeedExtractionConfig & {
  readonly modelFamily: string;
};

export function buildFixtureTargetManifest(
  config: FixtureExtractionConfig,
  anchor: LongMemEvalExpansionSourceAnchor,
  status: "in_progress" | "complete" = "in_progress"
): ExtractionCacheManifestV3 {
  const complete = status === "complete";
  const closure = buildFixtureClosure(config, 500);
  const {
    content_closure_sha256: _contentClosureSha256,
    content_closure_index: _contentClosureIndex,
    ...source
  } = buildFixtureSourceManifest(config);
  return {
    ...source,
    fill_status: status,
    window_limit: 500,
    expected_turns: closure.expected_turns,
    expected_key_set_sha256: closure.expected_key_set_sha256,
    requested_turns: 500,
    cached_turns: complete ? 500 : 100,
    coverage: complete ? 1 : 0.2,
    ...(complete ? {
      content_closure_sha256: closure.content_closure_sha256,
      content_closure_index: closure.content_closure_index
    } : {}),
    expansion_source_anchor: anchor
  };
}

export function buildFixtureSourceManifest(
  config: FixtureExtractionConfig
): ExtractionCacheManifestV3 {
  const closure = buildFixtureClosure(config, 100);
  return {
    schema_version: 3,
    extraction_model: config.model,
    model_family: config.modelFamily,
    request_profile: config.requestProfile,
    provider_url: config.providerUrl,
    system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "longmemeval-s",
    dataset_revision: "d".repeat(64),
    requested_turns: 100,
    cached_turns: 100,
    coverage: 1,
    fill_status: "complete",
    window_offset: 0,
    window_limit: 100,
    ...closure,
    supplemental_source_receipt: fixtureSupplementalSourceBinding(config),
    storage: "git-tracked",
    built_at: "2026-07-16T00:00:00.000Z",
    builder: "extraction-fill"
  };
}

export function fixtureSupplementalSourceBinding(config: FixtureExtractionConfig) {
  return supplementalSourceManifestBinding(fixtureSupplementalReceipts(config).source);
}

export function fixtureSupplementalTargetBinding(config: FixtureExtractionConfig) {
  return supplementalSourceManifestBinding(fixtureSupplementalReceipts(config).target);
}

export function fixtureSupplementalExtension(config: FixtureExtractionConfig) {
  const { source, target } = fixtureSupplementalReceipts(config);
  return buildSupplementalSourceReceiptExtension(
    source,
    target,
    source.logical_cache_identity
  );
}

function fixtureSupplementalReceipts(config: FixtureExtractionConfig) {
  const base = {
    physicalProviderUrl: "https://supplement.example/v1",
    physicalModel: "deepseek-v4-flash",
    logicalProviderUrl: config.providerUrl,
    logicalModel: config.model,
    requestProfile: config.requestProfile,
    systemPromptSha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT)
  };
  const sourceEntries = Object.entries(buildFixtureClosure(config, 100).content_closure_index);
  const sourceShards = sourceEntries.slice(0, 2).map(([cacheKey, [rawSha]]) => ({
    cache_key: cacheKey,
    raw_json_sha256: rawSha
  }));
  const sourceKeys = new Set(sourceShards.map((shard) => shard.cache_key));
  const addedEntry = Object.entries(buildFixtureClosure(config, 500).content_closure_index)
    .find(([cacheKey]) => !sourceKeys.has(cacheKey));
  if (addedEntry === undefined) throw new Error("fixture target has no supplemental shard");
  const addedShard = {
    cache_key: addedEntry[0],
    raw_json_sha256: addedEntry[1][0]
  };
  return {
    source: createSupplementalSourceReceipt({
      ...base,
      createdAt: "2026-07-16T00:00:00.000Z",
      shards: sourceShards
    }),
    target: createSupplementalSourceReceipt({
      ...base,
      createdAt: "2026-07-17T00:00:00.000Z",
      shards: [...sourceShards, addedShard]
    })
  };
}

function buildFixtureClosure(config: FixtureExtractionConfig, expected: number) {
  return syntheticExtractionClosure({
    count: expected,
    model: config.model,
    requestProfile: config.requestProfile,
    seed: "expansion-source"
  });
}
