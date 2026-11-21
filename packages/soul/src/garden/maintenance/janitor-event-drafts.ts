import {
  GardenRole,
  MemoryGovernanceEventType,
  SoulMemoryStateChangedPayloadSchema,
  SoulMemoryTierChangedPayloadSchema,
  type EventLogEntry,
  type GardenTaskDescriptor
} from "@do-soul/alaya-protocol";
import type { ExpiredControlPlaneObject } from "./janitor.js";

export type EventLogDraft = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

export function buildTtlCleanupEvents(
  task: GardenTaskDescriptor,
  expiredObjects: readonly ExpiredControlPlaneObject[],
  occurredAt: string
): readonly EventLogDraft[] {
  return expiredObjects.map((expired) => ({
    event_type: MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
    entity_type: expired.object_kind,
    entity_id: expired.object_id,
    workspace_id: task.workspace_id,
    run_id: task.run_id,
    caused_by: GardenRole.JANITOR,
    payload_json: SoulMemoryStateChangedPayloadSchema.parse({
      object_id: expired.object_id,
      object_kind: expired.object_kind,
      workspace_id: task.workspace_id,
      run_id: task.run_id,
      from_state: "active",
      to_state: "expired",
      reason_code: "ttl_cleanup",
      caused_by: "system",
      evidence_refs: null,
      occurred_at: occurredAt
    })
  }));
}

export function buildHotIndexDemotionEvents(
  task: GardenTaskDescriptor,
  objectIds: readonly string[],
  occurredAt: string
): readonly EventLogDraft[] {
  return objectIds.map((memoryId) => ({
    event_type: MemoryGovernanceEventType.SOUL_MEMORY_TIER_CHANGED,
    entity_type: "memory_entry",
    entity_id: memoryId,
    workspace_id: task.workspace_id,
    run_id: task.run_id,
    caused_by: GardenRole.JANITOR,
    payload_json: SoulMemoryTierChangedPayloadSchema.parse({
      object_id: memoryId,
      object_kind: "memory_entry",
      workspace_id: task.workspace_id,
      run_id: task.run_id,
      from_tier: "hot",
      to_tier: "cold",
      reason: "hot_index_demotion",
      task_id: task.task_id,
      occurred_at: occurredAt
    })
  }));
}
