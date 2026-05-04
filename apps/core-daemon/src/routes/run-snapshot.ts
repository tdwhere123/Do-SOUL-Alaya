import {
  type EventLogEntry,
  type RunHotState,
  type RunSnapshot,
  type RunSnapshotSurfaceState
} from "@do-soul/alaya-protocol";
import {
  compactRunSnapshotSurfaceState,
  SnapshotCompactionError
} from "./run-snapshot-compaction.js";

export interface SnapshotCursorState {
  readonly cursorExists: boolean;
  readonly eventsUpToCursor: number;
  readonly latestEventId: string | null;
}

type SnapshotEventLogRepo = {
  queryByRun(runId: string): Promise<readonly EventLogEntry[]>;
  queryByRunAfterEventId?(runId: string, lastEventId: string): Promise<readonly EventLogEntry[]>;
  queryByRunCursorState?(
    runId: string,
    lastEventId: string | null
  ): Promise<SnapshotCursorState>;
};

type RunRouteWarnLogger = (message: string, meta: Record<string, unknown>) => void;

/** Cache entry for a single run's compacted snapshot surface state. */
interface SnapshotCacheEntry {
  readonly surfaceState: RunSnapshotSurfaceState;
  /**
   * event_id of the last event returned by queryByRun at the time of caching.
   * Used as the cursor to filter delta events on the incremental path.
   * null when the run had no events at all.
   */
  readonly latestEventId: string | null;
  /**
   * Mirrors the latestControlPlaneEventId from the compaction result.
   * Stored separately so incremental updates can fall back to the prior value
   * when delta events contain no control-plane contributions.
   */
  readonly latestControlPlaneEventId: string | null;
  /** The run whose cursor metadata was used to build this snapshot entry. */
  readonly snapshotCursorRun: string;
  /** Number of run events up to and including latestEventId when cached. */
  readonly eventsUpToCursor: number;
  /** Date.now() timestamp when this entry was stored or refreshed. */
  readonly cachedAt: number;
}

const SNAPSHOT_CACHE_MAX = 50;
const SNAPSHOT_CACHE_TTL_MS = 60_000;

/**
 * Module-level LRU cache keyed by runId.
 * Eviction: when capacity is reached the oldest-inserted entry (first in Map
 * iteration order) is removed before inserting the new one.
 */
const snapshotCache = new Map<string, SnapshotCacheEntry>();
const snapshotCompactionInflight = new Map<string, Promise<SnapshotCacheEntry>>();

export function resetSnapshotCacheForTesting(): void {
  snapshotCache.clear();
  snapshotCompactionInflight.clear();
}

export function deleteRunSnapshotCache(runId: string): void {
  snapshotCache.delete(runId);
}

export async function enrichRunSnapshot(
  snapshot: RunHotState,
  runId: string,
  eventLogRepo: SnapshotEventLogRepo | undefined,
  warn: RunRouteWarnLogger | undefined
): Promise<RunSnapshot> {
  if (eventLogRepo === undefined) {
    throw new SnapshotCompactionError(
      `Cannot compact snapshot for ${runId}: eventLogRepo is required for /runs/:id/snapshot`
    );
  }

  const entry = await getSnapshotCacheEntry(runId, eventLogRepo, warn);

  return {
    ...snapshot,
    bootstrap_control_plane_cutoff_event_id: entry.latestControlPlaneEventId,
    surface_state: entry.surfaceState
  };
}

function cacheGet(runId: string): SnapshotCacheEntry | undefined {
  const entry = snapshotCache.get(runId);
  if (entry !== undefined) {
    // Promote to MRU position so that frequently-read entries are not evicted
    // before less-recently-read ones (true LRU semantics, not FIFO).
    snapshotCache.delete(runId);
    snapshotCache.set(runId, entry);
  }
  return entry;
}

function cacheSet(runId: string, entry: SnapshotCacheEntry): void {
  // Evict LRU entry when at capacity (Map iterates insertion order).
  if (!snapshotCache.has(runId) && snapshotCache.size >= SNAPSHOT_CACHE_MAX) {
    const oldestKey = snapshotCache.keys().next().value;
    if (oldestKey !== undefined) {
      snapshotCache.delete(oldestKey);
    }
  }
  // Re-inserting an existing key: delete first so the new insert lands at the
  // end (most-recently-used position).
  snapshotCache.delete(runId);
  snapshotCache.set(runId, entry);
}

