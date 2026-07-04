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
import {
  queryRunEventLog,
  type SnapshotCursorState,
  type SnapshotEventLogRepo
} from "./run-snapshot-event-log.js";

export type { SnapshotCursorState } from "./run-snapshot-event-log.js";

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

type SnapshotProbeResult = SnapshotCacheEntry | "needs-full-replay";
type SnapshotRebuildReason =
  | "cursor-loss"
  | "cursor-state-unavailable"
  | "cursor-missing"
  | "prefix-regressed"
  | "latest-event-drift";

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

  if (!cacheHit) {
    return cacheSnapshotFromFullReplay(runId, eventLogRepo);
  }

  const probeResult = await tryResolveCachedSnapshotFromProbe(runId, eventLogRepo, cached, warn);
  if (probeResult !== "needs-full-replay") {
    return probeResult;
  }

  return await loadCachedSnapshotFromFullReplay(runId, eventLogRepo, cached, warn);
}

async function tryResolveCachedSnapshotFromProbe(
  runId: string,
  eventLogRepo: SnapshotEventLogRepo,
  cached: Readonly<SnapshotCacheEntry>,
  warn: RunRouteWarnLogger | undefined
): Promise<SnapshotProbeResult> {
  if (cached.latestEventId === null || eventLogRepo.queryByRunAfterEventId === undefined) {
    return "needs-full-replay";
  }

  try {
    const [probe, cursorState] = await Promise.all([
      eventLogRepo.queryByRunAfterEventId(runId, cached.latestEventId),
      eventLogRepo.queryByRunCursorState?.(runId, cached.latestEventId) ?? Promise.resolve(null)
    ]);

    if (probe.length === 0) {
      return await resolveEmptyProbeSnapshot(runId, eventLogRepo, cached, cursorState, warn);
    }

    const prefixDriftReason = getCursorPrefixDriftReason(cached, cursorState);
    if (prefixDriftReason !== null) {
      return await rebuildSnapshotCacheEntry(runId, eventLogRepo, cached, cursorState, prefixDriftReason, warn);
    }
  } catch (probeError) {
    logRunRouteWarning(warn, "[daemon] queryByRunAfterEventId probe failed, falling back to full fetch", {
      runId,
      error: probeError instanceof Error ? probeError.message : String(probeError)
    });
  }

  return "needs-full-replay";
}

async function resolveEmptyProbeSnapshot(
  runId: string,
  eventLogRepo: SnapshotEventLogRepo,
  cached: Readonly<SnapshotCacheEntry>,
  cursorState: Readonly<SnapshotCursorState> | null,
  warn: RunRouteWarnLogger | undefined
): Promise<SnapshotCacheEntry> {
  const cachedReuseReason = getCachedReuseInvalidationReason(cached, cursorState);
  if (cachedReuseReason !== null) {
    return await rebuildSnapshotCacheEntry(runId, eventLogRepo, cached, cursorState, cachedReuseReason, warn);
  }
  return cached;
}

