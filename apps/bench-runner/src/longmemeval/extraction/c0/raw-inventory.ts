import { createHash } from "node:crypto";
import { existsSync, lstatSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import {
  inspectCachedExtraction,
  type CachedExtractionInspection
} from "../../compile-seed-cache.js";
import type { CompileSeedExtractionConfig } from "../../compile-seed-types.js";

const CACHE_KEY_FILE = /^([a-f0-9]{64})\.json$/u;

export interface C0RawShard {
  readonly cacheKey: string;
  readonly status: CachedExtractionInspection["status"];
  readonly rawJsonSha256?: string;
  readonly rawSignalCount?: number;
  readonly parsedDraftCount?: number;
  readonly reason?: string;
}

export interface C0RawShardInventory {
  readonly shards: readonly C0RawShard[];
  readonly orphanKeys: readonly string[];
  readonly unexpectedPaths: readonly string[];
  readonly counts: Readonly<{
    expected: number;
    hit: number;
    missing: number;
    invalid: number;
    orphan: number;
  }>;
}

export function inspectC0RawShardInventory(input: {
  readonly cacheRoot: string;
  readonly cacheKeys: readonly string[];
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
}): C0RawShardInventory {
  assertDirectoryNotSymlink(input.cacheRoot);
  const cacheKeys = uniqueSortedCacheKeys(input.cacheKeys);
  const shards = cacheKeys.map((cacheKey) => inspectShard(input, cacheKey));
  const discovered = discoverCacheShardFiles(input.cacheRoot);
  const expected = new Set(cacheKeys);
  const orphanKeys = discovered.keys.filter((key) => !expected.has(key));
  return Object.freeze({
    shards: Object.freeze(shards),
    orphanKeys: Object.freeze(orphanKeys),
    unexpectedPaths: Object.freeze(discovered.unexpectedPaths),
    counts: Object.freeze(countsFor(shards, orphanKeys))
  });
}

export function hashC0RawShardInventory(inventory: C0RawShardInventory): string {
  const canonical = {
    shards: inventory.shards.map((shard) => ({
      cache_key: shard.cacheKey,
      status: shard.status,
      raw_json_sha256: shard.rawJsonSha256 ?? null,
      raw_signal_count: shard.rawSignalCount ?? null,
      parsed_draft_count: shard.parsedDraftCount ?? null,
      reason: shard.reason ?? null
    })),
    orphan_keys: inventory.orphanKeys,
    unexpected_paths: inventory.unexpectedPaths
  };
  return createHash("sha256").update(JSON.stringify(canonical), "utf8").digest("hex");
}

function assertDirectoryNotSymlink(cacheRoot: string): void {
  if (!existsSync(cacheRoot)) return;
  const stat = lstatSync(cacheRoot);
  if (stat.isSymbolicLink()) throw new Error("C0 cache root must not be a symlink");
  if (!stat.isDirectory()) throw new Error("C0 cache root must be a directory");
}

function uniqueSortedCacheKeys(cacheKeys: readonly string[]): readonly string[] {
  const unique = [...new Set(cacheKeys)];
  for (const cacheKey of unique) {
    if (!/^[a-f0-9]{64}$/u.test(cacheKey)) throw new Error(`invalid C0 cache key: ${cacheKey}`);
  }
  return unique.sort((left, right) => left.localeCompare(right));
}

function inspectShard(
  input: Parameters<typeof inspectC0RawShardInventory>[0],
  cacheKey: string
): C0RawShard {
  const result = inspectCachedExtraction(input.cacheRoot, cacheKey, input.model, input.requestProfile);
  if (result.status === "hit") {
    return Object.freeze({
      cacheKey,
      status: result.status,
      rawJsonSha256: result.rawJsonSha256,
      rawSignalCount: result.rawSignalCount,
      parsedDraftCount: result.parsedDraftCount
    });
  }
  return Object.freeze({ cacheKey, status: result.status, ...(result.status === "invalid" ? { reason: result.reason } : {}) });
}

function discoverCacheShardFiles(cacheRoot: string): {
  readonly keys: readonly string[];
  readonly unexpectedPaths: readonly string[];
} {
  if (!existsSync(cacheRoot)) return { keys: [], unexpectedPaths: [] };
  const keys: string[] = [];
  const unexpectedPaths: string[] = [];
  walkCacheRoot(cacheRoot, cacheRoot, keys, unexpectedPaths);
  return { keys: keys.sort(), unexpectedPaths: unexpectedPaths.sort() };
}

function walkCacheRoot(root: string, directory: string, keys: string[], unexpectedPaths: string[]): void {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`C0 cache contains a symlink: ${relative(root, path)}`);
    if (entry.isDirectory()) {
      if (entry.name !== ".extraction-fill.lock") walkCacheRoot(root, path, keys, unexpectedPaths);
      continue;
    }
    if (directory === root && entry.name === "manifest.json") continue;
    const match = CACHE_KEY_FILE.exec(entry.name);
    if (entry.isFile() && match?.[1] !== undefined && isCanonicalShardPath(root, path, match[1])) {
      keys.push(match[1]);
    } else {
      unexpectedPaths.push(relative(root, path));
    }
  }
}

function isCanonicalShardPath(root: string, path: string, cacheKey: string): boolean {
  return relative(root, path) === `${cacheKey.slice(0, 2)}/${cacheKey}.json`;
}

function countsFor(shards: readonly C0RawShard[], orphanKeys: readonly string[]) {
  return {
    expected: shards.length,
    hit: shards.filter((shard) => shard.status === "hit").length,
    missing: shards.filter((shard) => shard.status === "missing").length,
    invalid: shards.filter((shard) => shard.status === "invalid").length,
    orphan: orphanKeys.length
  };
}