async function getSnapshotCacheEntry(
  runId: string,
  eventLogRepo: SnapshotEventLogRepo,
  warn: RunRouteWarnLogger | undefined
): Promise<SnapshotCacheEntry> {
  for (;;) {
    const existing = snapshotCompactionInflight.get(runId);
    if (existing !== undefined) {
      await existing;
      continue;
    }

    const compactionPromise = loadSnapshotCacheEntry(runId, eventLogRepo, warn);
    snapshotCompactionInflight.set(runId, compactionPromise);

    try {
      return await compactionPromise;
    } finally {
      if (snapshotCompactionInflight.get(runId) === compactionPromise) {
        snapshotCompactionInflight.delete(runId);
      }
    }
  }
}

async function loadSnapshotCacheEntry(
  runId: string,
  eventLogRepo: SnapshotEventLogRepo,
  warn: RunRouteWarnLogger | undefined
): Promise<SnapshotCacheEntry> {
  const now = Date.now();
  const cached = cacheGet(runId);
  const cacheHit = cached !== undefined && now - cached.cachedAt < SNAPSHOT_CACHE_TTL_MS;

  if (cacheHit) {
    // Use queryByRunAfterEventId to avoid fetching the full event history when
    // the run has received no new events since the last snapshot.
    if (cached.latestEventId !== null && eventLogRepo.queryByRunAfterEventId !== undefined) {
      try {
        const [probe, cursorState] = await Promise.all([
          eventLogRepo.queryByRunAfterEventId(runId, cached.latestEventId),
          eventLogRepo.queryByRunCursorState?.(runId, cached.latestEventId) ?? Promise.resolve(null)
        ]);

        if (probe.length === 0) {
          const cachedReuseReason = getCachedReuseInvalidationReason(cached, cursorState);
          if (cachedReuseReason !== null) {
            return rebuildSnapshotCacheEntry(runId, eventLogRepo, cached, cursorState, cachedReuseReason, warn);
          }
          return cached;
        }

        const prefixDriftReason = getCursorPrefixDriftReason(cached, cursorState);
        if (prefixDriftReason !== null) {
          return rebuildSnapshotCacheEntry(runId, eventLogRepo, cached, cursorState, prefixDriftReason, warn);
        }

        if (isSurfaceStateEmpty(cached.surfaceState)) {
          // With a valid cursor/prefix, an empty cached control-plane surface
          // can safely absorb a direct probe replay without paying for a full
          // history fetch.
          const compacted = compactRunSnapshotSurfaceState(probe);
          return cacheSnapshotCompactionEntry(
            runId,
            {
              surfaceState: compacted.surfaceState,
              latestControlPlaneEventId:
                compacted.latestControlPlaneEventId ?? cached.latestControlPlaneEventId
            },
            lastEventId(probe) ?? cached.latestEventId,
            deriveEventsUpToCursorFromProbe(cached, probe, cursorState)
          );
        }
      } catch (probeError) {
        // queryByRunAfterEventId is optional infrastructure; if it fails, fall
        // through to the full-fetch path rather than surfacing an error.
        logRunRouteWarning(warn, "[daemon] queryByRunAfterEventId probe failed, falling back to full fetch", {
          runId,
          error: probeError instanceof Error ? probeError.message : String(probeError)
        });
      }
    }

    // Incremental path: fetch all events then filter in-memory to those after
    // the last processed event_id.
    try {
      const allEvents = await eventLogRepo.queryByRun(runId);
      const deltaEvents = filterEventsAfter(allEvents, cached.latestEventId);

      if (deltaEvents === null) {
        // H1: cursor-loss detected — cached.latestEventId is no longer present in
        // the fresh event list (event was deleted by a rollback). The cached surface
        // state may contain phantom contributions from the deleted event. Evict the
        // cache entry and rebuild from empty using the current event set.
        logRunRouteWarning(warn, "[daemon] snapshot cursor-loss detected, rebuilding from empty state", {
          runId,
          missingCursorEventId: cached.latestEventId
        });
        snapshotCache.delete(runId);
        return cacheSnapshotCompactionEntry(
          runId,
          compactRunSnapshotSurfaceState(allEvents),
          lastEventId(allEvents) ?? null,
          allEvents.length
        );
      }

      if (eventLogRepo.queryByRunCursorState === undefined) {
        logRunRouteWarning(warn, "[daemon] snapshot fallback missing cursor metadata, rebuilding from full replay", {
          runId,
          cachedLatestEventId: cached.latestEventId
        });
        snapshotCache.delete(runId);
        return cacheSnapshotCompactionEntry(
          runId,
          compactRunSnapshotSurfaceState(allEvents),
          lastEventId(allEvents) ?? null,
          allEvents.length
        );
      }

      let cursorState: SnapshotCursorState;
      try {
        cursorState = await eventLogRepo.queryByRunCursorState(runId, cached.latestEventId);
      } catch (cursorStateError) {
        logRunRouteWarning(warn, "[daemon] snapshot fallback cursor metadata failed, rebuilding from full replay", {
          runId,
          cachedLatestEventId: cached.latestEventId,
          error: cursorStateError instanceof Error ? cursorStateError.message : String(cursorStateError)
        });
        snapshotCache.delete(runId);
        return cacheSnapshotCompactionEntry(
          runId,
          compactRunSnapshotSurfaceState(allEvents),
          lastEventId(allEvents) ?? null,
          allEvents.length
        );
      }

      const prefixDriftReason = getCursorPrefixDriftReason(cached, cursorState);
      if (prefixDriftReason !== null) {
        logRunRouteWarning(warn, "[daemon] snapshot cache metadata drift detected on fallback replay", {
          runId,
          reason: prefixDriftReason,
          snapshotCursorRun: cached.snapshotCursorRun,
          cachedLatestEventId: cached.latestEventId,
          repoLatestEventId: cursorState.latestEventId,
          cachedEventsUpToCursor: cached.eventsUpToCursor,
          repoEventsUpToCursor: cursorState.eventsUpToCursor
        });
        snapshotCache.delete(runId);
        return cacheSnapshotCompactionEntry(
          runId,
          compactRunSnapshotSurfaceState(allEvents),
          lastEventId(allEvents) ?? null,
          allEvents.length
        );
      }

      if (deltaEvents.length === 0) {
        const cachedReuseReason = getCachedReuseInvalidationReason(cached, cursorState);

        if (cachedReuseReason !== null) {
          logRunRouteWarning(warn, "[daemon] snapshot cache metadata drift detected on fallback replay", {
            runId,
            reason: cachedReuseReason,
            snapshotCursorRun: cached.snapshotCursorRun,
            cachedLatestEventId: cached.latestEventId,
            repoLatestEventId: cursorState.latestEventId,
            cachedEventsUpToCursor: cached.eventsUpToCursor,
            repoEventsUpToCursor: cursorState.eventsUpToCursor
          });
          snapshotCache.delete(runId);
          return cacheSnapshotCompactionEntry(
            runId,
            compactRunSnapshotSurfaceState(allEvents),
            lastEventId(allEvents) ?? null,
            allEvents.length
          );
        }
        return cached;
      }

      const compacted = compactRunSnapshotSurfaceState(deltaEvents, cached.surfaceState);
      return cacheSnapshotCompactionEntry(
        runId,
        {
          surfaceState: compacted.surfaceState,
          latestControlPlaneEventId:
            compacted.latestControlPlaneEventId ?? cached.latestControlPlaneEventId
        },
        lastEventId(allEvents) ?? cached.latestEventId,
        allEvents.length
      );
    } catch (error) {
      logRunRouteWarning(warn, "[daemon] incremental snapshot compaction failed, falling back to full replay", {
        runId,
        error: error instanceof Error ? error.message : String(error)
      });
    }
  }

  const events = await eventLogRepo.queryByRun(runId);
  return cacheSnapshotCompactionEntry(
    runId,
    compactRunSnapshotSurfaceState(events),
    lastEventId(events) ?? null,
    events.length
  );
}

