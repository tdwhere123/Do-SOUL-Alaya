import type { ToolGovernanceDecision, ToolGovernancePort, ToolGovernanceQuery } from "@do-soul/alaya-protocol";
import { deepFreeze } from "../shared/deep-freeze.js";
import { stableStringify } from "../shared/stable-stringify.js";

export interface ToolGovernanceClientDependencies {
  readonly port: ToolGovernancePort;
  readonly ttlMs?: number;
  readonly maxEntries?: number;
  readonly now?: () => number;
}

export class ToolGovernanceClient {
  private readonly cache: Map<string, Map<string, GovernanceCacheEntry>>;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private accessCounter = 0;

  public constructor(private readonly deps: ToolGovernanceClientDependencies) {
    this.cache = new Map();
    this.ttlMs = Math.max(0, deps.ttlMs ?? DEFAULT_GOVERNANCE_CACHE_TTL_MS);
    this.maxEntries = Math.max(1, Math.floor(deps.maxEntries ?? DEFAULT_GOVERNANCE_CACHE_MAX_ENTRIES));
  }

  /**
   * Query governance. Results are cached by nodeId + queryHash until ttlMs elapses
   * or invalidateNode()/invalidateAll() explicitly clears the bucket.
   * @param query - The governance query.
   * @param nodeId - Optional outer cache key; defaults to "_global" when omitted.
   *   Pass HotPathExecuteInput.nodeId so each node's cache can be independently invalidated
   *   via invalidateNode(). Required for correct per-node cache isolation.
   */
  public async query(query: ToolGovernanceQuery, nodeId?: string): Promise<Readonly<ToolGovernanceDecision>> {
    const bucketKey = nodeId ?? "_global";
    const queryHash = stableStringify(query);
    const nowMs = this.now();
    const bucket = this.cache.get(bucketKey);
    const cached = bucket?.get(queryHash);

    if (cached !== undefined) {
      if (cached.expiresAt > nowMs) {
        cached.lastAccessedAt = this.nextAccessCounter();
        return cached.decision;
      }

      bucket?.delete(queryHash);
      if (bucket?.size === 0) {
        this.cache.delete(bucketKey);
      }
    }

    const decision = deepFreeze(await this.deps.port.queryToolGovernance(query));
    const cacheBucket = this.cache.get(bucketKey) ?? new Map<string, GovernanceCacheEntry>();

    cacheBucket.set(queryHash, {
      decision,
      expiresAt: nowMs + this.ttlMs,
      lastAccessedAt: this.nextAccessCounter()
    });
    this.cache.set(bucketKey, cacheBucket);
    this.evictLeastRecentlyUsedIfNeeded();

    return decision;
  }

  /**
   * Invalidate all cached decisions for the given nodeId. Exposes the
   * invalidation API a lease-pierce hot-path hook calls.
   */
  public invalidateNode(nodeId: string): void {
    this.cache.delete(nodeId);
  }

  /** Invalidate all cached decisions across all nodes. */
  public invalidateAll(): void {
    this.cache.clear();
  }

  private now(): number {
    return this.deps.now?.() ?? Date.now();
  }

  private nextAccessCounter(): number {
    this.accessCounter += 1;
    return this.accessCounter;
  }

  private evictLeastRecentlyUsedIfNeeded(): void {
    while (this.countEntries() > this.maxEntries) {
      let oldestBucketKey: string | null = null;
      let oldestQueryHash: string | null = null;
      let oldestAccess = Number.POSITIVE_INFINITY;

      for (const [bucketKey, bucket] of this.cache) {
        for (const [queryHash, entry] of bucket) {
          if (entry.lastAccessedAt < oldestAccess) {
            oldestAccess = entry.lastAccessedAt;
            oldestBucketKey = bucketKey;
            oldestQueryHash = queryHash;
          }
        }
      }

      if (oldestBucketKey === null || oldestQueryHash === null) {
        return;
      }

      const bucket = this.cache.get(oldestBucketKey);
      bucket?.delete(oldestQueryHash);
      if (bucket?.size === 0) {
        this.cache.delete(oldestBucketKey);
      }
    }
  }

  private countEntries(): number {
    let total = 0;
    for (const bucket of this.cache.values()) {
      total += bucket.size;
    }
    return total;
  }
}

interface GovernanceCacheEntry {
  readonly decision: Readonly<ToolGovernanceDecision>;
  readonly expiresAt: number;
  lastAccessedAt: number;
}

const DEFAULT_GOVERNANCE_CACHE_TTL_MS = 60_000;
const DEFAULT_GOVERNANCE_CACHE_MAX_ENTRIES = 500;
