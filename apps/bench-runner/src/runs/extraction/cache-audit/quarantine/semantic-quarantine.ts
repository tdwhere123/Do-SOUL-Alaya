import type {
  ExtractionCacheInventory,
  ExtractionCacheShard
} from "../inventory.js";
import type { CompileSeedExtractionConfig } from
  "../../../compile-seed/compile-seed-types.js";
import type { ExtractionOccurrence } from "../occurrence-index.js";
import {
  replayExtractionOccurrences,
  type ExtractionReplayResult
} from "../replay.js";

export const SEMANTIC_QUARANTINE_REASON = "projection_replay_invalid";

export function replayWithSemanticQuarantine(input: {
  readonly cacheRoot: string;
  readonly model: string;
  readonly requestProfile: CompileSeedExtractionConfig["requestProfile"];
  readonly occurrences: readonly ExtractionOccurrence[];
  readonly inventory: ExtractionCacheInventory;
}): Readonly<{
  inventory: ExtractionCacheInventory;
  replay: ExtractionReplayResult;
}> {
  const strictReplay = replayExtractionOccurrences({
    ...input,
    requireSemanticFactorGraph: true,
    allowMissingShards: true
  });
  const semanticQuarantinedCacheKeys = collectSemanticQuarantineKeys(strictReplay);
  return Object.freeze({
    inventory: quarantineExtractionCacheInventory(
      input.inventory,
      semanticQuarantinedCacheKeys
    ),
    replay: replayExtractionOccurrences({
      ...input,
      requireSemanticFactorGraph: true,
      semanticQuarantinedCacheKeys,
      allowMissingShards: true
    })
  });
}

export function collectSemanticQuarantineKeys(
  replay: ExtractionReplayResult
): ReadonlySet<string> {
  return new Set(replay.occurrences.flatMap((occurrence) =>
    occurrence.entries
      .filter((entry) => entry.disposition === "invalid")
      .map((entry) => entry.sourceCacheKey)
  ));
}

export function quarantineExtractionCacheInventory(
  inventory: ExtractionCacheInventory,
  keys: ReadonlySet<string>
): ExtractionCacheInventory {
  if (keys.size === 0) return inventory;
  const shards = Object.freeze(inventory.shards.map((shard) =>
    keys.has(shard.cacheKey) ? quarantinedShard(shard) : shard
  ));
  return Object.freeze({
    ...inventory,
    shards,
    counts: Object.freeze({
      ...inventory.counts,
      hit: shards.filter((shard) => shard.status === "hit").length,
      missing: shards.filter((shard) => shard.status === "missing").length,
      invalid: shards.filter((shard) => shard.status === "invalid").length
    })
  });
}

function quarantinedShard(shard: ExtractionCacheShard): ExtractionCacheShard {
  if (shard.status !== "hit") return shard;
  return Object.freeze({
    cacheKey: shard.cacheKey,
    status: "invalid" as const,
    reason: SEMANTIC_QUARANTINE_REASON,
    ...(shard.rawJsonSha256 === undefined ? {} : { rawJsonSha256: shard.rawJsonSha256 })
  });
}
