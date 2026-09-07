import type { EventLogEntry, GlobalMemoryEntry } from "@do-soul/alaya-protocol";
import type { GlobalMemoryRecallEntry, GlobalMemoryRecallPort } from "./global-memory-recall-port.js";
import { selectGlobalMemoryRecallEntries } from "./global-memory/selection.js";

export interface GlobalMemoryRecallSourcePort {
  list(): Promise<readonly Readonly<GlobalMemoryEntry>[]>;
  listAll?(): Promise<readonly Readonly<GlobalMemoryEntry>[]>;
  listPage?(page: GlobalMemoryRecallSourcePageOptions): Promise<readonly Readonly<GlobalMemoryEntry>[]>;
}

export interface GlobalMemoryRecallSourcePageOptions {
  readonly limit: number;
  readonly offset: number;
}

export interface GlobalMemoryRecallSubscription {
  dispose(): void;
}

export interface GlobalMemoryRecallInvalidationNotifier {
  subscribeEntries(
    listener: (entry: Readonly<EventLogEntry>) => void | Promise<void>
  ): GlobalMemoryRecallSubscription;
}

export interface GlobalMemoryRecallServicePort extends GlobalMemoryRecallPort {
  subscribeToInvalidations(
    notifier: GlobalMemoryRecallInvalidationNotifier
  ): GlobalMemoryRecallSubscription;
}

export function createGlobalMemoryRecallPort(params: {
  readonly globalMemorySource: GlobalMemoryRecallSourcePort;
}): GlobalMemoryRecallServicePort {
  return new GlobalMemoryRecallService(params.globalMemorySource);
}

// Bounded LRU supplement cache keyed by workspaceId, queryText, and limit.
const GLOBAL_RECALL_QUERY_CACHE_SIZE = 512;

class GlobalMemoryRecallService implements GlobalMemoryRecallServicePort {
  private readonly cacheByQuery = new Map<string, readonly Readonly<GlobalMemoryRecallEntry>[]>();

  public constructor(private readonly globalMemorySource: GlobalMemoryRecallSourcePort) {}

  public async recall(params: {
    readonly workspaceId: string;
    readonly queryText: string | null;
    readonly limit: number;
  }): Promise<readonly Readonly<GlobalMemoryRecallEntry>[]> {
    const cacheKey = createRecallCacheKey(params);
    const cached = this.cacheByQuery.get(cacheKey);
    if (cached !== undefined) {
      // Refresh recency: re-insert so the most-recently-read key is youngest.
      this.cacheByQuery.delete(cacheKey);
      this.cacheByQuery.set(cacheKey, cached);
      return [...cached];
    }

    const normalizedQuery = normalizeGlobalMemoryQuery(params.queryText);
    const selectedEntries = await selectGlobalMemoryRecallEntries(
      this.globalMemorySource,
      normalizedQuery,
      params.limit
    );
    const recallEntries = selectedEntries.map((entry) =>
      Object.freeze({
        global_object_id: entry.global_object_id,
        dimension: entry.dimension,
        scope_class: entry.scope_class,
        content: entry.content,
        domain_tags: entry.domain_tags,
        activation_score: entry.activation_score,
        created_at: entry.created_at,
        updated_at: entry.updated_at
      })
    );

    this.cacheByQuery.delete(cacheKey);
    this.cacheByQuery.set(cacheKey, recallEntries);
    while (this.cacheByQuery.size > GLOBAL_RECALL_QUERY_CACHE_SIZE) {
      const oldestKey = this.cacheByQuery.keys().next().value as string | undefined;
      if (oldestKey === undefined) {
        break;
      }
      this.cacheByQuery.delete(oldestKey);
    }
    return [...recallEntries];
  }

  public subscribeToInvalidations(
    notifier: GlobalMemoryRecallInvalidationNotifier
  ): GlobalMemoryRecallSubscription {
    return notifier.subscribeEntries((entry) => {
      const invalidation = parseMemoryInvalidationEntry(entry);
      if (invalidation === null) {
        return;
      }

      this.invalidateForMemory(invalidation.memoryId, invalidation.sourceWorkspaceId);
    });
  }

  private invalidateForMemory(memoryId: string, sourceWorkspaceId: string): void {
    void sourceWorkspaceId;
    for (const [cacheKey, cachedEntries] of this.cacheByQuery.entries()) {
      if (!cachedEntries.some((entry) => entry.global_object_id === memoryId)) {
        continue;
      }

      this.cacheByQuery.delete(cacheKey);
    }
  }
}

function normalizeGlobalMemoryQuery(queryText: string | null): readonly string[] | null {
  if (queryText === null) return null;
  const tokens = queryText
    .trim()
    .toLowerCase()
    .split(/\s+/)
    .filter((token) => token.length > 0);

  return tokens.length === 0 ? null : tokens;
}

function createRecallCacheKey(params: {
  readonly workspaceId: string;
  readonly queryText: string | null;
  readonly limit: number;
}): string {
  return `${params.workspaceId}\u001f${params.queryText ?? ""}\u001f${params.limit}`;
}

const memoryInvalidationEventTypes = new Set([
  "memory.created", "memory.updated", "memory.deleted",
  "soul.memory.created", "soul.memory.updated", "soul.memory.archived"
]);

function parseMemoryInvalidationEntry(
  entry: Readonly<EventLogEntry>
): Readonly<{
  readonly memoryId: string;
  readonly sourceWorkspaceId: string;
}> | null {
  if (!memoryInvalidationEventTypes.has(entry.event_type)) {
    return null;
  }

  const payload = toObjectRecord(entry.payload_json);
  const sourceWorkspaceId = readNonEmptyString(entry.workspace_id) ?? readNonEmptyProperty(payload, "workspace_id");
  if (sourceWorkspaceId === null) {
    return null;
  }

  const memoryId =
    readNonEmptyProperty(payload, "memory_id") ??
    readNonEmptyProperty(payload, "object_id") ??
    (entry.entity_type === "memory_entry" ? readNonEmptyString(entry.entity_id) : null);

  if (memoryId === null) {
    return null;
  }

  return Object.freeze({
    memoryId,
    sourceWorkspaceId
  });
}

function toObjectRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function readNonEmptyProperty(
  value: Readonly<Record<string, unknown>> | null,
  key: string
): string | null {
  if (value === null) {
    return null;
  }

  return readNonEmptyString(value[key]);
}

function readNonEmptyString(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}
