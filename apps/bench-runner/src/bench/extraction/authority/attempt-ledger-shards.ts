import type { ExtractionRequestProfile } from "../request-profile.js";
import { isDeepStrictEqual } from "node:util";
import { inspectCachedRawExtraction } from "../../compile-seed/cache/cache-shard.js";
import type { ExtractionTransportProvenance } from "../transport-route.js";

export interface ExtractionAttemptLedgerCacheIdentity {
  readonly model: string;
  readonly requestProfile: ExtractionRequestProfile;
}

interface SuccessfulShardIdentity {
  readonly cacheKey: string;
  readonly rawJsonSha256: string;
}

export type ExtractionSuccessfulShard = SuccessfulShardIdentity & (
  | {
    readonly successKind: "provider";
    readonly transportProvenance: ExtractionTransportProvenance;
  }
  | { readonly successKind: "deterministic" }
  | { readonly successKind: "legacy-unclassified" }
);

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
  const shard = inspectCachedRawExtraction(
    cacheRoot, cacheKey, identity.model, identity.requestProfile
  );
  if (shard.status !== "hit" || shard.transportProvenance === undefined) return undefined;
  return {
    cacheKey, rawJsonSha256: shard.rawJsonSha256,
    successKind: "provider", transportProvenance: shard.transportProvenance
  };
}

export function readValidDeterministicLedgerShard(
  cacheRoot: string,
  cacheKey: string,
  identity: ExtractionAttemptLedgerCacheIdentity
): ExtractionSuccessfulShard | undefined {
  const shard = inspectCachedRawExtraction(
    cacheRoot, cacheKey, identity.model, identity.requestProfile
  );
  if (shard.status !== "hit" || shard.rawJson !== '{"signals":[]}' ||
      shard.transportProvenance !== undefined) return undefined;
  return { cacheKey, rawJsonSha256: shard.rawJsonSha256, successKind: "deterministic" };
}

export function assertLedgerSuccessfulShard(
  cacheRoot: string,
  shard: ExtractionSuccessfulShard,
  identity: ExtractionAttemptLedgerCacheIdentity
): void {
  const current = shard.successKind === "provider"
    ? readValidLedgerShard(cacheRoot, shard.cacheKey, identity)
    : shard.successKind === "deterministic"
      ? readValidDeterministicLedgerShard(cacheRoot, shard.cacheKey, identity)
      : readLegacyLedgerShard(cacheRoot, shard.cacheKey, identity);
  if (current === undefined || current.rawJsonSha256 !== shard.rawJsonSha256 ||
      (shard.successKind === "provider" &&
        !isDeepStrictEqual(current, shard))) {
    throw new Error(
      `extraction authority successful shard closure drifted: ${shard.cacheKey}`
    );
  }
}

function readLegacyLedgerShard(
  cacheRoot: string,
  cacheKey: string,
  identity: ExtractionAttemptLedgerCacheIdentity
): ExtractionSuccessfulShard | undefined {
  const shard = inspectCachedRawExtraction(
    cacheRoot, cacheKey, identity.model, identity.requestProfile
  );
  if (shard.status !== "hit") return undefined;
  return {
    cacheKey, rawJsonSha256: shard.rawJsonSha256,
    successKind: "legacy-unclassified"
  };
}
