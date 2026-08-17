import type { CompileSeedExtractionStats } from "../../../bench/compile-seed.js";
import type { LongMemEvalSnapshotSeedRound } from "../../../bench/snapshot/materialize.js";

export function buildRoundExtractionLedger(
  stats: CompileSeedExtractionStats
): Pick<LongMemEvalSnapshotSeedRound,
  "extractionSource" | "cacheKey" | "rawJsonSha256" |
  "rawSignalCount" | "draftCount" | "extractionShards" |
  "semanticSupplementShards"> {
  const official = stats.lastExtractionSource !== null;
  const shards = stats.lastExtractionShards?.map((shard) => ({
    cacheKey: shard.cacheKey,
    rawJsonSha256: shard.rawJsonSha256,
    rawSignalCount: shard.rawSignalCount,
    draftCount: shard.draftCount
  }));
  const single = shards?.length === 1 ? shards[0] : undefined;
  return {
    extractionSource: stats.lastExtractionSource ?? "fallback",
    cacheKey: official ? single?.cacheKey ?? legacyCacheKey(stats, shards) : null,
    rawJsonSha256: official ? single?.rawJsonSha256 ?? legacyRawDigest(stats, shards) : null,
    rawSignalCount: official ? stats.lastTurnRawSignalCount : null,
    draftCount: official ? stats.lastTurnDraftCount : null,
    ...(official && shards !== undefined ? { extractionShards: shards } : {}),
    ...(official && stats.lastSemanticSupplementShards !== undefined &&
      stats.lastSemanticSupplementShards.length > 0
      ? { semanticSupplementShards: [...stats.lastSemanticSupplementShards] }
      : {})
  };
}

function legacyCacheKey(
  stats: CompileSeedExtractionStats,
  shards: readonly unknown[] | undefined
): string | null {
  return shards === undefined ? stats.lastCacheKey ?? null : null;
}

function legacyRawDigest(
  stats: CompileSeedExtractionStats,
  shards: readonly unknown[] | undefined
): string | null {
  return shards === undefined ? stats.lastRawJsonSha256 : null;
}
