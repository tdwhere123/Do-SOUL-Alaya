import {
  TrustStateEventType,
  type EventLogEntry,
  type PathRelation,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import {
  PathPlasticityService,
  type PathPlasticityRepoPort,
  type UsageProofReaderPort
} from "@do-soul/alaya-core";
import type {
  SqliteEventLogRepo,
  SqlitePathRelationRepo,
  SqliteTrustStateRepo
} from "@do-soul/alaya-storage";

/**
 * Daemon-side wiring for the A3 path-axis plasticity feedback loop.
 *
 * Provides four pieces:
 *
 *   1. `createUsageProofReader` — adapts the existing event log + trust
 *      state repository to the `UsageProofReaderPort` contract that
 *      `PathPlasticityService` consumes. We read MEMORY_USAGE_REPORTED
 *      events from the event log (the durable record of every usage
 *      receipt), filter by workspace and `reported_at > sinceIso`
 *      (exclusive), then materialize them into `UsageProofRecord` shape
 *      using the existing repo for delivery resolution.
 *
 *   2. `createPathPlasticityService` — instantiates the service with the
 *      adapter + the SQLite path relation repo + the existing event
 *      publisher. The service is tier-2-eligible and is dispatched by the
 *      Garden Auditor's `path_plasticity_update` task kind.
 *
 *   3. `createRecallPathPlasticityPort` — adapts the SQLite path relation
 *      repo to `RecallServicePathPlasticityPort` so recall scoring can
 *      look up the strongest plasticity strength per memory entry. This
 *      is the read side of the loop: receipts feed deltas (write), recall
 *      reads the resulting strengths (read). Both sides run off the
 *      request path (the read is cached at fine-assessment time and the
 *      write runs in Garden).
 *
 *   4. `createPathPlasticityWatermarkRegistry` — closes D2 MERGED-B2
 *      (codex-B2). The Garden Auditor was enqueueing PATH_PLASTICITY_UPDATE
 *      with empty `target_object_refs`, so every tick fell back to
 *      `now - 24h`. Per-call audit_event_id dedup did NOT survive across
 *      ticks, so a single MEMORY_USAGE_REPORTED receipt inside the rolling
 *      24h window was reapplied every Auditor interval (~48 reapplications
 *      in 24h), saturating strength to ceiling or hammering paths to
 *      retirement from one durable receipt. The registry maintains a
 *      per-workspace high-water mark that advances at enqueue time, so
 *      each tick processes records strictly in `(prior, nowAtEnqueue]`.
 *      In v0.1 the registry is in-process (resets at daemon restart with
 *      a 24h lookback for first tick); v0.2 will durabilize the watermark
 *      via a dedicated table (see #BL-035).
 */

interface MemoryUsageReportedPayload {
  readonly delivery_id: string;
  readonly usage_state: UsageProofRecord["usage_state"];
  readonly used_object_ids: readonly string[];
  readonly reason: string | null;
  readonly reported_at: string;
}

export function createUsageProofReader(deps: {
  readonly eventLogRepo: Pick<SqliteEventLogRepo, "queryByWorkspace">;
  readonly trustStateRepo: Pick<SqliteTrustStateRepo, "findDeliveryById">;
}): UsageProofReaderPort {
  return {
    listRecentUsage: async (
      workspaceId: string,
      sinceIso: string
    ): Promise<readonly Readonly<UsageProofRecord>[]> => {
      // Use the event log as the source of truth for "recent usage". The
      // alternative — listing deliveries by agent target then joining
      // usage by delivery_id — requires knowing every agent_target up
      // front, which we don't here. queryByWorkspace + a type filter is
      // the cheapest workspace-scoped read available.
      const events = await deps.eventLogRepo.queryByWorkspace(workspaceId);
      const sinceMs = Date.parse(sinceIso);
      const records: UsageProofRecord[] = [];

      for (const event of events) {
        if (event.event_type !== TrustStateEventType.MEMORY_USAGE_REPORTED) {
          continue;
        }
        const payload = parseMemoryUsageReportedPayload(event);
        if (payload === null) {
          continue;
        }
        const reportedMs = Date.parse(payload.reported_at);
        // Exclusive sinceIso (>) per A3 review Q4 — avoids double-processing
        // the boundary record across two consecutive ticks.
        if (Number.isFinite(sinceMs) && reportedMs <= sinceMs) {
          continue;
        }
        records.push({
          delivery_id: payload.delivery_id,
          usage_state: payload.usage_state,
          used_object_ids: [...payload.used_object_ids],
          reason: payload.reason,
          reported_at: payload.reported_at,
          audit_event_id: event.event_id
        } as UsageProofRecord);
      }

      return records;
    },

    findDeliveredObjectIds: async (
      deliveryId: string
    ): Promise<readonly string[] | null> => {
      const delivery = await deps.trustStateRepo.findDeliveryById(deliveryId);
      if (delivery === null) {
        return null;
      }
      return [...delivery.delivered_object_ids];
    }
  };
}

function parseMemoryUsageReportedPayload(
  event: Readonly<EventLogEntry>
): MemoryUsageReportedPayload | null {
  const payload = event.payload_json as unknown;
  if (typeof payload !== "object" || payload === null) {
    return null;
  }
  const candidate = payload as Record<string, unknown>;
  if (
    typeof candidate.delivery_id !== "string" ||
    typeof candidate.usage_state !== "string" ||
    typeof candidate.reported_at !== "string"
  ) {
    return null;
  }
  const usedObjectIds = Array.isArray(candidate.used_object_ids)
    ? candidate.used_object_ids.filter((value): value is string => typeof value === "string")
    : [];
  const reason =
    typeof candidate.reason === "string" || candidate.reason === null
      ? (candidate.reason as string | null)
      : null;
  return {
    delivery_id: candidate.delivery_id,
    usage_state: candidate.usage_state as UsageProofRecord["usage_state"],
    used_object_ids: usedObjectIds,
    reason,
    reported_at: candidate.reported_at
  };
}

export function createPathPlasticityService(deps: {
  readonly eventLogRepo: SqliteEventLogRepo;
  readonly trustStateRepo: SqliteTrustStateRepo;
  readonly pathRelationRepo: SqlitePathRelationRepo;
  readonly eventPublisher: ConstructorParameters<typeof PathPlasticityService>[0]["eventPublisher"];
  readonly now?: () => string;
}): PathPlasticityService {
  const usageProofReader = createUsageProofReader({
    eventLogRepo: deps.eventLogRepo,
    trustStateRepo: deps.trustStateRepo
  });
  const pathRelationRepoPort: PathPlasticityRepoPort = {
    findByAnchor: (workspaceId, anchorRef) =>
      deps.pathRelationRepo.findByAnchor(workspaceId, anchorRef),
    updateSync: (pathId, updates) => deps.pathRelationRepo.updateSync(pathId, updates)
  };
  return new PathPlasticityService({
    usageProofReader,
    pathRelationRepo: pathRelationRepoPort,
    eventPublisher: deps.eventPublisher,
    eventLogRepo: deps.eventLogRepo,
    ...(deps.now === undefined ? {} : { now: deps.now })
  });
}

/**
 * In-process per-workspace high-water mark for the path-plasticity
 * Auditor task. Closes D2 MERGED-B2: the prior daemon enqueued
 * PATH_PLASTICITY_UPDATE without a watermark, so every Auditor tick
 * processed the rolling 24h window and reapplied each receipt 48 times.
 *
 * Contract:
 *   - First tick on a workspace returns `nowIso - initialLookbackMs`
 *     (default 24h) and stores `nowIso` as the new watermark.
 *   - Subsequent ticks return the prior watermark and store `nowIso`.
 *   - Each receipt is therefore picked up by at most one tick within a
 *     single daemon process. (Across daemon restarts the registry resets
 *     and re-uses the 24h lookback, capped at one re-application per
 *     receipt per restart. v0.2 #BL-035 durabilizes via SQL.)
 *
 * Advance happens at enqueue time, not after task completion. A failed
 * task drops its window once; this is fail-safe (under-process rather
 * than over-process) and avoids needing a callback path from the
 * Garden auditor back into the daemon.
 */
export interface PathPlasticityWatermarkRegistry {
  getAndAdvance(workspaceId: string, nowIso: string): string;
}

export function createPathPlasticityWatermarkRegistry(opts?: {
  readonly initialLookbackMs?: number;
}): PathPlasticityWatermarkRegistry {
  const lookbackMs = opts?.initialLookbackMs ?? 24 * 60 * 60 * 1000;
  const watermarks = new Map<string, string>();
  return {
    getAndAdvance(workspaceId: string, nowIso: string): string {
      const prior = watermarks.get(workspaceId);
      const sinceIso =
        prior ?? new Date(Date.parse(nowIso) - lookbackMs).toISOString();
      watermarks.set(workspaceId, nowIso);
      return sinceIso;
    }
  };
}

/**
 * Read-side adapter consumed by RecallService. Returns the strongest
 * PathPlasticityState.strength across all path relations anchored on each
 * memory entry. A memory with no anchored paths contributes no entry to
 * the result map.
 *
 * The lookup is N memory ids × M paths-per-anchor, which is small in
 * v0.1 because memory entries rarely anchor more than a handful of paths.
 */
export function createRecallPathPlasticityPort(deps: {
  readonly pathRelationRepo: Pick<SqlitePathRelationRepo, "findByAnchor">;
}): {
  getStrengthByMemoryId(
    workspaceId: string,
    memoryIds: readonly string[]
  ): Promise<ReadonlyMap<string, number>>;
} {
  return {
    getStrengthByMemoryId: async (
      workspaceId: string,
      memoryIds: readonly string[]
    ): Promise<ReadonlyMap<string, number>> => {
      const result = new Map<string, number>();
      for (const memoryId of memoryIds) {
        const paths = await deps.pathRelationRepo.findByAnchor(workspaceId, {
          kind: "object",
          object_id: memoryId
        });
        if (paths.length === 0) {
          continue;
        }
        let strongest = 0;
        for (const path of paths) {
          if (isRetiredPath(path)) {
            continue;
          }
          if (path.plasticity_state.strength > strongest) {
            strongest = path.plasticity_state.strength;
          }
        }
        if (strongest > 0) {
          result.set(memoryId, strongest);
        }
      }
      return result;
    }
  };
}

function isRetiredPath(path: Readonly<PathRelation>): boolean {
  // The path schema does not encode retirement as a status enum; we rely
  // on PathPlasticityService's invariant that a retired path's strength
  // sits at the floor (0) and last_weakened_at is set. v0.2 may extend
  // PathLifecycle with an explicit status field.
  return (
    path.plasticity_state.strength <= 0 &&
    path.plasticity_state.last_weakened_at !== undefined
  );
}
