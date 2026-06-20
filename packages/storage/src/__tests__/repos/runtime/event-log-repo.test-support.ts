import { afterEach } from "vitest";
import {
  GreenGovernanceEventType,
  MemoryDimension,
  ObligationTrustNarrativeEventType,
  RunMode,
  WorkspaceKind,
  WorkspaceRunEventType,
  type EventLogEntry
} from "@do-soul/alaya-protocol";
import { createEventLogRepos, trackedDatabases } from "./event-log-repo-fixture.js";

export { createEventLogRepos };

export type EventLogRepo = Awaited<ReturnType<typeof createEventLogRepos>>["eventLogRepo"];

export function registerEventLogRepoCleanup(): void {
  afterEach(() => {
    for (const database of trackedDatabases) {
      database.close();
    }

    trackedDatabases.clear();
  });
}

export async function appendRunCreatedEvent(
  eventLogRepo: EventLogRepo,
  input: Readonly<{
    readonly entityId: string;
    readonly runId?: string;
    readonly workspaceId?: string;
    readonly runMode?: RunMode;
    readonly title?: string;
  }>
): Promise<void> {
  const runId = input.runId ?? input.entityId;
  const workspaceId = input.workspaceId ?? "ws_events";
  await eventLogRepo.append({
    event_type: WorkspaceRunEventType.RUN_CREATED,
    entity_type: "run",
    entity_id: input.entityId,
    workspace_id: workspaceId,
    run_id: runId,
    caused_by: "user_action",
    payload_json: {
      run_id: runId,
      workspace_id: workspaceId,
      run_mode: input.runMode ?? RunMode.CHAT,
      title: input.title ?? input.entityId
    }
  });
}

export async function appendRunMessageEvent(
  eventLogRepo: EventLogRepo,
  input: Readonly<{
    readonly entityId: string;
    readonly runId: string;
    readonly messageId: string;
    readonly content: string;
    readonly entityType?: string;
  }>
): Promise<Readonly<EventLogEntry>> {
  return await eventLogRepo.append({
    event_type: WorkspaceRunEventType.RUN_MESSAGE_APPENDED,
    entity_type: input.entityType ?? "run",
    entity_id: input.entityId,
    workspace_id: "ws_events",
    run_id: input.runId,
    caused_by: "user_action",
    payload_json: {
      run_id: input.runId,
      role: "user",
      content: input.content,
      message_id: input.messageId
    }
  });
}

export async function appendEngineResponseEvent(
  eventLogRepo: EventLogRepo,
  input: Readonly<{
    readonly entityId: string;
    readonly runId: string;
    readonly messageId: string;
    readonly content: string;
    readonly entityType?: string;
    readonly causedBy?: string;
  }>
): Promise<Readonly<EventLogEntry>> {
  return await eventLogRepo.append({
    event_type: WorkspaceRunEventType.ENGINE_RESPONSE_RECEIVED,
    entity_type: input.entityType ?? "run",
    entity_id: input.entityId,
    workspace_id: "ws_events",
    run_id: input.runId,
    caused_by: input.causedBy ?? "engine",
    payload_json: {
      run_id: input.runId,
      message_id: input.messageId,
      content: input.content,
      finish_reason: "stop"
    }
  });
}

export async function appendWorkspaceLifecycleEvent(
  eventLogRepo: EventLogRepo,
  input: Readonly<{
    readonly workspaceId: string;
    readonly eventType?: WorkspaceRunEventType;
    readonly entityId?: string;
    readonly workspaceKind?: WorkspaceKind;
    readonly name?: string;
  }>
): Promise<Readonly<EventLogEntry>> {
  const workspaceId = input.workspaceId;
  return await eventLogRepo.append({
    event_type: input.eventType ?? WorkspaceRunEventType.WORKSPACE_CREATED,
    entity_type: "workspace",
    entity_id: input.entityId ?? workspaceId,
    workspace_id: workspaceId,
    run_id: null,
    caused_by: "user_action",
    payload_json: {
      workspace_id: workspaceId,
      name: input.name ?? workspaceId,
      workspace_kind: input.workspaceKind ?? WorkspaceKind.LOCAL_REPO
    }
  });
}

export async function appendNarrativeConsolidationTrigger(
  eventLogRepo: EventLogRepo,
  runId: string,
  digestCountBefore: number
): Promise<void> {
  await eventLogRepo.append({
    event_type: ObligationTrustNarrativeEventType.NARRATIVE_CONSOLIDATION_TRIGGERED,
    entity_type: "run",
    entity_id: runId,
    workspace_id: "ws_events",
    run_id: runId,
    caused_by: "system",
    payload_json: {
      workspace_id: "ws_events",
      run_id: runId,
      trigger_reason: "budget_exceeded",
      digest_count_before: digestCountBefore
    }
  });
}

export async function appendAppliedOverride(
  eventLogRepo: EventLogRepo,
  overrideId: string,
  runId: string
): Promise<void> {
  await eventLogRepo.append({
    event_type: GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED,
    entity_type: "session_override",
    entity_id: overrideId,
    workspace_id: "ws_events",
    run_id: runId,
    caused_by: "user_action",
    payload_json: {
      override_id: overrideId,
      target_object: "memory:build-style",
      correction: "Use pnpm instead of npm.",
      priority: 2,
      run_id: runId,
      expires_at: "2026-03-24T01:00:00.000Z",
      derived_from: null,
      occurred_at: "2026-03-24T00:00:00.000Z"
    }
  });
}

export async function appendMalformedAppliedOverride(
  eventLogRepo: EventLogRepo,
  overrideId: string,
  runId: string
): Promise<void> {
  await eventLogRepo.append({
    event_type: GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED,
    entity_type: "session_override",
    entity_id: overrideId,
    workspace_id: "ws_events",
    run_id: runId,
    caused_by: "user_action",
    payload_json: {
      override_id: overrideId,
      target_object: "memory:build-style",
      correction: 42,
      priority: 2,
      run_id: runId,
      expires_at: "2026-03-24T01:00:00.000Z",
      derived_from: null,
      occurred_at: "2026-03-24T00:00:00.000Z"
    }
  });
}

export async function appendPromotedOverride(
  eventLogRepo: EventLogRepo,
  overrideId: string
): Promise<void> {
  await eventLogRepo.append({
    event_type: GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_PROMOTED,
    entity_type: "session_override",
    entity_id: overrideId,
    workspace_id: "ws_events",
    run_id: "run-3",
    caused_by: "system",
    payload_json: {
      override_id: overrideId,
      target_object: "memory:build-style",
      dimension: MemoryDimension.PREFERENCE,
      promotion_outcome: "durable",
      occurred_at: "2026-03-24T00:20:00.000Z"
    }
  });
}
