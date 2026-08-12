import { lstatSync, realpathSync } from "node:fs";
import { cacheFilePath } from "../../../compile-seed/compile-seed-cache.js";
import type { CompileSeedExtractionConfig } from
  "../../../compile-seed/compile-seed-types.js";
import {
  inspectCachedResponseMetadata, type CachedExtractionResponseMetadata
} from
  "../../../compile-seed/cache/cached-response-metadata.js";
import {
  computeExtractionRawJsonSha256, inspectExtractionRawJson
} from "../../content-closure.js";
import { isExtractionTransportProvenance } from "../../transport-route.js";
import {
  inspectExtractionCacheInventory,
  type ExtractionCacheInventory, type ExtractionCacheShard
} from "../inventory.js";
import { readStableRegularFileNoFollow } from "./descriptor-io.js";
import type { MaterializationShardDescriptor } from "./contract.js";
import { decodeCanonicalUtf8Artifact } from "../bounded-artifact-reader.js";
import { isStableLeasePath } from "../../fill/manifest/fill-root-guard.js";

export function inspectBoundedMaterializationInventory(input: {
  readonly sourceRoot: string;
  readonly audited: ExtractionCacheInventory;
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
  readonly maxShardBytes: number;
}): {
  readonly inventory: ExtractionCacheInventory;
  readonly descriptors: readonly MaterializationShardDescriptor[];
} {
  const auditedKeys = input.audited.shards.map((shard) => shard.cacheKey);
  const canonicalKeys = [...new Set(auditedKeys)]
    .sort((left, right) => left.localeCompare(right));
  if (!sameStrings(auditedKeys, canonicalKeys)) {
    throw new Error("audited cache inventory keys are not canonical");
  }
  const discovered = inspectExtractionCacheInventory({
    cacheRoot: input.sourceRoot, cacheKeys: [],
    model: input.model, requestProfile: input.requestProfile
  });
  const expected = new Set(auditedKeys);
  const inspected = input.audited.shards.map((shard) => inspectShard(input, shard.cacheKey));
  const shards = inspected.map((entry) => entry.shard);
  const discoveredRetiredKeys = discovered.orphanKeys.filter((key) => !expected.has(key));
  if (!sameStrings(discoveredRetiredKeys, input.audited.retiredKeys)) {
    throw new Error("live source retired-key set changed since cache audit");
  }
  const orphanKeys: readonly string[] = [];
  return Object.freeze({
    inventory: Object.freeze({
      shards: Object.freeze(shards), orphanKeys: Object.freeze(orphanKeys),
      retiredKeys: Object.freeze(input.audited.retiredKeys),
      controlArtifactPaths: discovered.controlArtifactPaths,
      unexpectedPaths: discovered.unexpectedPaths,
      counts: Object.freeze(countsFor(shards, orphanKeys))
    }),
    descriptors: Object.freeze(inspected.flatMap((entry) =>
      entry.descriptor === undefined ? [] : [entry.descriptor]
    ))
  });
}

function inspectShard(
  input: Parameters<typeof inspectBoundedMaterializationInventory>[0],
  cacheKey: string
): { readonly shard: ExtractionCacheShard; readonly descriptor?: MaterializationShardDescriptor } {
  const path = cacheFilePath(input.sourceRoot, cacheKey);
  if (!existsNoFollow(path)) return { shard: Object.freeze({ cacheKey, status: "missing" }) };
  if (!isStableLeasePath(path) && realpathSync(path) !== path) {
    throw new Error("existing audited cache shard path is not canonical");
  }
  const read = readStableRegularFileNoFollow(path, input.maxShardBytes);
  const shard = inspectShardBytes(read.bytes, cacheKey, input.model, input.requestProfile);
  if (shard.status !== "hit" || shard.rawJsonSha256 === undefined) return { shard };
  return {
    shard,
    descriptor: Object.freeze({
      cache_key: cacheKey, raw_json_sha256: shard.rawJsonSha256,
      file_sha256: read.identity.sha256, byte_length: read.identity.byteLength
    })
  };
}

function inspectShardBytes(
  bytes: Buffer,
  cacheKey: string,
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"]
): ExtractionCacheShard {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(decodeCanonicalUtf8Artifact(
      bytes, `materialization source shard ${cacheKey}`
    )) as Record<string, unknown>;
  } catch (cause) {
    return invalid(cacheKey, `invalid cache shard JSON: ${errorMessage(cause)}`);
  }
  const identityError = cachedIdentityError(parsed, cacheKey, model, requestProfile);
  if (identityError !== undefined) return invalid(cacheKey, identityError);
  const rawJson = parsed.raw_json as string;
  const rawJsonSha256 = computeExtractionRawJsonSha256(rawJson);
  try {
    inspectCachedResponseMetadata(
      parsed.response_metadata as CachedExtractionResponseMetadata | undefined
    );
    const content = inspectExtractionRawJson(rawJson);
    return Object.freeze({ cacheKey, status: "hit", ...content });
  } catch (cause) {
    return invalid(cacheKey, `invalid cached extraction: ${errorMessage(cause)}`, rawJsonSha256);
  }
}

function cachedIdentityError(
  parsed: Record<string, unknown>,
  cacheKey: string,
  model: string,
  requestProfile: CompileSeedExtractionConfig["requestProfile"]
): string | undefined {
  if (typeof parsed.raw_json !== "string") return "raw_json must be a string";
  if (parsed.model !== model) return `model ${String(parsed.model)} != ${model}`;
  if (parsed.request_profile !== requestProfile) {
    return `request_profile ${String(parsed.request_profile)} != ${requestProfile}`;
  }
  if (parsed.transport_provenance !== undefined &&
      !isExtractionTransportProvenance(parsed.transport_provenance)) {
    return "transport_provenance is invalid";
  }
  return parsed.cache_key === cacheKey ? undefined : "cache_key does not match fixture path";
}

function invalid(cacheKey: string, reason: string, rawJsonSha256?: string): ExtractionCacheShard {
  return Object.freeze({
    cacheKey, status: "invalid", reason,
    ...(rawJsonSha256 === undefined ? {} : { rawJsonSha256 })
  });
}

function countsFor(shards: readonly ExtractionCacheShard[], orphanKeys: readonly string[]) {
  return Object.freeze({
    expected: shards.length,
    hit: shards.filter((shard) => shard.status === "hit").length,
    missing: shards.filter((shard) => shard.status === "missing").length,
    invalid: shards.filter((shard) => shard.status === "invalid").length,
    orphan: orphanKeys.length
  });
}

function existsNoFollow(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (cause) {
    if (cause instanceof Error && "code" in cause && cause.code === "ENOENT") return false;
    throw cause;
  }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
