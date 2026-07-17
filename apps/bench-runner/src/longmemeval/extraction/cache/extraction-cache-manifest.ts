import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync
} from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import {
  parseExtractionFillManifestContract,
  type ExtractionFillManifestContract
} from "../fill/manifest/fill-manifest-contract.js";
import {
  EXTRACTION_REQUEST_PROFILES,
  type ExtractionRequestProfile
} from "../request-profile.js";
import type { LongMemEvalExpansionLineage } from
  "../../promotion/expansion/lineage/expansion-lineage-schema.js";
import type { LongMemEvalExpansionSourceAnchor } from
  "../../promotion/expansion/lineage/expansion-source-anchor-schema.js";
import { parseExpansionManifestArtifacts } from
  "../expansion-manifest-artifacts.js";
import {
  computeExtractionContentClosureSha256,
  extractionContentClosureEntriesFromIndex
} from "../content-closure.js";
export {
  EXTRACTION_REQUEST_PROFILES,
  type ExtractionRequestProfile
} from "../request-profile.js";

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

export const EXTRACTION_CACHE_MANIFEST_VERSION = 3;
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
  "sha256(model\\0requestProfile\\0systemPrompt\\0turnContent)";

export type ExtractionCacheStorage = "git-tracked" | "archive";

/**
 * The persisted manifest shape. `coverage` fields may be populated later by an
 * extraction-fill pass; a freshly-written manifest that only records the build
 * provenance is still valid (the coverage fields are optional so a pre-fill
 * writer does not have to commit to a denominator it cannot yet compute).
 */
interface ExtractionCacheManifestBase extends ExtractionFillManifestContract {
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
  readonly expansion_source_anchor?: LongMemEvalExpansionSourceAnchor;
  readonly expansion_lineage?: LongMemEvalExpansionLineage;
}

export interface ExtractionCacheManifestV1 extends ExtractionCacheManifestBase {
  readonly schema_version: 1;
  readonly model_family?: never;
  readonly request_profile?: never;
}

export interface ExtractionCacheManifestV2 extends ExtractionCacheManifestBase {
  readonly schema_version: 2;
  /** Comparison-only canonical family. It never participates in the raw cache key. */
  readonly model_family: string;
  readonly request_profile?: never;
}

export interface ExtractionCacheManifestV3 extends ExtractionCacheManifestBase {
  readonly schema_version: typeof EXTRACTION_CACHE_MANIFEST_VERSION;
  /** Comparison-only canonical family. It never participates in the raw cache key. */
  readonly model_family: string;
  readonly request_profile: ExtractionRequestProfile;
}

export type ExtractionCacheManifest =
  | ExtractionCacheManifestV1
  | ExtractionCacheManifestV2
  | ExtractionCacheManifestV3;

export interface ExtractionCacheManifestIdentity {
  readonly manifest: ExtractionCacheManifest;
  readonly manifestSha256: string;
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
  return readExtractionCacheManifestIdentity(cacheRoot)?.manifest;
}

export function readExtractionCacheManifestIdentity(
  cacheRoot: string
): ExtractionCacheManifestIdentity | undefined {
  const filePath = extractionCacheManifestPath(cacheRoot);
  if (!existsSync(filePath)) {
    return undefined;
  }
  const raw = readManifestRaw(filePath);
  const manifest = parseExtractionCacheManifestContents(raw, filePath);
  return {
    manifest,
    manifestSha256: createHash("sha256").update(raw, "utf8").digest("hex")
  };
}

function readManifestRaw(filePath: string): string {
  try {
    return readFileSync(filePath, "utf8");
  } catch (cause) {
    throw new Error(
      `extraction cache manifest unreadable at ${filePath}: ${describeCause(cause)}`
    );
  }
}

