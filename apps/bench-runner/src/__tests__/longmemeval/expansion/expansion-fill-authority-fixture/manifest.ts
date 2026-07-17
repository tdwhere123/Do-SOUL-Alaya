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
    storage: "git-tracked",
    built_at: "2026-07-16T00:00:00.000Z",
    builder: "extraction-fill"
  };
}

function buildFixtureClosure(config: FixtureExtractionConfig, expected: number) {
  return syntheticExtractionClosure({
    count: expected,
    model: config.model,
    requestProfile: config.requestProfile,
    seed: expected === 100 ? "expansion-source" : "expansion-target"
  });
}
