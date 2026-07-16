import { mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import { afterEach, beforeEach } from "vitest";

import type { CompileSeedExtractionConfig } from "../../longmemeval/compile-seed.js";
import {
  cacheFilePath,
  computeCacheKey,
  computeExtractionContentClosureSha256,
  computeExtractionKeySetSha256,
  inspectExtractionRawJson
} from "../../longmemeval/compile-seed-cache.js";
import {
  computeSystemPromptSha256,
  EXTRACTION_CACHE_KEY_ALGO,
  type ExtractionCacheManifestV3
} from "../../longmemeval/extraction-cache-manifest.js";

export const EXTRACTION_CONFIG: CompileSeedExtractionConfig = {
  providerUrl: "https://yunwu.ai/v1",
  model: "gpt-5.4-mini",
  requestProfile: "provider-default-v1",
  apiKey: "test-key"
};

export function manifestFor(
  overrides: Partial<Omit<ExtractionCacheManifestV3, "schema_version">> = {}
): ExtractionCacheManifestV3 {
  return {
    schema_version: 3,
    extraction_model: "gpt-5.4-mini",
    model_family: "gpt-5.4-mini",
    request_profile: "provider-default-v1",
    provider_url: "https://yunwu.ai/v1",
    system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "longmemeval-s",
    dataset_revision: "rev",
    requested_turns: 100,
    cached_turns: 100,
    coverage: 1,
    storage: "git-tracked",
    built_at: "2026-05-27T00:00:00Z",
    builder: "test",
    ...overrides
  };
}

export function scopedManifestFor(
  turnContents: readonly string[],
  fillStatus: "in_progress" | "complete"
): ExtractionCacheManifestV3 {
  const keys = [...new Set(turnContents.map((turnContent) => computeCacheKey(
    EXTRACTION_CONFIG.model,
    EXTRACTION_CONFIG.requestProfile,
    OFFICIAL_API_SYSTEM_PROMPT,
    turnContent
  )))].sort();
  return manifestFor({
    requested_turns: keys.length,
    cached_turns: keys.length,
    coverage: 1,
    fill_status: fillStatus,
    window_offset: 0,
    window_limit: 1,
    expected_turns: keys.length,
    expected_key_set_sha256: computeExtractionKeySetSha256(keys),
    ...(fillStatus === "complete" ? {
      content_closure_sha256: computeExtractionContentClosureSha256(keys.map(
        (cacheKey) => ({
          cacheKey,
          model: EXTRACTION_CONFIG.model,
          requestProfile: EXTRACTION_CONFIG.requestProfile,
          ...inspectExtractionRawJson('{"signals":[]}')
        })
      ))
    } : {})
  });
}

export function writeCacheShard(
  cacheRoot: string,
  model: string,
  turnContent: string,
  rawJson: string
): void {
  const cacheKey = computeCacheKey(
    model,
    EXTRACTION_CONFIG.requestProfile,
    OFFICIAL_API_SYSTEM_PROMPT,
    turnContent
  );
  const filePath = cacheFilePath(cacheRoot, cacheKey);
  mkdirSync(join(cacheRoot, cacheKey.slice(0, 2)), { recursive: true });
  writeFileSync(filePath, `${JSON.stringify({
    model,
    request_profile: EXTRACTION_CONFIG.requestProfile,
    cache_key: cacheKey,
    raw_json: rawJson,
    extracted_at: "2026-07-01T00:00:00Z"
  })}\n`, "utf8");
}

export function registerCacheRootHooks(
  prefix: string,
  setCacheRoot: (cacheRoot: string) => void,
  initialize?: (cacheRoot: string) => void | Promise<void>
): void {
  let cacheRoot = "";
  beforeEach(async () => {
    cacheRoot = await mkdtemp(join(tmpdir(), prefix));
    setCacheRoot(cacheRoot);
    await initialize?.(cacheRoot);
  });
  afterEach(async () => {
    await rm(cacheRoot, { recursive: true, force: true });
  });
}