export function parseExtractionCacheManifestContents(
  raw: string,
  filePath: string
): ExtractionCacheManifest {
  try {
    return validateManifest(JSON.parse(raw), filePath);
  } catch (cause) {
    if (cause instanceof SyntaxError) {
      throw new Error(
        `extraction cache manifest is not valid JSON at ${filePath}: ${cause.message}`
      );
    }
    throw cause;
  }
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
  const validated = validateManifest(manifest, filePath);
  mkdirSync(dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.${randomUUID()}.tmp`;
  writeFileSync(tmpPath, `${JSON.stringify(validated, null, 2)}\n`, "utf8");
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
  const schemaVersion = requireSchemaVersion(record, filePath);
  const common: ExtractionCacheManifestBase = {
    extraction_model: requireNonEmptyString(record.extraction_model, "extraction_model", filePath),
    provider_url: requireNonEmptyString(record.provider_url, "provider_url", filePath),
    system_prompt_sha256: requireNonEmptyString(
      record.system_prompt_sha256,
      "system_prompt_sha256",
      filePath
    ),
    cache_key_algo: requireNonEmptyString(record.cache_key_algo, "cache_key_algo", filePath),
    dataset: requireNonEmptyString(record.dataset, "dataset", filePath),
    dataset_revision: requireNonEmptyString(record.dataset_revision, "dataset_revision", filePath),
    storage: requireStorage(record.storage, filePath),
    built_at: requireNonEmptyString(record.built_at, "built_at", filePath),
    builder: requireNonEmptyString(record.builder, "builder", filePath),
    ...optionalNonnegativeInteger(record.requested_turns, "requested_turns", filePath),
    ...optionalNonnegativeInteger(record.cached_turns, "cached_turns", filePath),
    ...optionalCoverage(record.coverage, filePath),
    ...parseExtractionFillManifestContract(record, filePath),
    ...optionalString(record.archive_url, "archive_url"),
    ...optionalString(record.archive_sha256, "archive_sha256")
  };
  return readVersionedManifest(record, schemaVersion, common, filePath);
}

function requireSchemaVersion(
  record: Readonly<Record<string, unknown>>,
  filePath: string
): 1 | 2 | typeof EXTRACTION_CACHE_MANIFEST_VERSION {
  if (!Object.hasOwn(record, "schema_version")) return 1;
  const version = record.schema_version;
  if (version === 1 || version === 2 || version === EXTRACTION_CACHE_MANIFEST_VERSION) {
    return version;
  }
  if (typeof version !== "number" || !Number.isInteger(version)) {
    throw new Error(
      `extraction cache manifest at ${filePath} has invalid schema_version ${String(version)}`
    );
  }
  throw new Error(
    `extraction cache manifest at ${filePath} has unsupported schema_version ${version}`
  );
}

function readVersionedManifest(
  record: Readonly<Record<string, unknown>>,
  schemaVersion: 1 | 2 | typeof EXTRACTION_CACHE_MANIFEST_VERSION,
  common: ExtractionCacheManifestBase,
  filePath: string
): ExtractionCacheManifest {
  const hasFamily = Object.hasOwn(record, "model_family");
  const hasProfile = Object.hasOwn(record, "request_profile");
  const expansion = parseExpansionManifestArtifacts({
    record, schemaVersion, fill: common, filePath
  });
  if (schemaVersion === 1) {
    if (hasFamily) {
      throw new Error(
        `extraction cache manifest at ${filePath} schema_version 1 must not define model_family`
      );
    }
    assertLegacyProfileAbsent(hasProfile, schemaVersion, filePath);
    assertLegacyClosureIndexAbsent(common, schemaVersion, filePath);
    return { ...common, schema_version: 1 };
  }
  if (!hasFamily) {
    throw new Error(
      `extraction cache manifest at ${filePath} schema_version ${schemaVersion} requires model_family`
    );
  }
  const modelFamily = requireVersionedString(
    record.model_family,
    "model_family",
    filePath
  );
  if (schemaVersion === 2) {
    assertLegacyProfileAbsent(hasProfile, schemaVersion, filePath);
    assertLegacyClosureIndexAbsent(common, schemaVersion, filePath);
    return { ...common, schema_version: 2, model_family: modelFamily };
  }
  const requestProfile = requireRequestProfile(record.request_profile, filePath);
  assertContentClosureIndex(common, requestProfile, filePath);
  return {
    ...common,
    schema_version: schemaVersion,
    model_family: modelFamily,
    request_profile: requestProfile,
    ...expansion
  };
}

function assertContentClosureIndex(
  manifest: ExtractionCacheManifestBase,
  requestProfile: ExtractionRequestProfile,
  filePath: string
): void {
  const index = manifest.content_closure_index;
  if (index === undefined) return;
  const digest = computeExtractionContentClosureSha256(
    extractionContentClosureEntriesFromIndex(
      index,
      manifest.extraction_model,
      requestProfile
    )
  );
  if (digest === manifest.content_closure_sha256) return;
  throw new Error(
    `extraction cache manifest at ${filePath} has inconsistent content closure digest`
  );
}

function assertLegacyProfileAbsent(
  present: boolean,
  schemaVersion: 1 | 2,
  filePath: string
): void {
  if (!present) return;
  throw new Error(
    `extraction cache manifest at ${filePath} schema_version ${schemaVersion} must not define request_profile`
  );
}

function assertLegacyClosureIndexAbsent(
  manifest: ExtractionCacheManifestBase,
  schemaVersion: 1 | 2,
  filePath: string
): void {
  if (manifest.content_closure_index === undefined) return;
  throw new Error(
    `extraction cache manifest at ${filePath} schema_version ${schemaVersion} ` +
      "must not define content_closure_index"
  );
}

function requireRequestProfile(
  value: unknown,
  filePath: string
): ExtractionRequestProfile {
  if (value === "provider-default-v1" || value === "deepseek-v4-nonthinking-v1") {
    return value;
  }
  throw new Error(
    `extraction cache manifest at ${filePath} schema_version 3 requires request_profile ` +
      `to be one of ${EXTRACTION_REQUEST_PROFILES.join(", ")}`
  );
}

function requireVersionedString(
  value: unknown,
  field: string,
  filePath: string
): string {
  if (typeof value === "string" && value.trim().length > 0) return value;
  throw new Error(
    `extraction cache manifest at ${filePath} field "${field}" must be a non-empty string`
  );
}

function requireStorage(value: unknown, filePath: string): ExtractionCacheStorage {
  if (value === "git-tracked" || value === "archive") return value;
  throw new Error(
    `extraction cache manifest at ${filePath} has invalid storage ` +
      `"${String(value)}"; expected "git-tracked" or "archive"`
  );
}

export function extractionModelFamily(
  manifest: { readonly extraction_model: string; readonly model_family?: string }
): string {
  return manifest.model_family ?? manifest.extraction_model;
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

function optionalNonnegativeInteger(
  value: unknown,
  field: string,
  filePath: string
): Record<string, number> {
  if (value === undefined) {
    return {};
  }
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new Error(
      `extraction cache manifest at ${filePath} field "${field}" must be a ` +
        `non-negative integer when present`
    );
  }
  return { [field]: value };
}

function optionalCoverage(value: unknown, filePath: string): Record<string, number> {
  if (value === undefined) return {};
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new Error(
      `extraction cache manifest at ${filePath} field "coverage" must be in [0, 1]`
    );
  }
  return { coverage: value };
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
