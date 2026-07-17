import type { ExtractionRequestProfile } from "../request-profile.js";
import { inspectCachedExtraction } from "../../compile-seed-cache.js";

export interface ExtractionAttemptLedgerCacheIdentity {
  readonly model: string;
  readonly requestProfile: ExtractionRequestProfile;
}

export interface ExtractionSuccessfulShard {
  readonly cacheKey: string;
  readonly rawJsonSha256: string;
}

export function assertExtractionAttemptLedgerCacheIdentity(
  value: unknown
): asserts value is ExtractionAttemptLedgerCacheIdentity {
  if (typeof value !== "object" || value === null) {
    throw new Error("extraction attempt ledger cache identity is invalid");
  }
  const identity = value as Partial<ExtractionAttemptLedgerCacheIdentity>;
  if (typeof identity.model !== "string" || identity.model.length === 0 ||
      (identity.requestProfile !== "provider-default-v1" &&
        identity.requestProfile !== "deepseek-v4-nonthinking-v1")) {
    throw new Error("extraction attempt ledger cache identity is invalid");
  }
}

export function readValidLedgerShard(
  cacheRoot: string,
  cacheKey: string,
  identity: ExtractionAttemptLedgerCacheIdentity
): ExtractionSuccessfulShard | undefined {
  const shard = inspectCachedExtraction(
    cacheRoot, cacheKey, identity.model, identity.requestProfile
  );
  if (shard.status !== "hit") return undefined;
  return { cacheKey, rawJsonSha256: shard.rawJsonSha256 };
}

export function assertLedgerSuccessfulShard(
  cacheRoot: string,
  shard: ExtractionSuccessfulShard,
  identity: ExtractionAttemptLedgerCacheIdentity
): void {
  const current = readValidLedgerShard(cacheRoot, shard.cacheKey, identity);
  if (current === undefined || current.rawJsonSha256 !== shard.rawJsonSha256) {
    throw new Error(
      `extraction authority successful shard closure drifted: ${shard.cacheKey}`
    );
  }
}
