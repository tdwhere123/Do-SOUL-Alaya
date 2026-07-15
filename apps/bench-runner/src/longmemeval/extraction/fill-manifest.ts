import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import type { CompileSeedExtractionConfig } from "../compile-seed-types.js";
import type { LongMemEvalVariant } from "../dataset.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  EXTRACTION_CACHE_MANIFEST_VERSION,
  computeSystemPromptSha256,
  readExtractionCacheManifestIdentity,
  writeExtractionCacheManifest,
  type ExtractionCacheManifest
} from "../extraction-cache-manifest.js";
import { ExtractionCacheInvariantError } from "./cache-invariant-error.js";
import { assertManifestlessCacheIsEmpty } from "./fill-root-guard.js";

export function buildFillManifest(input: {
  readonly config: CompileSeedExtractionConfig;
  readonly variant: LongMemEvalVariant;
  readonly existingManifest: ExtractionCacheManifest | undefined;
  readonly datasetRevision: string;
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
    dataset_revision: input.datasetRevision,
    requested_turns: input.requestedTurns,
    cached_turns: input.cachedTurns,
    coverage: input.coverage,
    storage: input.existingManifest?.storage ?? "git-tracked",
    built_at: new Date().toISOString(),
    builder: "extraction-fill"
  };
}

export function pinExtractionCacheIdentity(input: {
  readonly cacheRoot: string;
  readonly config: CompileSeedExtractionConfig;
  readonly variant: LongMemEvalVariant;
  readonly existingIdentity: ReturnType<typeof readExtractionCacheManifestIdentity>;
  readonly requestedTurns: number;
  readonly datasetRevision: string;
}): { readonly manifest: ExtractionCacheManifest; readonly manifestSha256: string } {
  if (input.existingIdentity === undefined) {
    writeExtractionCacheManifest(input.cacheRoot, buildFillManifest({
      config: input.config,
      variant: input.variant,
      existingManifest: undefined,
      datasetRevision: input.datasetRevision,
      requestedTurns: input.requestedTurns,
      cachedTurns: 0,
      coverage: input.requestedTurns === 0 ? 1 : 0
    }));
  } else if (input.existingIdentity.manifest.dataset_revision === input.datasetRevision) {
    return input.existingIdentity;
  } else if (input.existingIdentity.manifest.dataset_revision === "unpinned") {
    assertUnpinnedCacheIsEmpty(input.cacheRoot, input.existingIdentity.manifest);
    writeExtractionCacheManifest(input.cacheRoot, {
      ...input.existingIdentity.manifest,
      dataset_revision: input.datasetRevision,
      built_at: new Date().toISOString(),
      builder: "extraction-fill"
    });
  } else {
    throw new ExtractionCacheInvariantError(
      "extraction cache dataset revision mismatch: " +
        `manifest=${input.existingIdentity.manifest.dataset_revision} ` +
        `verified=${input.datasetRevision}`
    );
  }
  const identity = readExtractionCacheManifestIdentity(input.cacheRoot);
  if (identity === undefined) {
    throw new ExtractionCacheInvariantError(
      "extraction-fill failed to pin its cache manifest identity"
    );
  }
  return identity;
}

function assertUnpinnedCacheIsEmpty(
  cacheRoot: string,
  manifest: ExtractionCacheManifest
): void {
  if (manifest.requested_turns !== 0 || manifest.cached_turns !== 0) {
    throw new ExtractionCacheInvariantError(
      "unpinned non-empty extraction cache cannot acquire dataset provenance; " +
        "use a new cache root"
    );
  }
  assertManifestlessCacheIsEmpty(cacheRoot);
}