/**
 * Returns events from allEvents that come AFTER the given lastEventId in the
 * ordered result set.
 *
 * - If lastEventId is null, returns all events (no prior cursor → full history
 *   is the delta).
 * - If lastEventId is present in allEvents, returns all events after it.
 * - If lastEventId is NOT present in allEvents (cursor-loss: the event was
 *   deleted, e.g. by a publishWithMutation rollback), returns null to signal
 *   to the caller that the cache must be evicted and rebuilt from empty state.
 *   Returning all events as a delta in this case would apply events on top of
 *   cached surface state that already incorporates contributions from the now-
 *   deleted event, resulting in phantom state surviving until TTL expiry.
 */
function filterEventsAfter(
  allEvents: readonly EventLogEntry[],
  lastEventId: string | null
): readonly EventLogEntry[] | null {
  if (lastEventId === null) {
    return allEvents;
  }
  const idx = allEvents.findIndex((e) => e.event_id === lastEventId);
  if (idx === -1) {
    // Cursor-loss: cached cursor event is no longer in the event log.
    // Signal the caller to evict the cache and rebuild from empty.
    return null;
  }
  return allEvents.slice(idx + 1);
}

/** Returns the event_id of the last entry in the array, or undefined if empty. */
function lastEventId(events: readonly EventLogEntry[]): string | undefined {
  return events.length > 0 ? events[events.length - 1]!.event_id : undefined;
}

