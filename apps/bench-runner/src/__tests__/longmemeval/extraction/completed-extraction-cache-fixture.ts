import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  cacheFilePath,
  computeCacheKey,
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  inspectExtractionRawJson
} from "../../../longmemeval/compile-seed/compile-seed-cache.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  computeSystemPromptSha256,
  writeExtractionCacheManifest,
  type ExtractionCacheManifestV3
} from "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";
import { buildExtractionContentClosureIndex } from "../../../longmemeval/extraction/content-closure.js";

const DEFAULT_RAW_JSON = '{"signals":[]}';

export function writeCompletedExtractionCacheFixture(input: {
  readonly cacheRoot: string;
  readonly turnContents: readonly string[];
  readonly datasetRevision: string;
  readonly windowOffset: number;
  readonly windowLimit: number;
  readonly model?: string;
  readonly rawJson?: string;
}): ExtractionCacheManifestV3 {
  const model = input.model ?? "test-extraction-model";
  const requestProfile = "provider-default-v1" as const;
  const rawJson = input.rawJson ?? DEFAULT_RAW_JSON;
  const keys = [...new Set(input.turnContents.map((turnContent) => computeCacheKey(
    model,
    requestProfile,
    OFFICIAL_API_SYSTEM_PROMPT,
    turnContent
  )))].sort();
  for (const cacheKey of keys) writeShard(input.cacheRoot, cacheKey, model, rawJson);
  const closureEntries = keys.map((cacheKey) => ({
    cacheKey,
    model,
    requestProfile,
    ...inspectExtractionRawJson(rawJson)
  }));
  const manifest: ExtractionCacheManifestV3 = {
    schema_version: 3,
    extraction_model: model,
    model_family: model,
    request_profile: requestProfile,
    provider_url: "https://provider.invalid/v1",
    system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "longmemeval-s",
    dataset_revision: input.datasetRevision,
    requested_turns: keys.length,
    cached_turns: keys.length,
    coverage: 1,
    storage: "git-tracked",
    built_at: "2026-07-16T00:00:00.000Z",
    builder: "test",
    fill_status: "complete",
    window_offset: input.windowOffset,
    window_limit: input.windowLimit,
    expected_turns: keys.length,
    expected_key_set_sha256: computeExtractionKeySetSha256(keys),
    content_closure_sha256: computeExtractionContentClosureSha256(closureEntries),
    content_closure_index: buildExtractionContentClosureIndex(closureEntries)
  };
  writeExtractionCacheManifest(input.cacheRoot, manifest);
  return manifest;
}

function writeShard(
  cacheRoot: string,
  cacheKey: string,
  model: string,
  rawJson: string
): void {
  const filePath = cacheFilePath(cacheRoot, cacheKey);
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({
    model,
    request_profile: "provider-default-v1",
    cache_key: cacheKey,
    raw_json: rawJson,
    extracted_at: "2026-07-16T00:00:00.000Z"
  })}\n`, "utf8");
}
