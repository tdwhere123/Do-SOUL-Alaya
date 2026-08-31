import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  assertDiagnosticLoopIdentity,
  isSha256Hex
} from "../../runs/diagnostic-loop/identity.js";
import type { DiagnosticLoopRequest } from "../../runs/diagnostic-loop/types.js";
import { computeExtractionKeySetSha256 } from
  "../../runs/extraction/content-closure.js";
import { readExtractionCacheManifestIdentity } from
  "../../runs/extraction/cache/extraction-cache-manifest.js";
import { hasCompleteExtractionFillAuthority } from
  "../../runs/extraction/fill/fill-authority.js";
import {
  canonicalReplayContractDigests,
  rebuildCanonicalReplayKeys
} from "./canonical-replay-contract.js";

export interface ReplayRequestManifest {
  readonly schema_version: 1;
  readonly kind: "provider_preflight_replay_request";
  readonly request: DiagnosticLoopRequest;
  readonly canonical_keys: {
    readonly count: number;
    readonly key_set_sha256: string;
  };
  readonly cache_authority: {
    readonly manifest_sha256: string;
    readonly content_closure_sha256: string;
    readonly expected_key_set_sha256: string;
    readonly shard_count: number;
    readonly window_offset: number;
    readonly window_limit: number;
  };
  readonly dataset_authority: {
    readonly data_dir?: string;
    readonly pinned_meta_root?: string;
  };
  readonly request_manifest_sha256: string;
}

const MANIFEST_KEYS = [
  "schema_version", "kind", "request", "canonical_keys", "cache_authority",
  "dataset_authority", "request_manifest_sha256"
] as const;
const REQUEST_KEYS = [
  "datasetRevision", "requestedKeys", "providerRoute", "model", "requestProfile",
  "promptDigest", "schemaDigest", "operatorDigest", "cacheMode", "variant",
  "limit", "offset", "worker", "extractionCacheRoot"
] as const;
const CACHE_AUTHORITY_KEYS = [
  "manifest_sha256", "content_closure_sha256", "expected_key_set_sha256",
  "shard_count", "window_offset", "window_limit"
] as const;

export function readReplayRequestManifest(path: string): DiagnosticLoopRequest {
  return readCanonicalReplayRequestManifest(path).request;
}

export function readCanonicalReplayRequestManifest(path: string): ReplayRequestManifest {
  const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  const manifest = requireManifest(value);
  verifyManifestDigest(manifest);
  verifyRequestBinding(manifest);
  verifyCacheBinding(manifest);
  return manifest;
}

function verifyManifestDigest(manifest: ReplayRequestManifest): void {
  const { request_manifest_sha256: actualDigest, ...body } = manifest;
  const expectedDigest = createHash("sha256")
    .update(JSON.stringify(body), "utf8")
    .digest("hex");
  if (actualDigest !== expectedDigest) {
    throw new Error("replay request manifest digest mismatch");
  }
}

function verifyRequestBinding(manifest: ReplayRequestManifest): void {
  assertDiagnosticLoopIdentity(manifest.request);
  if (manifest.request.extractionCacheRoot === undefined) {
    throw new Error("replay request manifest requires extractionCacheRoot");
  }
  if (manifest.request.requestedKeys.length !== manifest.canonical_keys.count) {
    throw new Error("replay request manifest canonical key count mismatch");
  }
  if (computeExtractionKeySetSha256(manifest.request.requestedKeys) !==
      manifest.canonical_keys.key_set_sha256) {
    throw new Error("replay request manifest canonical key identity mismatch");
  }
}

function verifyCacheBinding(manifest: ReplayRequestManifest): void {
  const cacheRoot = manifest.request.extractionCacheRoot;
  if (cacheRoot === undefined) {
    throw new Error("replay request manifest requires extractionCacheRoot");
  }
  const cacheIdentity = readExtractionCacheManifestIdentity(cacheRoot);
  if (cacheIdentity === undefined ||
      cacheIdentity.manifestSha256 !== manifest.cache_authority.manifest_sha256) {
    throw new Error("replay request manifest cache authority is not current");
  }
  const cache = cacheIdentity.manifest;
  if (!hasCompleteExtractionFillAuthority(cache)) {
    throw new Error("replay request manifest requires a sealed complete cache authority");
  }
  if (cache.content_closure_sha256 !== manifest.cache_authority.content_closure_sha256 ||
      cache.expected_key_set_sha256 !== manifest.cache_authority.expected_key_set_sha256 ||
      cache.expected_turns !== manifest.cache_authority.shard_count ||
      cache.window_offset !== manifest.cache_authority.window_offset ||
      cache.window_limit !== manifest.cache_authority.window_limit) {
    throw new Error("replay request manifest cache authority tuple mismatch");
  }
  if (cache.extraction_model !== manifest.request.model ||
      cache.request_profile !== manifest.request.requestProfile ||
      cache.dataset_revision !== manifest.request.datasetRevision ||
      cache.system_prompt_sha256 !== manifest.request.promptDigest ||
      cache.provider_url !== manifest.request.providerRoute) {
    throw new Error("replay request manifest disagrees with cache authority");
  }
  const missing = manifest.request.requestedKeys.filter(
    (key) => cache.content_closure_index[key] === undefined
  );
  if (missing.length > 0) {
    throw new Error(`replay cache authority omits ${missing.length} canonical key(s)`);
  }
}

