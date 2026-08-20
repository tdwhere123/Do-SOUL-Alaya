import {
  hashLabeledIdentity,
  type FieldContractSha256
} from "@do-soul/alaya-protocol";

import type { ProjectionL2Bundle } from "../../../flood/slice-key-l2-bundles.js";

export type ProjectionBundleCacheRecord = Readonly<{
  readonly bundle: ProjectionL2Bundle;
  readonly condition_digest: string;
  readonly governance_frontier: string;
  readonly erase_frontier: string;
}>;

export type ProjectionBundleCacheQuery = Readonly<{
  readonly bundle_id: string;
  readonly condition_digest: string;
  readonly generation_id: string;
  readonly governance_frontier: string;
  readonly erase_frontier: string;
}>;

export function projectionBundleCacheKey(
  bundleId: string,
  conditionDigest: string,
  sha256: FieldContractSha256
): string {
  return hashLabeledIdentity("bundle_cache", [bundleId, conditionDigest], sha256);
}

export function createProjectionBundleCache(sha256: FieldContractSha256): ProjectionBundleCache {
  const entries = new Map<string, MutableCacheEntry>();
  return Object.freeze({
    put(record: ProjectionBundleCacheRecord): string {
      const cacheKey = projectionBundleCacheKey(
        record.bundle.bundle_id,
        record.condition_digest,
        sha256
      );
      entries.set(cacheKey, {
        ...record,
        generation_id: record.bundle.generation_id,
        member_refs: Object.freeze([...record.bundle.member_refs]),
        invalidated: false
      });
      return cacheKey;
    },
    get(query: ProjectionBundleCacheQuery): ProjectionL2Bundle {
      const entry = entries.get(projectionBundleCacheKey(
        query.bundle_id,
        query.condition_digest,
        sha256
      ));
      if (entry === undefined || isStale(entry, query)) {
        throw new Error("stale cache");
      }
      return entry.bundle;
    },
    invalidateSubject(subjectId: string): void {
      for (const entry of entries.values()) {
        if (entry.member_refs.includes(subjectId)) entry.invalidated = true;
      }
    }
  });
}

export type ProjectionBundleCache = Readonly<{
  readonly put: (record: ProjectionBundleCacheRecord) => string;
  readonly get: (query: ProjectionBundleCacheQuery) => ProjectionL2Bundle;
  readonly invalidateSubject: (subjectId: string) => void;
}>;

type MutableCacheEntry = ProjectionBundleCacheRecord & {
  readonly generation_id: string;
  readonly member_refs: readonly string[];
  invalidated: boolean;
};

function isStale(entry: MutableCacheEntry, query: ProjectionBundleCacheQuery): boolean {
  return entry.invalidated ||
    entry.generation_id !== query.generation_id ||
    entry.condition_digest !== query.condition_digest ||
    entry.governance_frontier !== query.governance_frontier ||
    entry.erase_frontier !== query.erase_frontier;
}
