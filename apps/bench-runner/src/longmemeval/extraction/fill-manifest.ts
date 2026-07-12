import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import type { CompileSeedExtractionConfig } from "../compile-seed-types.js";
import type { LongMemEvalVariant } from "../dataset.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION,
  computeSystemPromptSha256,
  type ExtractionCacheManifest
} from "../extraction-cache-manifest.js";

export function buildFillManifest(input: {
  readonly config: CompileSeedExtractionConfig;
  readonly variant: LongMemEvalVariant;
  readonly existingManifest: ExtractionCacheManifest | undefined;
  readonly requestedTurns: number;
  readonly cachedTurns: number;
  readonly coverage: number;
}): ExtractionCacheManifest {
  return {
    schema_version: EXTRACTION_CACHE_MANIFEST_VERSION,
    extraction_model: input.config.model,
    model_family: input.config.modelFamily ?? input.config.model,
    request_profile: input.config.requestProfile,
    provider_url: input.config.providerUrl,
    system_prompt_sha256: computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT),
    cache_key_algo: EXTRACTION_CACHE_KEY_ALGO,
    dataset: input.variant.replace(/_/u, "-"),
    dataset_revision: input.existingManifest?.dataset_revision ?? "unpinned",
    requested_turns: input.requestedTurns,
    cached_turns: input.cachedTurns,
    coverage: input.coverage,
    storage: input.existingManifest?.storage ?? "git-tracked",
    built_at: new Date().toISOString(),
    builder: "extraction-fill"
  };
}
