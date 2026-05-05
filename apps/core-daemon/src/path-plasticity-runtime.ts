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
  PathPlasticityWatermarkRepo,
  SqlitePathRelationRepo,
  SqliteTrustStateRepo
} from "@do-soul/alaya-storage";

interface WorkspaceTypeEventLogReader {
  queryByWorkspaceAndType(
    workspaceId: string,
    eventType: string,
    sinceIso?: string,
    untilIso?: string
  ): Promise<readonly EventLogEntry[]>;
}

/**
 * Daemon-side wiring for the A3 path-axis plasticity feedback loop.
 *
 * Provides four pieces:
 *
 *   1. `createUsageProofReader` — adapts the existing event log + trust
 *      state repository to the `UsageProofReaderPort` contract that
 *      `PathPlasticityService` consumes. We read MEMORY_USAGE_REPORTED
 *      events from the event log (the durable record of every usage
 *      receipt), filter by workspace and the `(sinceIso, untilIso]`
 *      processing window, then materialize them into `UsageProofRecord`
 *      shape using the existing repo for delivery resolution.
 *
 *   2. `createPathPlasticityService` — instantiates the service with the
 *      adapter + the SQLite path relation repo + the existing event
 *      publisher. The service is tier-2-eligible and is dispatched by the
 *      Garden Librarian's `path_plasticity_update` task kind.
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
 *      (codex-B2). The Garden Librarian was enqueueing PATH_PLASTICITY_UPDATE
 *      with empty `target_object_refs`, so every tick fell back to
 *      `now - 24h`. Per-call audit_event_id dedup did NOT survive across
 *      ticks, so a single MEMORY_USAGE_REPORTED receipt inside the rolling
 *      24h window was reapplied every Auditor interval (~48 reapplications
 *      in 24h), saturating strength to ceiling or hammering paths to
 *      retirement from one durable receipt. The registry maintains a
 *      per-workspace high-water mark that resolves before enqueue and only
 *      advances after successful compute, so each tick processes records
 *      strictly in `(prior, nowAtEnqueue]` without skipping failed windows.
 */

interface MemoryUsageReportedPayload {
  readonly delivery_id: string;
  readonly usage_state: UsageProofRecord["usage_state"];
  readonly used_object_ids: readonly string[];
  readonly per_anchor_usage?: NonNullable<UsageProofRecord["per_anchor_usage"]>;
  readonly reason: string | null;
  readonly reported_at: string;
}

