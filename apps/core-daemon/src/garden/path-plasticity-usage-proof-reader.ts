import {
  TrustStateEventType,
  type EventLogEntry,
  type SoulContextObjectIdentity,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import type { UsageProofReaderPort } from "@do-soul/alaya-core";
import type { SqliteTrustStateRepo } from "@do-soul/alaya-storage";

interface WorkspaceTypeEventLogReader {
  queryByWorkspaceAndType(
    workspaceId: string,
    eventType: string,
    sinceIso?: string,
    untilIso?: string
  ): Promise<readonly EventLogEntry[]>;
}

interface MemoryUsageReportedPayload {
  readonly delivery_id: string;
  readonly usage_state: UsageProofRecord["usage_state"];
  readonly trust_mode?: NonNullable<UsageProofRecord["trust_mode"]>;
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
      return filterUsageRecordsWithinWindow(events, sinceIso, untilIso);
    },
    findDeliveredObjectIds: async (deliveryId: string): Promise<readonly string[] | null> => {
      const delivery = await deps.trustStateRepo.findDeliveryById(deliveryId);
      return delivery === null ? null : [...delivery.delivered_object_ids];
    },
    findDeliveredObjects: async (
      deliveryId: string
    ): Promise<readonly SoulContextObjectIdentity[] | null> => {
      const delivery = await deps.trustStateRepo.findDeliveryById(deliveryId);
      if (delivery === null || delivery.delivered_objects === undefined) {
        return null;
      }
      return [...delivery.delivered_objects];
    }
  };
}

function filterUsageRecordsWithinWindow(
  events: readonly Readonly<EventLogEntry>[],
  sinceIso: string,
  untilIso?: string
): readonly UsageProofRecord[] {
  const sinceMs = Date.parse(sinceIso);
  const untilMs = untilIso === undefined ? Number.POSITIVE_INFINITY : Date.parse(untilIso);
  const records: UsageProofRecord[] = [];

  for (const event of events) {
    const record = toUsageProofRecord(event, sinceMs, untilMs);
    if (record !== null) {
      records.push(record);
    }
  }

  return records;
}

function toUsageProofRecord(
  event: Readonly<EventLogEntry>,
  sinceMs: number,
  untilMs: number
): UsageProofRecord | null {
  const payload = parseMemoryUsageReportedPayload(event);
  if (payload === null) {
    return null;
  }
  const reportedMs = Date.parse(payload.reported_at);
  if (Number.isFinite(sinceMs) && reportedMs <= sinceMs) {
    return null;
  }
  if (Number.isFinite(untilMs) && reportedMs > untilMs) {
    return null;
  }
  return {
    delivery_id: payload.delivery_id,
    usage_state: payload.usage_state,
    ...(payload.trust_mode === undefined ? {} : { trust_mode: payload.trust_mode }),
    used_object_ids: [...payload.used_object_ids],
    ...(payload.per_anchor_usage === undefined
      ? {}
      : { per_anchor_usage: [...payload.per_anchor_usage] }),
    reason: payload.reason,
    reported_at: payload.reported_at,
    audit_event_id: event.event_id
  } as UsageProofRecord;
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
  const perAnchorUsage = parsePerAnchorUsage(candidate.per_anchor_usage);
  const trustMode =
    candidate.trust_mode === "automatic" || candidate.trust_mode === "manual"
      ? candidate.trust_mode
      : undefined;
  return {
    delivery_id: candidate.delivery_id,
    usage_state: candidate.usage_state as UsageProofRecord["usage_state"],
    ...(trustMode === undefined ? {} : { trust_mode: trustMode }),
    used_object_ids: parseUsedObjectIds(candidate.used_object_ids),
    ...(perAnchorUsage === undefined ? {} : { per_anchor_usage: perAnchorUsage }),
    reason:
      typeof candidate.reason === "string" || candidate.reason === null
        ? (candidate.reason as string | null)
        : null,
    reported_at: candidate.reported_at
  };
}

function parseUsedObjectIds(value: unknown): readonly string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
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
    .filter((entry): entry is {
      readonly object_id: string;
      readonly object_kind?: string;
      readonly anchor_role: "source" | "target";
    } => {
      if (typeof entry !== "object" || entry === null) {
        return false;
      }
      const candidate = entry as Record<string, unknown>;
      return (
        typeof candidate.object_id === "string" &&
        (candidate.object_kind === undefined || typeof candidate.object_kind === "string") &&
        (candidate.anchor_role === "source" || candidate.anchor_role === "target")
      );
    })
    .map((entry) => ({
      object_id: entry.object_id,
      ...(entry.object_kind === undefined ? {} : { object_kind: entry.object_kind }),
      anchor_role: entry.anchor_role
    }));
}
