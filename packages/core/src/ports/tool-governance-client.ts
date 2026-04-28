import type { ToolGovernanceDecision, ToolGovernancePort, ToolGovernanceQuery } from "@do-soul/alaya-protocol";
import { deepFreeze } from "../shared/deep-freeze.js";

export interface ToolGovernanceClientDependencies {
  readonly port: ToolGovernancePort;
  readonly ttlMs?: number;
  readonly now?: () => number;
}

export class ToolGovernanceClient {
  private readonly cache: Map<string, Map<string, GovernanceCacheEntry>>;
  private readonly ttlMs: number;

  public constructor(private readonly deps: ToolGovernanceClientDependencies) {
    this.cache = new Map();
    this.ttlMs = Math.max(0, deps.ttlMs ?? DEFAULT_GOVERNANCE_CACHE_TTL_MS);
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
      expiresAt: nowMs + this.ttlMs
    });
    this.cache.set(bucketKey, cacheBucket);

    return decision;
  }

  /**
   * Invalidate all cached decisions for the given nodeId.
   * Lease pierce integration is deferred to A2-1b; this card only exposes
   * invalidation APIs for the future hot-path hook to call.
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
}

interface GovernanceCacheEntry {
  readonly decision: Readonly<ToolGovernanceDecision>;
  readonly expiresAt: number;
}

const DEFAULT_GOVERNANCE_CACHE_TTL_MS = 60_000;

function stableStringify(value: ToolGovernanceQuery): string {
  return JSON.stringify(stableNormalize(value));
}

function stableNormalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableNormalize(entry));
  }

  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, entry]) => [key, stableNormalize(entry)])
    );
  }

  return value;
}
