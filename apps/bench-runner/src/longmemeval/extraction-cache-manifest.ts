import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";

/**
 * @anchor longmemeval-extraction-cache-manifest
 *
 * Self-describing manifest for the LongMemEval extraction cache. It is the
 * SINGLE source of truth for what model / prompt / dataset a populated cache
 * was built with, so a run can fail loud at start-up instead of silently
 * missing every cache key and degrading to a 466h live extraction (the ROOT
 * BUG: env `OFFICIAL_API_GARDEN_MODEL` unset -> production constant
 * `gpt-4.1-mini` -> 100% cache miss).
 *
 * The manifest lives at the cache root (`manifest.json`) beside the sharded
 * `<key>.json` extraction fixtures. The extraction model recorded here is what
 * run-start derives the effective extraction model from when the operator env
 * is absent — replacing the old "fall back to the compile-time production
 * constant" path with "fall back to the cache's own self-description".
 *
 * cross-file: apps/bench-runner/src/longmemeval/compile-seed.ts
 *   (resolveCompileSeedExtractionConfig, preflightExtractionCache,
 *   computeCacheKey — the cache-key model component MUST equal
 *   extraction_model)
 * cross-file: packages/soul/src/garden/compute-provider.ts
 *   OFFICIAL_API_SYSTEM_PROMPT (the prompt whose sha256 is pinned here)
 */

export const EXTRACTION_CACHE_MANIFEST_VERSION = 1;
export const EXTRACTION_CACHE_MANIFEST_FILENAME = "manifest.json";
export const BENCH_EXTRACTION_MODEL_ENV = "OFFICIAL_API_GARDEN_MODEL";

/**
 * Resolve the bench extraction model from operator env or the cache manifest.
 * Refuses the old silent fallback to the production constant `gpt-4.1-mini`,
 * which produced 100% cache misses when the cache was built with another model.
 */
export function resolveBenchExtractionModel(
  env: NodeJS.ProcessEnv = process.env,
  manifest?: ExtractionCacheManifest | undefined
): string {
  const model =
    readNonEmptyEnv(env[BENCH_EXTRACTION_MODEL_ENV]) ?? manifest?.extraction_model;
  if (model === undefined || model.trim().length === 0) {
    throw new Error(
      "bench extraction model is unresolved: neither env " +
        `${BENCH_EXTRACTION_MODEL_ENV} is set nor does the extraction cache manifest ` +
        "declare extraction_model. Export the extraction model env var " +
        "in the bench environment or build the cache manifest first. Refusing to " +
        "fall back to a default model — a wrong default silently misses every " +
        "cache key and degrades to a full live extraction."
    );
  }
  return model;
}

/**
 * Documented cache-key formula. Pinned in the manifest so a future change to
 * the key derivation (which would silently invalidate every shard) is a
 * detectable mismatch rather than a silent full miss.
 */
export const EXTRACTION_CACHE_KEY_ALGO =
  "sha256(model\\0systemPrompt\\0turnContent)";

export type ExtractionCacheStorage = "git-tracked" | "archive";

/**
 * The persisted manifest shape. `coverage` fields may be populated later by an
 * extraction-fill pass; a freshly-written manifest that only records the build
 * provenance is still valid (the coverage fields are optional so a pre-fill
 * writer does not have to commit to a denominator it cannot yet compute).
 */
export interface ExtractionCacheManifest {
  readonly schema_version: number;
  /** == every cache shard's `.model`; run-start asserts config.model equals this. */
  readonly extraction_model: string;
  /** Reproduces the provider; aligns with DEFAULT_GARDEN_PROVIDER_URL. */
  readonly provider_url: string;
  /** sha256(OFFICIAL_API_SYSTEM_PROMPT); a prompt edit flips this -> mismatch throw. */
  readonly system_prompt_sha256: string;
  /** Documents the key formula so a key-derivation drift is detectable. */
  readonly cache_key_algo: string;
  /** Which dataset the cache was built from, e.g. "longmemeval-s". */
  readonly dataset: string;
  /** Pinned dataset checksum (the <variant>.meta.json sha256). */
  readonly dataset_revision: string;
  /** Total turns the dataset should extract (coverage denominator). */
  readonly requested_turns?: number;
  /** Turns that actually have a fixture (coverage numerator == shard count). */
  readonly cached_turns?: number;
  /** cached_turns / requested_turns, for a one-glance read. */
  readonly coverage?: number;
  readonly storage: ExtractionCacheStorage;
  /** Present when storage === "archive": first-run download URL. */
  readonly archive_url?: string;
  /** Present when storage === "archive": integrity check of the unpacked archive. */
  readonly archive_sha256?: string;
  /** Latest extracted_at across the shards (ISO 8601). */
  readonly built_at: string;
  /** Provenance: what produced this cache. */
  readonly builder: string;
}

/**
 * Compute the prompt hash component the manifest pins. The same hash is
 * recomputed at run-start from the live OFFICIAL_API_SYSTEM_PROMPT and
 * compared against `manifest.system_prompt_sha256`; a one-character prompt
 * edit changes this digest, surfacing the otherwise-silent full cache
 * invalidation as a loud mismatch.
 */
