import type { EventLogEntry, GlobalMemoryEntry } from "@do-soul/alaya-protocol";
import { VersionedBoundedCache } from "../../runtime/versioned-bounded-cache.js";
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
  private readonly cache = new VersionedBoundedCache<readonly Readonly<GlobalMemoryRecallEntry>[]>({
    maxEntries: GLOBAL_RECALL_QUERY_CACHE_SIZE
  });

  public constructor(private readonly globalMemorySource: GlobalMemoryRecallSourcePort) {}

  public async recall(params: {
    readonly workspaceId: string;
    readonly queryText: string | null;
    readonly limit: number;
  }): Promise<readonly Readonly<GlobalMemoryRecallEntry>[]> {
    const cacheKey = createRecallCacheKey(params);
    const resolved = await this.cache.resolve(
      cacheKey,
      async () => this.selectRecallEntries(params.queryText, params.limit),
      (value) => value
    );
    return [...(resolved ?? [])];
  }

  public subscribeToInvalidations(
    notifier: GlobalMemoryRecallInvalidationNotifier
  ): GlobalMemoryRecallSubscription {
    return notifier.subscribeEntries((entry) => {
      if (parseMemoryInvalidationEntry(entry) === null) {
        return;
      }
      // Creates and in-flight loads have no cached membership to walk.
      this.cache.invalidate();
    });
  }

  private async selectRecallEntries(
    queryText: string | null,
    limit: number
  ): Promise<readonly Readonly<GlobalMemoryRecallEntry>[]> {
    const selectedEntries = await selectGlobalMemoryRecallEntries(
      this.globalMemorySource,
      normalizeGlobalMemoryQuery(queryText),
      limit
    );
    return selectedEntries.map((entry) =>
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