function cacheSnapshotCompactionEntry(
  runId: string,
  compacted: {
    readonly surfaceState: RunSnapshotSurfaceState;
    readonly latestControlPlaneEventId: string | null;
  },
  latestEventId: string | null,
  eventsUpToCursor: number
): SnapshotCacheEntry {
  const entry = {
    surfaceState: compacted.surfaceState,
    latestEventId,
    latestControlPlaneEventId: compacted.latestControlPlaneEventId,
    snapshotCursorRun: runId,
    eventsUpToCursor,
    cachedAt: Date.now()
  } satisfies SnapshotCacheEntry;
  cacheSet(runId, entry);
  return entry;
}

function deriveEventsUpToCursorFromProbe(
  cached: Readonly<SnapshotCacheEntry>,
  probe: readonly EventLogEntry[],
  cursorState: Readonly<SnapshotCursorState> | null
): number {
  if (cursorState === null) {
    return cached.eventsUpToCursor + probe.length;
  }

  return (cursorState.cursorExists ? cursorState.eventsUpToCursor : 0) + probe.length;
}

function getCursorPrefixDriftReason(
  cached: Readonly<SnapshotCacheEntry>,
  cursorState: Readonly<SnapshotCursorState> | null
): "cursor-missing" | "prefix-regressed" | null {
  if (cursorState === null) {
    return null;
  }

  if (
    cached.latestEventId === null &&
    !cursorState.cursorExists &&
    cursorState.eventsUpToCursor === 0 &&
    cursorState.latestEventId === null
  ) {
    return null;
  }

  if (!cursorState.cursorExists) {
    return "cursor-missing";
  }

  if (cursorState.eventsUpToCursor < cached.eventsUpToCursor) {
    return "prefix-regressed";
  }

  return null;
}

function getCachedReuseInvalidationReason(
  cached: Readonly<SnapshotCacheEntry>,
  cursorState: Readonly<SnapshotCursorState> | null
): "cursor-missing" | "prefix-regressed" | "latest-event-drift" | null {
  const prefixDriftReason = getCursorPrefixDriftReason(cached, cursorState);
  if (prefixDriftReason !== null) {
    return prefixDriftReason;
  }

  if (
    cursorState !== null &&
    cursorState.latestEventId !== null &&
    cursorState.latestEventId !== cached.latestEventId
  ) {
    return "latest-event-drift";
  }

  return null;
}

async function rebuildSnapshotCacheEntry(
  runId: string,
  eventLogRepo: SnapshotEventLogRepo,
  cached: Readonly<SnapshotCacheEntry>,
  cursorState: Readonly<SnapshotCursorState> | null,
  reason: "cursor-missing" | "prefix-regressed" | "latest-event-drift",
  warn: RunRouteWarnLogger | undefined
): Promise<SnapshotCacheEntry> {
  logRunRouteWarning(warn, "[daemon] snapshot cache metadata drift detected, rebuilding from full replay", {
    runId,
    reason,
    snapshotCursorRun: cached.snapshotCursorRun,
    cachedLatestEventId: cached.latestEventId,
    repoLatestEventId: cursorState?.latestEventId ?? null,
    cachedEventsUpToCursor: cached.eventsUpToCursor,
    repoEventsUpToCursor: cursorState?.eventsUpToCursor ?? null
  });
  snapshotCache.delete(runId);
  const allEvents = await eventLogRepo.queryByRun(runId);
  return cacheSnapshotCompactionEntry(
    runId,
    compactRunSnapshotSurfaceState(allEvents),
    lastEventId(allEvents) ?? null,
    allEvents.length
  );
}

function logRunRouteWarning(
  warn: RunRouteWarnLogger | undefined,
  message: string,
  meta: Record<string, unknown>
): void {
  (warn ?? defaultRunRouteWarning)(message, meta);
}

function defaultRunRouteWarning(message: string, meta: Record<string, unknown>): void {
  console.warn(message, meta);
}

function isSurfaceStateEmpty(surfaceState: RunSnapshotSurfaceState): boolean {
  return (
    (surfaceState.workers?.length ?? 0) === 0 &&
    (surfaceState.worker_integration_statuses?.length ?? 0) === 0 &&
    (surfaceState.tools?.length ?? 0) === 0 &&
    (surfaceState.approvals?.length ?? 0) === 0 &&
    surfaceState.governance_fault === undefined
  );
}
