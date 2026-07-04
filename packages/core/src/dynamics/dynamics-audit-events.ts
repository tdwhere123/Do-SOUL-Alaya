import {
  MemoryGovernanceEventType,
  SoulMemoryManifestationChangedPayloadSchema,
  SoulMemoryRetentionUpdatedPayloadSchema,
  SoulMemoryStateChangedPayloadSchema,
  TransitionCausedBy,
  type EventLogEntry,
  type ManifestationState,
  type MemoryEntry,
  type RetentionState
} from "@do-soul/alaya-protocol";

import type {
  DynamicsEventLogInput,
  DynamicsServiceEventLogRepoPort,
  DynamicsServiceRuntimeNotifier
} from "./dynamics-service-ports.js";

export interface RetentionUpdatedAudit {
  readonly memory: Readonly<MemoryEntry>;
  readonly fromRetention: number;
  readonly toRetention: number;
  readonly reasonCode: string;
  readonly occurredAt: string;
}

export interface StateChangedAudit {
  readonly memory: Readonly<MemoryEntry>;
  readonly fromState: RetentionState | "dormant";
  readonly toState: RetentionState | "active";
  readonly reasonCode: string;
  readonly occurredAt: string;
}

export interface ManifestationChangedAudit {
  readonly memory: Readonly<MemoryEntry>;
  readonly fromState: ManifestationState;
  readonly toState: ManifestationState;
  readonly reasonCode: string;
  readonly occurredAt: string;
}

export function buildRetentionUpdatedEventInput(audit: RetentionUpdatedAudit): DynamicsEventLogInput {
  return {
    event_type: MemoryGovernanceEventType.SOUL_MEMORY_RETENTION_UPDATED,
    entity_type: "memory_entry",
    entity_id: audit.memory.object_id,
    workspace_id: audit.memory.workspace_id,
    run_id: audit.memory.run_id,
    caused_by: TransitionCausedBy.SYSTEM,
    payload_json: SoulMemoryRetentionUpdatedPayloadSchema.parse({
      object_id: audit.memory.object_id,
      object_kind: audit.memory.object_kind,
      workspace_id: audit.memory.workspace_id,
      run_id: audit.memory.run_id,
      from_state: String(audit.fromRetention),
      to_state: String(audit.toRetention),
      reason_code: audit.reasonCode,
      caused_by: TransitionCausedBy.SYSTEM,
      evidence_refs: null,
      occurred_at: audit.occurredAt,
      retention_score: audit.toRetention
    })
  };
}

export function buildStateChangedEventInput(audit: StateChangedAudit): DynamicsEventLogInput {
  return {
    event_type: MemoryGovernanceEventType.SOUL_MEMORY_STATE_CHANGED,
    entity_type: "memory_entry",
    entity_id: audit.memory.object_id,
    workspace_id: audit.memory.workspace_id,
    run_id: audit.memory.run_id,
    caused_by: TransitionCausedBy.SYSTEM,
    payload_json: SoulMemoryStateChangedPayloadSchema.parse({
      object_id: audit.memory.object_id,
      object_kind: audit.memory.object_kind,
      workspace_id: audit.memory.workspace_id,
      run_id: audit.memory.run_id,
      from_state: audit.fromState,
      to_state: audit.toState,
      reason_code: audit.reasonCode,
      caused_by: TransitionCausedBy.SYSTEM,
      evidence_refs: null,
      occurred_at: audit.occurredAt
    })
  };
}

export function buildManifestationChangedEventInput(audit: ManifestationChangedAudit): DynamicsEventLogInput {
  return {
    event_type: MemoryGovernanceEventType.SOUL_MEMORY_MANIFESTATION_CHANGED,
    entity_type: "memory_entry",
    entity_id: audit.memory.object_id,
    workspace_id: audit.memory.workspace_id,
    run_id: audit.memory.run_id,
    caused_by: TransitionCausedBy.SYSTEM,
    payload_json: SoulMemoryManifestationChangedPayloadSchema.parse({
      object_id: audit.memory.object_id,
      object_kind: audit.memory.object_kind,
      workspace_id: audit.memory.workspace_id,
      run_id: audit.memory.run_id,
      from_state: audit.fromState,
      to_state: audit.toState,
      reason_code: audit.reasonCode,
      caused_by: TransitionCausedBy.SYSTEM,
      evidence_refs: null,
      occurred_at: audit.occurredAt
    })
  };
}

export async function appendRetentionUpdatedEvent(
  eventLogRepo: DynamicsServiceEventLogRepoPort,
  audit: RetentionUpdatedAudit
): Promise<EventLogEntry> {
  return await eventLogRepo.append(buildRetentionUpdatedEventInput(audit));
}

export async function appendStateChangedEvent(
  eventLogRepo: DynamicsServiceEventLogRepoPort,
  audit: StateChangedAudit
): Promise<EventLogEntry> {
  return await eventLogRepo.append(buildStateChangedEventInput(audit));
}

export async function appendManifestationChangedEvent(
  eventLogRepo: DynamicsServiceEventLogRepoPort,
  audit: ManifestationChangedAudit
): Promise<EventLogEntry> {
  return await eventLogRepo.append(buildManifestationChangedEventInput(audit));
}

export async function broadcastEvents(
  runtimeNotifier: DynamicsServiceRuntimeNotifier,
  events: readonly EventLogEntry[]
): Promise<void> {
  for (const event of events) {
    await runtimeNotifier.notifyEntry(event);
  }
}
