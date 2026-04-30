import type { Hono } from "hono";
import { CoreError, type ConversationService, type RunHotStateService, type RunService } from "@do-soul/alaya-core";
import { parseJsonBody } from "./shared.js";
import {
  type EventLogEntry,
  parsePhaseCEventPayload,
  parsePhaseA1EventPayload,
  parsePhaseA3EventPayload,
  parsePhase5EventPayload,
  PhaseCEventType,
  PhaseA1EventType,
  PhaseA3EventType,
  Phase5EventType,
  type OutputShapingAppliedPayload,
  type RunHotState,
  RunInterruptResultSchema,
  type RunSnapshot,
  type RunSnapshotSurfaceApproval,
  type RunSnapshotSurfaceState,
  type RunSnapshotSurfaceToolState,
  type RunSnapshotSurfaceWorkerState,
  type WorkerIntegrationStatusPayload
} from "@do-soul/alaya-protocol";

// ---------------------------------------------------------------------------
// Snapshot LRU cache
// ---------------------------------------------------------------------------

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

interface SnapshotCursorState {
  readonly cursorExists: boolean;
  readonly eventsUpToCursor: number;
  readonly latestEventId: string | null;
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

/** Exported for tests only — resets the module-level cache. */
export function resetSnapshotCacheForTesting(): void {
  snapshotCache.clear();
  snapshotCompactionInflight.clear();
}

export interface RunRouteServices {
  readonly runService: RunService;
  readonly conversationService: ConversationService;
  readonly runHotStateService: RunHotStateService;
  readonly eventLogRepo?: {
    queryByRun(runId: string): Promise<readonly EventLogEntry[]>;
    /**
     * Returns events for the run with rowid strictly after the row whose
     * event_id equals lastEventId. When lastEventId does not exist in the DB
     * (e.g. it was deleted by a rollback), the storage layer falls back to
     * rowid > 0 and returns ALL events for the run. Callers must treat a
     * non-empty result as potentially ambiguous (cursor-loss vs genuine delta)
     * and use the queryByRun + filterEventsAfter path for safety in that case.
     *
     * Optional: when absent the cache-hit path skips the M1 fast-path probe
     * and falls through to the full queryByRun fetch.
     */
    queryByRunAfterEventId?(runId: string, lastEventId: string): Promise<readonly EventLogEntry[]>;
    queryByRunCursorState?(
      runId: string,
      lastEventId: string | null
    ): Promise<SnapshotCursorState>;
    //
    // Note: an empty result is also returned when the cursor event itself was
    // deleted AND no events have been appended since. C-28 pairs the fast-path
    // probe with queryByRunCursorState so the route can detect that drift and
    // rebuild from current event history instead of relying on TTL expiry.
  };
  readonly governanceLeaseService?: {
    release(runId: string): Promise<void>;
  };
  readonly sessionOverrideService?: {
    clearRun(runId: string): void;
  };
  readonly budgetBankruptcyService?: {
    clearRun(runId: string): void;
  };
  readonly contextLensAssembler?: {
    clearLens(runId: string): void;
  };
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
}

export function registerRunRoutes(app: Hono, services: RunRouteServices): void {
  app.post("/workspaces/:id/runs", async (context) => {
    const run = await services.runService.create(
      context.req.param("id"),
      await parseJsonBody(context.req.json.bind(context.req))
    );

    return context.json({ success: true, data: run }, 201);
  });

  app.get("/workspaces/:id/runs", async (context) => {
    const runs = await services.runService.listByWorkspace(context.req.param("id"));
    return context.json({ success: true, data: runs }, 200);
  });

  app.get("/runs/:id", async (context) => {
    const run = await services.runService.getById(context.req.param("id"));
    return context.json({ success: true, data: run }, 200);
  });

  app.get("/runs/:id/messages", async (context) => {
    const messages = await services.conversationService.listMessages(context.req.param("id"));
    return context.json({ success: true, data: messages }, 200);
  });

  app.post("/runs/:id/messages", async (context) => {
    const response = await services.conversationService.sendMessage(
      context.req.param("id"),
      await parseJsonBody(context.req.json.bind(context.req))
    );

    return context.json({ success: true, data: response }, 200);
  });

  app.post("/runs/:id/messages/stream", async (context) => {
    const response = await services.conversationService.sendMessageStreaming(
      context.req.param("id"),
      await parseJsonBody(context.req.json.bind(context.req))
    );

    return context.json({ success: true, data: response }, 200);
  });

  app.post("/runs/:id/interrupt", async (context) => {
    const runId = context.req.param("id");
    const result = await services.conversationService.interruptRun(runId);

    return context.json({ success: true, data: RunInterruptResultSchema.parse(result) }, 200);
  });

  app.get("/runs/:id/snapshot", async (context) => {
    const runId = context.req.param("id");
    await services.runService.getById(runId);
    const snapshot = await services.runHotStateService.getSnapshot(runId);

    if (snapshot === null) {
      throw new CoreError("NOT_FOUND", "Run not found");
    }

    try {
      return context.json(
        { success: true, data: await enrichRunSnapshot(snapshot, runId, services.eventLogRepo, services.warn) },
        200
      );
    } catch (error) {
      if (error instanceof SnapshotCompactionError) {
        logRunRouteWarning(services.warn, "[daemon] snapshot compaction failed", {
          runId,
          message: error.message
        });

        return context.json(
          {
            success: false,
            error: "Failed to compact run snapshot"
          },
          500
        );
      }

      throw error;
    }
  });

  app.patch("/runs/:id", async (context) => {
    const runId = context.req.param("id");
    const body = await parseJsonBody(context.req.json.bind(context.req));
    const run = await services.runService.rename({ run_id: runId, ...(body as Record<string, unknown>) });
    return context.json({ success: true, data: run }, 200);
  });

  app.delete("/runs/:id", async (context) => {
    const runId = context.req.param("id");
    const run = await services.runService.delete(runId);
    snapshotCache.delete(runId);
    services.sessionOverrideService?.clearRun(runId);
    services.budgetBankruptcyService?.clearRun(runId);
    services.contextLensAssembler?.clearLens(runId);

    // The run delete is already durable; lease release must stay best-effort so
    // stale in-process state cannot survive a successful delete.
    await services.governanceLeaseService?.release(runId).catch(() => undefined);

    return context.json({ success: true, data: run }, 200);
  });
}

async function enrichRunSnapshot(
  snapshot: RunHotState,
  runId: string,
  eventLogRepo: RunRouteServices["eventLogRepo"],
  warn: RunRouteServices["warn"]
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

async function getSnapshotCacheEntry(
  runId: string,
  eventLogRepo: NonNullable<RunRouteServices["eventLogRepo"]>,
  warn: RunRouteServices["warn"]
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
  eventLogRepo: NonNullable<RunRouteServices["eventLogRepo"]>,
  warn: RunRouteServices["warn"]
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
  eventLogRepo: NonNullable<RunRouteServices["eventLogRepo"]>,
  cached: Readonly<SnapshotCacheEntry>,
  cursorState: Readonly<SnapshotCursorState> | null,
  reason: "cursor-missing" | "prefix-regressed" | "latest-event-drift",
  warn: RunRouteServices["warn"]
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
  warn: RunRouteServices["warn"],
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

class SnapshotCompactionError extends Error {}

interface PendingSnapshotToolState extends RunSnapshotSurfaceToolState {
  readonly completion_event_id: string | null;
}

/**
 * Compacts a sequence of EventLogEntry records into a RunSnapshotSurfaceState.
 *
 * @param events - The ordered event log entries to process.
 * @param startState - Optional prior surface state to use as the starting point
 *   for the maps. When provided the function only processes delta events on top
 *   of an already-compacted base, enabling incremental compaction. Omit (or
 *   pass undefined) for a full replay starting from an empty state.
 */
function compactRunSnapshotSurfaceState(
  events: readonly EventLogEntry[],
  startState?: RunSnapshotSurfaceState
): {
  readonly surfaceState: RunSnapshotSurfaceState;
  readonly latestControlPlaneEventId: string | null;
} {
  if (
    startState !== undefined &&
    events.some(
      (event) =>
        event.event_type === PhaseCEventType.OUTPUT_SHAPING_APPLIED ||
        event.event_type === PhaseCEventType.OUTPUT_COMMAND_COMPRESSED ||
        event.event_type === "message.completed" ||
        event.event_type === "engine.response.received"
    )
  ) {
    throw new SnapshotCompactionError(
      "Incremental snapshot compaction cannot replay deferred output-shaping windows safely"
    );
  }

  // Seed maps from the optional prior surface state (incremental path).
  const workers = new Map<string, RunSnapshotSurfaceWorkerState>(
    startState?.workers?.map((w) => [w.worker_id, w]) ?? []
  );
  let tools = new Map<string, RunSnapshotSurfaceToolState>(
    startState?.tools?.map((t) => [t.tool_call_id, t]) ?? []
  );
  const approvals = new Map<string, RunSnapshotSurfaceApproval>(
    startState?.approvals?.map((a) => [a.approval_id, a]) ?? []
  );
  const workerIntegrationStatuses = new Map<string, WorkerIntegrationStatusPayload>(
    startState?.worker_integration_statuses?.map((s) => [s.workerRunId, s]) ?? []
  );
  let pendingTools = new Map<string, PendingSnapshotToolState>(
    startState?.tools?.map((tool) => [tool.tool_call_id, { ...tool, completion_event_id: null }]) ?? []
  );
  let pendingCompletedToolOrder: string[] = [];
  let pendingCompletedToolIds = new Set<string>();
  let pendingOutputShapingDecisions: OutputShapingAppliedPayload[] = [];
  let pendingToolFailOpenCutoffEventId: string | null = null;
  let pendingCompressionReplayCutoffEventId: string | null = null;
  let governanceFault: RunSnapshotSurfaceState["governance_fault"] = startState?.governance_fault ?? null;
  let latestControlPlaneEventId: string | null = null;

  const markContribution = (event: EventLogEntry): void => {
    latestControlPlaneEventId = event.event_id;
  };

  for (const event of events) {
    const payload = event.payload_json;

    if (event.event_type === PhaseA1EventType.WORKER_STATE_CHANGED) {
      const parsed = parsePhaseA1EventPayloadOrThrow(
        PhaseA1EventType.WORKER_STATE_CHANGED,
        payload,
        event
      );
      workers.set(parsed.workerId, {
        worker_id: parsed.workerId,
        status: parsed.state,
        ...(parsed.suspendReason !== undefined ? { suspend_reason: parsed.suspendReason } : {})
      });
      markContribution(event);

      continue;
    }

    if (event.event_type === PhaseA3EventType.WORKER_INTEGRATION_STATUS) {
      const parsed = parsePhaseA3EventPayloadOrThrow(
        PhaseA3EventType.WORKER_INTEGRATION_STATUS,
        payload,
        event
      );
      workerIntegrationStatuses.set(parsed.workerRunId, parsed);
      markContribution(event);

      continue;
    }

    if (event.event_type === PhaseA1EventType.TOOL_CALL_STARTED) {
      const parsed = parsePhaseA1EventPayloadOrThrow(
        PhaseA1EventType.TOOL_CALL_STARTED,
        payload,
        event
      );
      const previous = pendingTools.get(parsed.toolCallId);

      const nextPendingTool = {
        tool_call_id: parsed.toolCallId,
        worker_id: parsed.workerId ?? null,
        tool_id: parsed.toolId,
        input_summary: parsed.inputSummary,
        status_kind: previous?.status_kind ?? "running",
        output_summary: previous?.output_summary ?? null,
        duration_ms: previous?.duration_ms ?? null,
        completion_event_id: previous?.completion_event_id ?? null
      };
      pendingTools.set(parsed.toolCallId, nextPendingTool);
      tools.set(parsed.toolCallId, stripPendingSnapshotToolState(nextPendingTool));
      pendingToolFailOpenCutoffEventId = null;
      markContribution(event);

      continue;
    }

    if (event.event_type === PhaseA1EventType.TOOL_CALL_COMPLETED) {
      const parsed = parsePhaseA1EventPayloadOrThrow(
        PhaseA1EventType.TOOL_CALL_COMPLETED,
        payload,
        event
      );
      const previous = pendingTools.get(parsed.toolCallId);

      if (previous === undefined) {
        throw new SnapshotCompactionError(
          `Cannot compact snapshot for ${event.run_id}: tool_call.completed ${parsed.toolCallId} has no preceding tool_call.started`
        );
      }

      pendingTools.set(parsed.toolCallId, {
        ...previous,
        status_kind: parsed.statusKind,
        output_summary: parsed.outputSummary ?? null,
        duration_ms: parsed.durationMs,
        completion_event_id: event.event_id
      });
      tools.set(parsed.toolCallId, {
        ...stripPendingSnapshotToolState(previous),
        status_kind: parsed.statusKind,
        duration_ms: parsed.durationMs
      });
      if (pendingCompletedToolIds.size === 0) {
        pendingCompressionReplayCutoffEventId = latestControlPlaneEventId;
      }
      if (!pendingCompletedToolIds.has(event.event_id)) {
        pendingCompletedToolIds.add(event.event_id);
        pendingCompletedToolOrder.push(event.event_id);
      }
      markContribution(event);

      continue;
    }

    if (
      pendingCompletedToolOrder.length > 0 &&
      (event.event_type === "message.completed" || event.event_type === "engine.response.received")
    ) {
      pendingToolFailOpenCutoffEventId = event.event_id;
    }

    if (event.event_type === PhaseCEventType.OUTPUT_SHAPING_APPLIED) {
      pendingOutputShapingDecisions.push(
        parsePhaseCEventPayloadOrThrow(PhaseCEventType.OUTPUT_SHAPING_APPLIED, payload, event)
      );

      continue;
    }

    if (event.event_type === PhaseCEventType.OUTPUT_COMMAND_COMPRESSED) {
      parsePhaseCEventPayloadOrThrow(PhaseCEventType.OUTPUT_COMMAND_COMPRESSED, payload, event);
      const flushResult = flushCompactedSurfaceTools({
        visibleTools: tools,
        pendingTools,
        pendingCompletedToolOrder,
        pendingOutputShapingDecisions
      });
      tools = flushResult.visibleTools;
      pendingTools = flushResult.pendingTools;
      pendingCompletedToolOrder = flushResult.pendingCompletedToolOrder;
      pendingCompletedToolIds = new Set(pendingCompletedToolOrder);
      pendingOutputShapingDecisions = flushResult.pendingOutputShapingDecisions;
      pendingToolFailOpenCutoffEventId = null;
      pendingCompressionReplayCutoffEventId = null;
      markContribution(event);

      continue;
    }

    if (event.event_type === PhaseA1EventType.GOVERNANCE_SPAM_FAULT) {
      governanceFault = parsePhaseA1EventPayloadOrThrow(
        PhaseA1EventType.GOVERNANCE_SPAM_FAULT,
        payload,
        event
      );
      markContribution(event);
      continue;
    }

    if (event.event_type === Phase5EventType.SOUL_APPROVAL_REQUESTED) {
      const parsed = parsePhase5EventPayloadOrThrow(
        Phase5EventType.SOUL_APPROVAL_REQUESTED,
        payload,
        event
      );
      const previous = approvals.get(parsed.approval_id);

      if (previous?.status !== "approved" && previous?.status !== "rejected") {
        approvals.set(parsed.approval_id, {
          approval_id: parsed.approval_id,
          message_id: parsed.message_id,
          description: parsed.description,
          run_id: parsed.run_id,
          ...(parsed.risk_level !== undefined ? { risk_level: parsed.risk_level } : {}),
          status: "pending"
        });
        markContribution(event);
      }

      continue;
    }

    if (event.event_type === Phase5EventType.SOUL_APPROVAL_RESOLVED) {
      const parsed = parsePhase5EventPayloadOrThrow(
        Phase5EventType.SOUL_APPROVAL_RESOLVED,
        payload,
        event
      );
      approvals.set(parsed.approval_id, {
        approval_id: parsed.approval_id,
        message_id: parsed.message_id,
        description: parsed.description,
        run_id: parsed.run_id,
        ...(parsed.risk_level !== undefined ? { risk_level: parsed.risk_level } : {}),
        status: parsed.result,
        resolved_at: parsed.resolved_at
      });
      markContribution(event);
    }
  }

  if (pendingOutputShapingDecisions.length > 0 && pendingCompressionReplayCutoffEventId !== null) {
    latestControlPlaneEventId = pendingCompressionReplayCutoffEventId;
  } else if (pendingCompletedToolOrder.length > 0 && pendingToolFailOpenCutoffEventId !== null) {
    const flushResult = flushCompactedSurfaceTools({
      visibleTools: tools,
      pendingTools,
      pendingCompletedToolOrder,
      pendingOutputShapingDecisions: []
    });
    tools = flushResult.visibleTools;
    pendingTools = flushResult.pendingTools;
    pendingCompletedToolOrder = flushResult.pendingCompletedToolOrder;
    pendingCompletedToolIds = new Set(pendingCompletedToolOrder);
    pendingOutputShapingDecisions = flushResult.pendingOutputShapingDecisions;
    latestControlPlaneEventId = pendingToolFailOpenCutoffEventId;
  }

  return {
    latestControlPlaneEventId,
    surfaceState: {
      ...(workers.size > 0 ? { workers: [...workers.values()] } : {}),
      ...(workerIntegrationStatuses.size > 0
        ? { worker_integration_statuses: [...workerIntegrationStatuses.values()] }
        : {}),
      ...(tools.size > 0 ? { tools: [...tools.values()] } : {}),
      ...(governanceFault !== null ? { governance_fault: governanceFault } : {}),
      ...(approvals.size > 0 ? { approvals: [...approvals.values()] } : {})
    }
  };
}

function flushCompactedSurfaceTools(input: {
  readonly visibleTools: ReadonlyMap<string, RunSnapshotSurfaceToolState>;
  readonly pendingTools: ReadonlyMap<string, PendingSnapshotToolState>;
  readonly pendingCompletedToolOrder: readonly string[];
  readonly pendingOutputShapingDecisions: readonly OutputShapingAppliedPayload[];
}): {
  readonly visibleTools: Map<string, RunSnapshotSurfaceToolState>;
  readonly pendingTools: Map<string, PendingSnapshotToolState>;
  readonly pendingCompletedToolOrder: string[];
  readonly pendingOutputShapingDecisions: OutputShapingAppliedPayload[];
} {
  if (input.pendingCompletedToolOrder.length === 0) {
    return {
      visibleTools: new Map(input.visibleTools),
      pendingTools: new Map(input.pendingTools),
      pendingCompletedToolOrder: [],
      pendingOutputShapingDecisions: []
    };
  }

  const pendingCompletedByEventId = new Map(
    [...input.pendingTools.values()]
      .filter((tool): tool is PendingSnapshotToolState & { readonly completion_event_id: string } => tool.completion_event_id !== null)
      .map((tool) => [tool.completion_event_id, tool] as const)
  );
  const decisionsByFirstEventId = new Map(
    input.pendingOutputShapingDecisions.map((decision) => [decision.original_event_ids[0], decision] as const)
  );
  const flushedToolCallIds = new Set<string>();
  const flushedTools: RunSnapshotSurfaceToolState[] = [];

  for (let index = 0; index < input.pendingCompletedToolOrder.length; ) {
    const currentEventId = input.pendingCompletedToolOrder[index];
    const decision =
      currentEventId === undefined ? undefined : decisionsByFirstEventId.get(currentEventId);

    if (decision !== undefined && matchesSnapshotDecisionWindow(input.pendingCompletedToolOrder, index, decision)) {
      const group = decision.original_event_ids
        .map((eventId) => pendingCompletedByEventId.get(eventId))
        .filter((tool): tool is Exclude<typeof tool, undefined> => tool !== undefined);

      if (group.length === decision.original_event_ids.length) {
        const compressedGroup = compressSnapshotToolGroup(group, decision);
        flushedTools.push(...compressedGroup);
        for (const tool of group) {
          flushedToolCallIds.add(tool.tool_call_id);
        }
        index += decision.original_event_ids.length;
        continue;
      }
    }

    if (currentEventId !== undefined) {
      const currentTool = pendingCompletedByEventId.get(currentEventId);
      if (currentTool !== undefined) {
        flushedTools.push(stripPendingSnapshotToolState(currentTool));
        flushedToolCallIds.add(currentTool.tool_call_id);
      }
    }

    index += 1;
  }

  return {
    visibleTools: new Map([
      ...[...input.visibleTools.entries()].filter(([toolCallId]) => !flushedToolCallIds.has(toolCallId)),
      ...flushedTools.map((tool) => [tool.tool_call_id, tool] as const)
    ]),
    pendingTools: new Map(
      [...input.pendingTools.entries()].filter(([toolCallId]) => !flushedToolCallIds.has(toolCallId))
    ),
    pendingCompletedToolOrder: [],
    pendingOutputShapingDecisions: []
  };
}

function matchesSnapshotDecisionWindow(
  eventOrder: readonly string[],
  startIndex: number,
  decision: OutputShapingAppliedPayload
): boolean {
  return decision.original_event_ids.every(
    (eventId, offset) => eventOrder[startIndex + offset] === eventId
  );
}

function compressSnapshotToolGroup(
  group: readonly (RunSnapshotSurfaceToolState & { readonly completion_event_id: string })[],
  decision: OutputShapingAppliedPayload
): readonly RunSnapshotSurfaceToolState[] {
  switch (decision.compression_mode) {
    case "last_only":
      return [stripPendingSnapshotToolState(group[group.length - 1]!)];
    case "first_last":
      return [
        stripPendingSnapshotToolState(group[0]!),
        stripPendingSnapshotToolState(group[group.length - 1]!)
      ];
    case "count_summary": {
      const representative = group[group.length - 1]!;
      const summary = `${decision.original_count} ${decision.command_class} outputs compressed`;
      const durationMs = group.reduce<number | null>((total, tool) => {
        if (tool.duration_ms === null) {
          return total;
        }

        return (total ?? 0) + tool.duration_ms;
      }, null);

      return [
        {
          tool_call_id: representative.tool_call_id,
          worker_id: representative.worker_id,
          tool_id: representative.tool_id,
          input_summary: summary,
          status_kind: representative.status_kind,
          output_summary: summary,
          duration_ms: durationMs
        }
      ];
    }
  }
}

function stripPendingSnapshotToolState(tool: PendingSnapshotToolState): RunSnapshotSurfaceToolState {
  return {
    tool_call_id: tool.tool_call_id,
    worker_id: tool.worker_id,
    tool_id: tool.tool_id,
    input_summary: tool.input_summary,
    status_kind: tool.status_kind,
    output_summary: tool.output_summary,
    duration_ms: tool.duration_ms
  };
}

function parsePhaseA1EventPayloadOrThrow<T extends Parameters<typeof parsePhaseA1EventPayload>[0]>(
  type: T,
  payload: Record<string, unknown>,
  event: EventLogEntry
) {
  try {
    return parsePhaseA1EventPayload(type, payload);
  } catch (error) {
    throw createSnapshotCompactionParseError(event, error);
  }
}

function parsePhaseCEventPayloadOrThrow<T extends Parameters<typeof parsePhaseCEventPayload>[0]>(
  type: T,
  payload: Record<string, unknown>,
  event: EventLogEntry
) {
  try {
    return parsePhaseCEventPayload(type, payload);
  } catch (error) {
    throw createSnapshotCompactionParseError(event, error);
  }
}

function parsePhaseA3EventPayloadOrThrow<T extends Parameters<typeof parsePhaseA3EventPayload>[0]>(
  type: T,
  payload: Record<string, unknown>,
  event: EventLogEntry
) {
  try {
    return parsePhaseA3EventPayload(type, payload);
  } catch (error) {
    throw createSnapshotCompactionParseError(event, error);
  }
}

function parsePhase5EventPayloadOrThrow<T extends Parameters<typeof parsePhase5EventPayload>[0]>(
  type: T,
  payload: Record<string, unknown>,
  event: EventLogEntry
) {
  try {
    return parsePhase5EventPayload(type, payload);
  } catch (error) {
    throw createSnapshotCompactionParseError(event, error);
  }
}

function createSnapshotCompactionParseError(event: EventLogEntry, error: unknown): SnapshotCompactionError {
  const detail = error instanceof Error ? error.message : String(error);
  return new SnapshotCompactionError(
    `Cannot compact snapshot for ${event.run_id}: malformed ${event.event_type} payload at ${event.event_id} (${detail})`
  );
}