async function loadCachedSnapshotFromFullReplay(
  runId: string,
  eventLogRepo: SnapshotEventLogRepo,
  cached: Readonly<SnapshotCacheEntry>,
  warn: RunRouteWarnLogger | undefined
): Promise<SnapshotCacheEntry> {
  try {
    const allEvents = await queryRunEventLog(eventLogRepo, runId);
    const deltaEvents = filterEventsAfter(allEvents, cached.latestEventId);

    if (deltaEvents === null) {
      return rebuildSnapshotCacheEntryFromEvents(runId, allEvents, "cursor-loss", warn, {
        missingCursorEventId: cached.latestEventId
      });
    }

    const cursorState = await readFallbackCursorState(runId, eventLogRepo, cached, warn);
    if (cursorState === null) {
      return rebuildSnapshotCacheEntryFromEvents(runId, allEvents, "cursor-state-unavailable", warn);
    }

    const rebuildReason = getFallbackReplayRebuildReason(cached, cursorState, deltaEvents);
    if (rebuildReason !== null) {
      return rebuildSnapshotCacheEntryFromEvents(runId, allEvents, rebuildReason, warn, {
        snapshotCursorRun: cached.snapshotCursorRun,
        cachedLatestEventId: cached.latestEventId,
        repoLatestEventId: cursorState.latestEventId,
        cachedEventsUpToCursor: cached.eventsUpToCursor,
        repoEventsUpToCursor: cursorState.eventsUpToCursor
      });
    }

    if (deltaEvents.length === 0) {
      return cached;
    }

    return cacheSnapshotDeltaEntry(runId, cached, allEvents, deltaEvents);
  } catch (error) {
    logRunRouteWarning(warn, "[daemon] incremental snapshot compaction failed, falling back to full replay", {
      runId,
      error: error instanceof Error ? error.message : String(error)
    });
    return await cacheSnapshotFromFullReplay(runId, eventLogRepo);
  }
}

async function readFallbackCursorState(
  runId: string,
  eventLogRepo: SnapshotEventLogRepo,
  cached: Readonly<SnapshotCacheEntry>,
  warn: RunRouteWarnLogger | undefined
): Promise<SnapshotCursorState | null> {
  if (eventLogRepo.queryByRunCursorState === undefined) {
    logRunRouteWarning(warn, "[daemon] snapshot fallback missing cursor metadata, rebuilding from full replay", {
      runId,
      cachedLatestEventId: cached.latestEventId
    });
    return null;
  }

  try {
    return await eventLogRepo.queryByRunCursorState(runId, cached.latestEventId);
  } catch (cursorStateError) {
    logRunRouteWarning(warn, "[daemon] snapshot fallback cursor metadata failed, rebuilding from full replay", {
      runId,
      cachedLatestEventId: cached.latestEventId,
      error: cursorStateError instanceof Error ? cursorStateError.message : String(cursorStateError)
    });
    return null;
  }
}

function getFallbackReplayRebuildReason(
  cached: Readonly<SnapshotCacheEntry>,
  cursorState: Readonly<SnapshotCursorState>,
  deltaEvents: readonly EventLogEntry[]
): SnapshotRebuildReason | null {
  const prefixDriftReason = getCursorPrefixDriftReason(cached, cursorState);
  if (prefixDriftReason !== null) {
    return prefixDriftReason;
  }

  if (deltaEvents.length === 0) {
    return getCachedReuseInvalidationReason(cached, cursorState);
  }

  return null;
}

function rebuildSnapshotCacheEntryFromEvents(
  runId: string,
  allEvents: readonly EventLogEntry[],
  reason: SnapshotRebuildReason,
  warn: RunRouteWarnLogger | undefined,
  meta: Record<string, unknown> = {}
): SnapshotCacheEntry {
  logRunRouteWarning(warn, "[daemon] snapshot cache metadata drift detected, rebuilding from full replay", {
    runId,
    reason,
    ...meta
  });
  snapshotCache.delete(runId);
  return cacheSnapshotCompactionEntry(
    runId,
    compactRunSnapshotSurfaceState(allEvents),
    lastEventId(allEvents) ?? null,
    allEvents.length
  );
}

function cacheSnapshotDeltaEntry(
  runId: string,
  cached: Readonly<SnapshotCacheEntry>,
  allEvents: readonly EventLogEntry[],
  deltaEvents: readonly EventLogEntry[]
): SnapshotCacheEntry {
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
}

async function cacheSnapshotFromFullReplay(
  runId: string,
  eventLogRepo: SnapshotEventLogRepo
): Promise<SnapshotCacheEntry> {
  const events = await queryRunEventLog(eventLogRepo, runId);
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
 *   deleted, e.g. by an EventPublisher rollback), returns null to signal
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
  return await cacheSnapshotFromFullReplay(runId, eventLogRepo);
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