export async function verifyCanonicalReplayRequestManifest(
  path: string
): Promise<ReplayRequestManifest> {
  const manifest = readCanonicalReplayRequestManifest(path);
  const contract = canonicalReplayContractDigests();
  if (manifest.request.schemaDigest !== contract.schemaDigest ||
      manifest.request.operatorDigest !== contract.operatorDigest) {
    throw new Error("replay request manifest sealed contract digest mismatch");
  }
  const rebuilt = await rebuildCanonicalReplayKeys({
    request: manifest.request,
    ...(manifest.dataset_authority.data_dir === undefined
      ? {} : { dataDir: manifest.dataset_authority.data_dir }),
    ...(manifest.dataset_authority.pinned_meta_root === undefined
      ? {} : { pinnedMetaRoot: manifest.dataset_authority.pinned_meta_root })
  });
  if (rebuilt.length !== manifest.request.requestedKeys.length ||
      rebuilt.some((key, index) => key !== manifest.request.requestedKeys[index])) {
    throw new Error("replay request manifest canonical dataset window mismatch");
  }
  return manifest;
}

function requireManifest(value: unknown): ReplayRequestManifest {
  if (!isRecord(value) || !hasExactKeys(value, MANIFEST_KEYS) ||
      value.schema_version !== 1 ||
      value.kind !== "provider_preflight_replay_request" ||
      !isRecord(value.request) || !validReplayRequest(value.request) ||
      !isRecord(value.canonical_keys) ||
      !hasExactKeys(value.canonical_keys, ["count", "key_set_sha256"]) ||
      !Number.isSafeInteger(value.canonical_keys.count) ||
      (value.canonical_keys.count as number) < 1 ||
      typeof value.canonical_keys.key_set_sha256 !== "string" ||
      !isSha256Hex(value.canonical_keys.key_set_sha256) ||
      !isRecord(value.cache_authority) ||
      !validCacheAuthority(value.cache_authority) ||
      !isRecord(value.dataset_authority) ||
      !validDatasetAuthority(value.dataset_authority) ||
      typeof value.request_manifest_sha256 !== "string" ||
      !isSha256Hex(value.request_manifest_sha256)) {
    throw new Error("invalid provider replay request manifest");
  }
  return value as unknown as ReplayRequestManifest;
}

function validDatasetAuthority(value: Record<string, unknown>): boolean {
  return hasOnlyKeys(value, ["data_dir", "pinned_meta_root"]) &&
    (value.data_dir === undefined || typeof value.data_dir === "string") &&
    (value.pinned_meta_root === undefined || typeof value.pinned_meta_root === "string");
}

function validCacheAuthority(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, CACHE_AUTHORITY_KEYS) &&
    typeof value.manifest_sha256 === "string" && isSha256Hex(value.manifest_sha256) &&
    typeof value.content_closure_sha256 === "string" &&
    isSha256Hex(value.content_closure_sha256) &&
    typeof value.expected_key_set_sha256 === "string" &&
    isSha256Hex(value.expected_key_set_sha256) &&
    Number.isSafeInteger(value.shard_count) && (value.shard_count as number) > 0 &&
    Number.isSafeInteger(value.window_offset) && (value.window_offset as number) >= 0 &&
    Number.isSafeInteger(value.window_limit) && (value.window_limit as number) > 0;
}

function validReplayRequest(value: Record<string, unknown>): boolean {
  return hasExactKeys(value, REQUEST_KEYS) &&
    typeof value.datasetRevision === "string" &&
    Array.isArray(value.requestedKeys) &&
    value.requestedKeys.every((key) => typeof key === "string") &&
    typeof value.providerRoute === "string" && typeof value.model === "string" &&
    typeof value.requestProfile === "string" && typeof value.promptDigest === "string" &&
    typeof value.schemaDigest === "string" && typeof value.operatorDigest === "string" &&
    value.cacheMode === "cache_only" && isReplayVariant(value.variant) &&
    Number.isSafeInteger(value.limit) && (value.limit as number) > 0 &&
    Number.isSafeInteger(value.offset) && (value.offset as number) >= 0 &&
    typeof value.worker === "boolean" &&
    typeof value.extractionCacheRoot === "string" && value.extractionCacheRoot.length > 0;
}

function isReplayVariant(value: unknown): boolean {
  return value === "longmemeval_oracle" || value === "longmemeval_s" ||
    value === "longmemeval_m";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  return Object.keys(value).length === expected.length &&
    expected.every((key) => key in value);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}
