import type { ExtractionSuccessfulShard } from "../attempt-ledger-shards.js";
import type { ExtractionAttemptLedgerRecord } from "./contract.js";
import { ExtractionAttemptLimitError } from "./outcome.js";

export function commitProviderBackedShard(
  current: ExtractionAttemptLedgerRecord,
  shard: ExtractionSuccessfulShard
): ExtractionAttemptLedgerRecord {
  if (hasSuccessfulShard(current, shard.cacheKey)) return current;
  if (!current.pending_keys.includes(shard.cacheKey)) {
    throw new ExtractionAttemptLimitError("extraction success was not reserved before transport");
  }
  if (current.unresolved_attempts.some((attempt) => attempt.cache_key === shard.cacheKey)) {
    throw new ExtractionAttemptLimitError("extraction success must settle its provider attempt first");
  }
  return {
    ...current,
    successful_shards: sortedSuccessfulShards([...current.successful_shards, shard]),
    pending_keys: current.pending_keys.filter((key) => key !== shard.cacheKey)
  };
}

export function commitDeterministicShard(
  current: ExtractionAttemptLedgerRecord,
  shard: ExtractionSuccessfulShard
): ExtractionAttemptLedgerRecord {
  if (hasSuccessfulShard(current, shard.cacheKey)) return current;
  if (current.pending_keys.includes(shard.cacheKey) ||
      current.unresolved_attempts.some((attempt) => attempt.cache_key === shard.cacheKey)) {
    throw new ExtractionAttemptLimitError(
      "deterministic extraction cannot settle a provider-backed shard"
    );
  }
  if (current.successful_shards.length >= current.successful_shard_ceiling) {
    throw new ExtractionAttemptLimitError("extraction successful-shard ceiling is exhausted");
  }
  return {
    ...current,
    successful_shards: sortedSuccessfulShards([...current.successful_shards, shard])
  };
}

export function sortedSuccessfulShards(
  shards: readonly ExtractionSuccessfulShard[]
): readonly ExtractionSuccessfulShard[] {
  return [...new Map(shards.map((shard) => [shard.cacheKey, shard])).values()]
    .sort((left, right) => left.cacheKey.localeCompare(right.cacheKey));
}

function hasSuccessfulShard(current: ExtractionAttemptLedgerRecord, cacheKey: string): boolean {
  return current.successful_shards.some((entry) => entry.cacheKey === cacheKey);
}