export function computeSystemPromptSha256(systemPrompt: string): string {
  return createHash("sha256").update(systemPrompt, "utf8").digest("hex");
}

export function extractionCacheManifestPath(cacheRoot: string): string {
  return join(cacheRoot, EXTRACTION_CACHE_MANIFEST_FILENAME);
}

/**
 * Read the manifest at the cache root. Returns `undefined` when no manifest
 * file exists (a first-ever build, before any fill pass has run). Throws on a
 * present-but-corrupt manifest — a torn / hand-broken manifest must fail loud,
 * not be silently treated as absent, because "no manifest" is the
 * allow-live-and-warn path.
 */
export function readExtractionCacheManifest(
  cacheRoot: string
): ExtractionCacheManifest | undefined {
  const filePath = extractionCacheManifestPath(cacheRoot);
  if (!existsSync(filePath)) {
    return undefined;
  }
  let raw: string;
  try {
    raw = readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new Error(
      `extraction cache manifest unreadable at ${filePath}: ${describeCause(cause)}`
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(
      `extraction cache manifest is not valid JSON at ${filePath}: ${describeCause(cause)}`
    );
  }
  return validateManifest(parsed, filePath);
}

/**
 * Atomically write the manifest to the cache root (temp + rename, the same
 * crash-safe discipline the shard writer uses, since WSL2 OOM is a known mode
 * in this bench env).
 */
export function writeExtractionCacheManifest(
  cacheRoot: string,
  manifest: ExtractionCacheManifest
): void {
  const filePath = extractionCacheManifestPath(cacheRoot);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  renameSync(tmpPath, filePath);
}

function validateManifest(
  parsed: unknown,
  filePath: string
): ExtractionCacheManifest {
  if (typeof parsed !== "object" || parsed === null) {
    throw new Error(
      `extraction cache manifest at ${filePath} is not a JSON object`
    );
  }
  const record = parsed as Record<string, unknown>;
  const extractionModel = requireNonEmptyString(
    record.extraction_model,
    "extraction_model",
    filePath
  );
  const providerUrl = requireNonEmptyString(
    record.provider_url,
    "provider_url",
    filePath
  );
  const systemPromptSha256 = requireNonEmptyString(
    record.system_prompt_sha256,
    "system_prompt_sha256",
    filePath
  );
  const cacheKeyAlgo = requireNonEmptyString(
    record.cache_key_algo,
    "cache_key_algo",
    filePath
  );
  const dataset = requireNonEmptyString(record.dataset, "dataset", filePath);
  const datasetRevision = requireNonEmptyString(
    record.dataset_revision,
    "dataset_revision",
    filePath
  );
  const builtAt = requireNonEmptyString(record.built_at, "built_at", filePath);
  const builder = requireNonEmptyString(record.builder, "builder", filePath);
  const storage = record.storage;
  if (storage !== "git-tracked" && storage !== "archive") {
    throw new Error(
      `extraction cache manifest at ${filePath} has invalid storage ` +
        `"${String(storage)}"; expected "git-tracked" or "archive"`
    );
  }
  const schemaVersion =
    typeof record.schema_version === "number"
      ? record.schema_version
      : EXTRACTION_CACHE_MANIFEST_VERSION;
  const manifest: ExtractionCacheManifest = {
    schema_version: schemaVersion,
    extraction_model: extractionModel,
    provider_url: providerUrl,
    system_prompt_sha256: systemPromptSha256,
    cache_key_algo: cacheKeyAlgo,
    dataset,
    dataset_revision: datasetRevision,
    storage,
    built_at: builtAt,
    builder,
    ...optionalNumber(record.requested_turns, "requested_turns", filePath),
    ...optionalNumber(record.cached_turns, "cached_turns", filePath),
    ...optionalNumber(record.coverage, "coverage", filePath),
    ...optionalString(record.archive_url, "archive_url"),
    ...optionalString(record.archive_sha256, "archive_sha256")
  };
  return manifest;
}

function requireNonEmptyString(
  value: unknown,
  field: string,
  filePath: string
): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(
      `extraction cache manifest at ${filePath} is missing required ` +
        `string field "${field}"`
    );
  }
  return value;
}

function optionalNumber(
  value: unknown,
  field: string,
  filePath: string
): Record<string, number> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "number" || Number.isNaN(value)) {
    throw new Error(
      `extraction cache manifest at ${filePath} field "${field}" must be a ` +
        `number when present`
    );
  }
  return { [field]: value };
}

function optionalString(
  value: unknown,
  field: string
): Record<string, string> {
  if (value === undefined || value === null) {
    return {};
  }
  if (typeof value !== "string" || value.length === 0) {
    return {};
  }
  return { [field]: value };
}

function describeCause(cause: unknown): string {
  if (cause instanceof Error) {
    return cause.message;
  }
  return String(cause);
}

function readNonEmptyEnv(value: string | undefined): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length === 0 ? undefined : trimmed;
}
