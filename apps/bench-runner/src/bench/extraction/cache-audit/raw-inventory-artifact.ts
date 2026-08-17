import {
  hashExtractionCacheInventory,
  type ExtractionCacheInventory,
  type ExtractionCacheShard
} from "./inventory.js";
import { isSha256 } from "../authority/target-selection/receipt-shape.js";
import { readStableRegularFileNoFollow } from "./materialization/descriptor-io.js";

// A 500Q inventory projects to about 25 MiB at 98k keys; this retains bounded headroom.
const MAX_RAW_INVENTORY_ARTIFACT_BYTES = 64 * 1024 * 1024;

export interface RawInventoryArtifact {
  readonly sha256: string;
  readonly inventory: ExtractionCacheInventory;
}

export function readRawInventoryArtifact(path: string): RawInventoryArtifact {
  let contents: string;
  try {
    const artifact = readStableRegularFileNoFollow(
      path, MAX_RAW_INVENTORY_ARTIFACT_BYTES
    );
    contents = decodeCanonicalUtf8(artifact.bytes);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    throw new Error(
      `failed to read bounded regular raw inventory artifact: ${detail}`,
      { cause }
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(contents) as unknown;
  } catch (cause) {
    throw new Error("invalid raw inventory artifact JSON", { cause });
  }
  if (!isExactRecord(value, ["sha256", "inventory"]) ||
      !isSha256(value.sha256)) {
    throw new Error("invalid raw inventory artifact wrapper");
  }
  const inventory = parseInventory(value.inventory);
  if (hashExtractionCacheInventory(inventory) !== value.sha256) {
    throw new Error("raw inventory sha256 does not bind its inventory");
  }
  return Object.freeze({ sha256: value.sha256, inventory });
}

function decodeCanonicalUtf8(bytes: Uint8Array): string {
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch (cause) {
    throw new Error("raw inventory artifact is not valid UTF-8", { cause });
  }
  if (!Buffer.from(decoded, "utf8").equals(bytes)) {
    throw new Error("raw inventory artifact UTF-8 bytes are not canonical");
  }
  return decoded;
}

function parseInventory(value: unknown): ExtractionCacheInventory {
  if (!isExactRecord(value, [
    "shards", "orphanKeys", "retiredKeys", "controlArtifactPaths",
    "unexpectedPaths", "counts"
  ]) || !Array.isArray(value.shards) || !Array.isArray(value.orphanKeys) ||
      !Array.isArray(value.retiredKeys) || !Array.isArray(value.controlArtifactPaths) ||
      !Array.isArray(value.unexpectedPaths)) {
    throw new Error("invalid raw inventory shape");
  }
  const shards = value.shards.map(parseShard);
  const orphanKeys = parseStringArray(value.orphanKeys, "orphanKeys", isSha256);
  const retiredKeys = parseStringArray(value.retiredKeys, "retiredKeys", isSha256);
  const controlArtifactPaths = parseStringArray(value.controlArtifactPaths, "controlArtifactPaths");
  const unexpectedPaths = parseStringArray(value.unexpectedPaths, "unexpectedPaths");
  const counts = parseCounts(value.counts, shards, orphanKeys);
  assertSortedUnique(shards.map((shard) => shard.cacheKey), "shard cache keys");
  assertSortedUnique(orphanKeys, "orphan keys");
  assertSortedUnique(retiredKeys, "retired keys");
  if (retiredKeys.some((key) => orphanKeys.includes(key) ||
      shards.some((shard) => shard.cacheKey === key))) {
    throw new Error("raw inventory retired keys overlap live inventory");
  }
  assertSortedUnique(controlArtifactPaths, "control artifact paths");
  assertSortedUnique(unexpectedPaths, "unexpected paths");
  return Object.freeze({
    shards: Object.freeze(shards),
    orphanKeys: Object.freeze(orphanKeys),
    retiredKeys: Object.freeze(retiredKeys),
    controlArtifactPaths: Object.freeze(controlArtifactPaths),
    unexpectedPaths: Object.freeze(unexpectedPaths),
    counts: Object.freeze(counts)
  });
}

function parseShard(value: unknown, index: number): ExtractionCacheShard {
  if (!isRecord(value) || !isSha256(value.cacheKey) ||
      !["hit", "missing", "invalid"].includes(String(value.status))) {
    throw new Error(`invalid raw inventory shard[${index}]`);
  }
  if (value.status === "hit") {
    if (!isExactRecord(value, [
      "cacheKey", "status", "rawJsonSha256", "rawSignalCount", "parsedDraftCount"
    ]) || !isSha256(value.rawJsonSha256) || !isCount(value.rawSignalCount) ||
        !isCount(value.parsedDraftCount)) {
      throw new Error(`invalid raw inventory hit shard[${index}]`);
    }
    return Object.freeze(value as unknown as ExtractionCacheShard);
  }
  if (value.status === "missing") {
    if (!isExactRecord(value, ["cacheKey", "status"])) {
      throw new Error(`invalid raw inventory missing shard[${index}]`);
    }
    return Object.freeze(value as unknown as ExtractionCacheShard);
  }
  const keys = Object.keys(value).sort();
  const validKeys = ["cacheKey", "reason", "status"];
  const validKeysWithDigest = ["cacheKey", "rawJsonSha256", "reason", "status"];
  if ((!sameStrings(keys, validKeys) && !sameStrings(keys, validKeysWithDigest)) ||
      typeof value.reason !== "string" || value.reason.length === 0 ||
      (value.rawJsonSha256 !== undefined && !isSha256(value.rawJsonSha256))) {
    throw new Error(`invalid raw inventory invalid shard[${index}]`);
  }
  return Object.freeze(value as unknown as ExtractionCacheShard);
}

function parseCounts(
  value: unknown,
  shards: readonly ExtractionCacheShard[],
  orphanKeys: readonly string[]
): ExtractionCacheInventory["counts"] {
  const fields = ["expected", "hit", "missing", "invalid", "orphan"];
  if (!isExactRecord(value, fields) || !fields.every((field) => isCount(value[field]))) {
    throw new Error("invalid raw inventory counts");
  }
  const expected = {
    expected: shards.length,
    hit: shards.filter((shard) => shard.status === "hit").length,
    missing: shards.filter((shard) => shard.status === "missing").length,
    invalid: shards.filter((shard) => shard.status === "invalid").length,
    orphan: orphanKeys.length
  };
  if (!fields.every((field) => value[field] === expected[field as keyof typeof expected])) {
    throw new Error("raw inventory counts do not match its shards");
  }
  return expected;
}

function parseStringArray(
  value: readonly unknown[],
  label: string,
  predicate: (value: unknown) => value is string = isNonemptyString
): string[] {
  if (!value.every(predicate)) throw new Error(`invalid raw inventory ${label}`);
  return [...value] as string[];
}

function assertSortedUnique(values: readonly string[], label: string): void {
  const sorted = [...new Set(values)].sort((left, right) => left.localeCompare(right));
  if (!sameStrings(values, sorted)) throw new Error(`raw inventory ${label} must be sorted and unique`);
}

function isExactRecord(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && sameStrings(Object.keys(value).sort(), [...keys].sort());
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isNonemptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}
