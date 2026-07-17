import { normalizeBaseUrl } from "../../compile-seed/compile-seed-config.js";
import type { CompileSeedExtractionConfig } from "../../compile-seed/compile-seed-types.js";
import {
  EXTRACTION_CACHE_KEY_ALGO,
  computeSystemPromptSha256,
  extractionModelFamily,
  type ExtractionCacheManifest
} from "./extraction-cache-manifest.js";
import { ExtractionCacheInvariantError } from "./cache-invariant-error.js";

const GARDEN_MODEL_ENV = "OFFICIAL_API_GARDEN_MODEL";

export function assertExtractionCacheIdentity(input: {
  readonly config: Pick<
    CompileSeedExtractionConfig,
    "model" | "modelFamily" | "providerUrl" | "requestProfile"
  >;
  readonly systemPrompt: string;
  readonly manifest: ExtractionCacheManifest;
  readonly validateProvider: boolean;
}): void {
  assertExtractionModel(input.config.model, input.manifest);
  assertExtractionFamily(input.config, input.manifest);
  assertExtractionRequestProfile(input.config.requestProfile, input.manifest);
  assertExtractionPrompt(input.systemPrompt, input.manifest);
  if (input.manifest.cache_key_algo !== EXTRACTION_CACHE_KEY_ALGO) {
    throw new ExtractionCacheInvariantError(
      "[longmemeval preflight] cache-key algorithm mismatch: " +
        `"${input.manifest.cache_key_algo}" != "${EXTRACTION_CACHE_KEY_ALGO}".`
    );
  }
  if (input.validateProvider) {
    assertExtractionProvider(input.config.providerUrl, input.manifest);
  }
}

function assertExtractionRequestProfile(
  requestProfile: CompileSeedExtractionConfig["requestProfile"],
  manifest: ExtractionCacheManifest
): void {
  if (manifest.schema_version === 3 && manifest.request_profile === requestProfile) return;
  const cached = manifest.schema_version === 3 ? manifest.request_profile : "legacy-implicit";
  throw new ExtractionCacheInvariantError(
    "[longmemeval preflight] extraction request profile mismatch: resolved profile " +
      `"${requestProfile}" != cached profile "${cached}" ` +
      `(schema_version ${manifest.schema_version}).`
  );
}

function assertExtractionModel(model: string, manifest: ExtractionCacheManifest): void {
  if (model === manifest.extraction_model) return;
  throw new ExtractionCacheInvariantError(
    "[longmemeval preflight] extraction model mismatch: resolved model " +
      `"${model}" != cache manifest extraction_model ` +
      `"${manifest.extraction_model}". The cache would miss every key and ` +
      "this run would be a full live extraction (~466h). Set " +
      `${GARDEN_MODEL_ENV}=${manifest.extraction_model} in the bench ` +
      "environment or rebuild the cache for the new model."
  );
}

function assertExtractionFamily(
  config: Pick<CompileSeedExtractionConfig, "model" | "modelFamily">,
  manifest: ExtractionCacheManifest
): void {
  const resolvedFamily = config.modelFamily ?? config.model;
  const cachedFamily = extractionModelFamily(manifest);
  if (resolvedFamily === cachedFamily) return;
  throw new ExtractionCacheInvariantError(
    "[longmemeval preflight] model family mismatch: resolved family " +
      `"${resolvedFamily}" != cache manifest family "${cachedFamily}".`
  );
}

function assertExtractionPrompt(
  systemPrompt: string,
  manifest: ExtractionCacheManifest
): void {
  const digest = computeSystemPromptSha256(systemPrompt);
  if (digest === manifest.system_prompt_sha256) return;
  throw new ExtractionCacheInvariantError(
    "[longmemeval preflight] system prompt drift: sha256(systemPrompt) " +
      `"${digest}" != cache manifest system_prompt_sha256 ` +
      `"${manifest.system_prompt_sha256}". A prompt change invalidates every ` +
      "cache key, so this run would re-extract the entire dataset live."
  );
}

function assertExtractionProvider(
  providerUrl: string,
  manifest: ExtractionCacheManifest
): void {
  const resolved = normalizeBaseUrl(providerUrl);
  const cached = normalizeBaseUrl(manifest.provider_url);
  if (resolved === cached) return;
  throw new ExtractionCacheInvariantError(
    "[longmemeval preflight] provider URL mismatch during live extraction: " +
      `"${resolved}" != cache manifest provider_url "${cached}". ` +
      "Use a new cache root instead of mixing provider sources."
  );
}