export function createUsageProofReader(deps: {
  readonly eventLogRepo: WorkspaceTypeEventLogReader;
  readonly trustStateRepo: Pick<SqliteTrustStateRepo, "findDeliveryById">;
}): UsageProofReaderPort {
  return {
    listRecentUsage: async (
      workspaceId: string,
      sinceIso: string,
      untilIso?: string
    ): Promise<readonly Readonly<UsageProofRecord>[]> => {
      const events = await deps.eventLogRepo.queryByWorkspaceAndType(
        workspaceId,
        TrustStateEventType.MEMORY_USAGE_REPORTED,
        sinceIso,
        untilIso
      );
      const sinceMs = Date.parse(sinceIso);
      const untilMs = untilIso === undefined ? Number.POSITIVE_INFINITY : Date.parse(untilIso);
      const records: UsageProofRecord[] = [];

      for (const event of events) {
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
        if (Number.isFinite(untilMs) && reportedMs > untilMs) {
          continue;
        }
        records.push({
          delivery_id: payload.delivery_id,
          usage_state: payload.usage_state,
          used_object_ids: [...payload.used_object_ids],
          ...(payload.per_anchor_usage === undefined
            ? {}
            : { per_anchor_usage: [...payload.per_anchor_usage] }),
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
  const perAnchorUsage = parsePerAnchorUsage(candidate.per_anchor_usage);
  const reason =
    typeof candidate.reason === "string" || candidate.reason === null
      ? (candidate.reason as string | null)
      : null;
  return {
    delivery_id: candidate.delivery_id,
    usage_state: candidate.usage_state as UsageProofRecord["usage_state"],
    used_object_ids: usedObjectIds,
    ...(perAnchorUsage === undefined ? {} : { per_anchor_usage: perAnchorUsage }),
    reason,
    reported_at: candidate.reported_at
  };
}

function parsePerAnchorUsage(
  value: unknown
): NonNullable<UsageProofRecord["per_anchor_usage"]> | undefined {
  if (value === undefined) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is { readonly object_id: string; readonly anchor_role: "source" | "target" } => {
      if (typeof entry !== "object" || entry === null) {
        return false;
      }
      const candidate = entry as Record<string, unknown>;
      return (
        typeof candidate.object_id === "string" &&
        (candidate.anchor_role === "source" || candidate.anchor_role === "target")
      );
    })
    .map((entry) => ({
      object_id: entry.object_id,
      anchor_role: entry.anchor_role
    }));
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
    update: (pathId, updates) => deps.pathRelationRepo.update(pathId, updates)
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
 * Librarian task. Closes D2 MERGED-B2: the prior daemon enqueued
 * PATH_PLASTICITY_UPDATE without a watermark, so every Librarian tick
 * processed the rolling 24h window and reapplied each receipt 48 times.
 *
 * Contract:
 *   - First tick on a workspace resolves `nowIso - initialLookbackMs`
 *     (default 24h) without advancing durable state.
 *   - The daemon marks `processedThroughIso` only after the Garden task
 *     succeeds. Failed or timed-out tasks therefore replay the same window
 *     after daemon restart instead of skipping usage rows.
 */
export interface PathPlasticityWatermarkRegistry {
  getSince(workspaceId: string, nowIso: string): string;
  markProcessed(
    workspaceId: string,
    processedThroughIso: string,
    processedAuditEventId?: string | null,
    updatedAtIso?: string
  ): void;
}

export function createPathPlasticityWatermarkRegistry(opts?: {
  readonly initialLookbackMs?: number;
  readonly watermarkRepo?: PathPlasticityWatermarkRepo;
}): PathPlasticityWatermarkRegistry {
  const lookbackMs = opts?.initialLookbackMs ?? 24 * 60 * 60 * 1000;
  const watermarks = new Map<string, string>();
  return {
    getSince(workspaceId: string, nowIso: string): string {
      const prior =
        opts?.watermarkRepo?.findByWorkspaceId(workspaceId)?.last_processed_reported_at ??
        watermarks.get(workspaceId);
      return prior ?? new Date(Date.parse(nowIso) - lookbackMs).toISOString();
    },
    markProcessed(
      workspaceId: string,
      processedThroughIso: string,
      processedAuditEventId: string | null = null,
      updatedAtIso: string = new Date().toISOString()
    ): void {
      const record = {
        workspace_id: workspaceId,
        last_processed_reported_at: processedThroughIso,
        last_processed_audit_event_id: processedAuditEventId,
        updated_at: updatedAtIso
      };
      opts?.watermarkRepo?.upsert(record);
      watermarks.set(workspaceId, processedThroughIso);
    }
  };
}

export interface PathPlasticityLookupTelemetrySnapshot {
  readonly lookup_count: number;
  readonly sample_count: number;
  readonly duration_p99_ms: number | null;
  readonly window_size: number;
}

export interface PathPlasticityLookupTelemetry {
  observe(durationMs: number): void;
  snapshot(): PathPlasticityLookupTelemetrySnapshot;
  reset(): void;
}

export function createPathPlasticityLookupTelemetry(options?: {
  readonly windowSize?: number;
}): PathPlasticityLookupTelemetry {
  const windowSize = options?.windowSize ?? 128;
  let lookupCount = 0;
  const durations: number[] = [];

  return {
    observe(durationMs: number): void {
      lookupCount += 1;
      durations.push(Math.max(0, durationMs));
      if (durations.length > windowSize) {
        durations.splice(0, durations.length - windowSize);
      }
    },
    snapshot(): PathPlasticityLookupTelemetrySnapshot {
      if (durations.length === 0) {
        return Object.freeze({
          lookup_count: lookupCount,
          sample_count: 0,
          duration_p99_ms: null,
          window_size: windowSize
        });
      }

      const sorted = [...durations].sort((left, right) => left - right);
      const index = Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1);
      return Object.freeze({
        lookup_count: lookupCount,
        sample_count: durations.length,
        duration_p99_ms: sorted[index],
        window_size: windowSize
      });
    },
    reset(): void {
      lookupCount = 0;
      durations.splice(0, durations.length);
    }
  };
}

export const defaultRecallPathPlasticityLookupTelemetry =
  createPathPlasticityLookupTelemetry();

/**
 * Read-side adapter consumed by RecallService. Returns the strongest
 * direction-eligible PathPlasticityState.strength across all path relations
 * anchored on each memory entry. A memory with no eligible anchored paths
 * contributes no entry to the result map.
 *
 * The lookup is one batched repo call per recall request.
 */
export function createRecallPathPlasticityPort(deps: {
  readonly pathRelationRepo: Pick<SqlitePathRelationRepo, "findByAnchors">;
  readonly telemetry?: PathPlasticityLookupTelemetry;
  readonly nowMs?: () => number;
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
      const uniqueMemoryIds = [...new Set(memoryIds)];
      if (uniqueMemoryIds.length === 0) {
        return result;
      }

      const requestedMemoryIds = new Set(uniqueMemoryIds);
      const nowMs = deps.nowMs ?? (() => Date.now());
      const telemetry = deps.telemetry ?? defaultRecallPathPlasticityLookupTelemetry;
      const startedAtMs = nowMs();
      let paths: readonly Readonly<PathRelation>[];
      try {
        paths = await deps.pathRelationRepo.findByAnchors(
          workspaceId,
          uniqueMemoryIds.map((memoryId) => ({
            kind: "object",
            object_id: memoryId
          }))
        );
      } finally {
        telemetry.observe(nowMs() - startedAtMs);
      }

      for (const path of paths) {
        if (isRetiredPath(path)) {
          continue;
        }
        for (const memoryId of getDirectionEligibleObjectAnchorMemoryIds(path, requestedMemoryIds)) {
          const strongest = result.get(memoryId) ?? 0;
          if (path.plasticity_state.strength > strongest) {
            result.set(memoryId, path.plasticity_state.strength);
          }
        }
      }
      return result;
    }
  };
}

function isRetiredPath(path: Readonly<PathRelation>): boolean {
  return (path.lifecycle as PathLifecycleWithStatus).status === "retired";
}

function getDirectionEligibleObjectAnchorMemoryIds(
  path: Readonly<PathRelation>,
  requestedMemoryIds: ReadonlySet<string>
): readonly string[] {
  const memoryIds = new Set<string>();
  const sourceAnchor = path.anchors.source_anchor;
  const targetAnchor = path.anchors.target_anchor;
  if (
    (path.plasticity_state.direction_bias === "target_to_source" ||
      path.plasticity_state.direction_bias === "bidirectional_asymmetric") &&
    sourceAnchor.kind === "object" &&
    requestedMemoryIds.has(sourceAnchor.object_id)
  ) {
    memoryIds.add(sourceAnchor.object_id);
  }
  if (
    (path.plasticity_state.direction_bias === "source_to_target" ||
      path.plasticity_state.direction_bias === "bidirectional_asymmetric") &&
    targetAnchor.kind === "object" &&
    requestedMemoryIds.has(targetAnchor.object_id)
  ) {
    memoryIds.add(targetAnchor.object_id);
  }
  return [...memoryIds];
}

type PathLifecycleWithStatus = PathRelation["lifecycle"] & {
  readonly status?: "active" | "retired";
};
