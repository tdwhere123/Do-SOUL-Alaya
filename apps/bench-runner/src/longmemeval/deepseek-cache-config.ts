import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { OFFICIAL_API_SYSTEM_PROMPT } from "@do-soul/alaya-soul";
import {
  computeSystemPromptSha256,
  extractionCacheManifestPath,
  readExtractionCacheManifest,
  type ExtractionCacheManifest
} from "./extraction-cache-manifest.js";
import type { CompileSeedExtractionConfig } from "./compile-seed-types.js";

const __dirname = fileURLToPath(new URL(".", import.meta.url));

export const DEEPSEEK_WARM_SUBSTRATE_MODEL = "deepseek-v4-flash";

export const DEEPSEEK_WARM_SUBSTRATE_CACHE_ROOT = resolve(
  __dirname,
  "../../../../.do-it/bench-runs/seeds/longmemeval-s-extraction-cache/deepseek-v4-flash-nonthinking/cache"
);

export function isDeepSeekWarmSubstrateCacheRoot(cacheRoot: string): boolean {
  return resolve(cacheRoot) === resolve(DEEPSEEK_WARM_SUBSTRATE_CACHE_ROOT);
}

export function assertDeepSeekWarmSubstrateManifestPresent(cacheRoot: string): ExtractionCacheManifest {
  if (!existsSync(extractionCacheManifestPath(cacheRoot))) {
    throw new Error(
      "[longmemeval preflight] DeepSeek warm-substrate cache manifest is missing at " +
        `${cacheRoot}. Card 3 requires the committed extraction cache; rebuild or ` +
        "restore the seed cache before running cache-only bench smoke."
    );
  }
  const manifest = readExtractionCacheManifest(cacheRoot);
  if (manifest === undefined) {
    throw new Error(
      "[longmemeval preflight] DeepSeek warm-substrate cache manifest is unreadable at " +
        `${cacheRoot}.`
    );
  }
  return manifest;
}

export function validateDeepSeekWarmSubstrateManifest(input: {
  readonly manifest: ExtractionCacheManifest;
  readonly config: CompileSeedExtractionConfig;
}): void {
  if (input.config.model !== DEEPSEEK_WARM_SUBSTRATE_MODEL) {
    throw new Error(
      "[longmemeval preflight] DeepSeek warm-substrate requires extraction model " +
        `"${DEEPSEEK_WARM_SUBSTRATE_MODEL}"; resolved "${input.config.model}".`
    );
  }
  if (input.manifest.extraction_model !== DEEPSEEK_WARM_SUBSTRATE_MODEL) {
    throw new Error(
      "[longmemeval preflight] DeepSeek warm-substrate manifest extraction_model " +
        `"${input.manifest.extraction_model}" != "${DEEPSEEK_WARM_SUBSTRATE_MODEL}".`
    );
  }
  const promptSha = computeSystemPromptSha256(OFFICIAL_API_SYSTEM_PROMPT);
  if (input.manifest.system_prompt_sha256 !== promptSha) {
    throw new Error(
      "[longmemeval preflight] DeepSeek warm-substrate system prompt sha256 mismatch."
    );
  }
  if (input.manifest.coverage !== 1) {
    throw new Error(
      "[longmemeval preflight] DeepSeek warm-substrate requires cache coverage=1; " +
        `manifest reports ${String(input.manifest.coverage)}.`
    );
  }
}

export function preflightDeepSeekWarmSubstrateCache(input: {
  readonly cacheRoot: string;
  readonly config: CompileSeedExtractionConfig;
  readonly allowLiveExtraction?: boolean;
  readonly requiredTurnContents?: readonly string[];
  readonly liveExtractionPossible?: boolean;
}): void {
  if (!isDeepSeekWarmSubstrateCacheRoot(input.cacheRoot)) {
    return;
  }
  if (input.config.model !== DEEPSEEK_WARM_SUBSTRATE_MODEL) {
    return;
  }
  const manifest = assertDeepSeekWarmSubstrateManifestPresent(input.cacheRoot);
  validateDeepSeekWarmSubstrateManifest({ manifest, config: input.config });
}
