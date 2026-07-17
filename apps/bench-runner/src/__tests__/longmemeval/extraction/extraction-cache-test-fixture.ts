import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION,
  computeSystemPromptSha256,
  writeExtractionCacheManifest
} from "../../../longmemeval/extraction/cache/extraction-cache-manifest.js";

const TEST_EXTRACTION_PROVIDER_URL = "https://provider.invalid/v1";

export function writeExtractionCacheTestManifest(input: {
  readonly cacheRoot: string;
  readonly model: string;
  readonly systemPrompt: string;
  readonly modelFamily?: string;
  readonly providerUrl?: string;
  readonly requestProfile?: "provider-default-v1" | "deepseek-v4-nonthinking-v1";
}): void {
  writeExtractionCacheManifest(input.cacheRoot, {
    schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
    extraction_model: input.model,
    model_family: input.modelFamily ?? input.model,
    request_profile: input.requestProfile ?? "provider-default-v1",
    provider_url: input.providerUrl ?? TEST_EXTRACTION_PROVIDER_URL,
    system_prompt_sha256: computeSystemPromptSha256(input.systemPrompt),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: "test-fixture",
    dataset_revision: "test-fixture",
    storage: "git-tracked",
    built_at: "2026-07-12T00:00:00.000Z",
    builder: "test"
  });
}

export { TEST_EXTRACTION_PROVIDER_URL };
