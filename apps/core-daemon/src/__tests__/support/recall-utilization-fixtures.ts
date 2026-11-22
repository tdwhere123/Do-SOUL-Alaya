import {
  type ComputeRecallGardenEventTypeValue,
  type EventLogEntry,
  type RecallContextEventTypeValue
} from "@do-soul/alaya-protocol";
import type { RecallUtilizationEventLogPort } from "../../services/status/recall-utilization-service.js";

export const RECALL_UTILIZATION_TEST_ISO = "2026-05-10T00:00:00.000Z";

export function makeRecallUtilizationRow(input: {
  readonly type: RecallContextEventTypeValue | ComputeRecallGardenEventTypeValue;
  readonly entityId: string;
  readonly runId: string | null;
  readonly payload: Record<string, unknown>;
  readonly workspaceId?: string;
  readonly causedBy?: string;
  readonly createdAt?: string;
}): EventLogEntry {
  return {
    event_id: `evt_${input.entityId}_${input.type}_${Math.random().toString(16).slice(2, 8)}`,
    event_type: input.type,
    entity_type: "context_delivery",
    entity_id: input.entityId,
    workspace_id: input.workspaceId ?? "ws-1",
    run_id: input.runId,
    caused_by: input.causedBy ?? "claude-code",
    revision: 1,
    payload_json: input.payload,
    created_at: input.createdAt ?? RECALL_UTILIZATION_TEST_ISO
  };
}

export function makeMalformedRecallUtilizationRow(input: {
  readonly type: RecallContextEventTypeValue | ComputeRecallGardenEventTypeValue;
  readonly entityId: string;
  readonly runId: string | null;
  readonly payload: unknown;
  readonly workspaceId?: string;
}): EventLogEntry {
  return {
    event_id: `evt_${input.entityId}_${input.type}_malformed`,
    event_type: input.type,
    entity_type: "context_delivery",
    entity_id: input.entityId,
    workspace_id: input.workspaceId ?? "ws-1",
    run_id: input.runId,
    caused_by: "claude-code",
    revision: 1,
    payload_json: input.payload as EventLogEntry["payload_json"],
    created_at: RECALL_UTILIZATION_TEST_ISO
  };
}

export function deliveredPayload(input: {
  readonly deliveryId: string;
  readonly runId: string | null;
  readonly pointerCount: number;
  readonly latencyMs?: number;
  readonly agentTarget?: string;
  readonly queryHash?: string;
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly occurredAt?: string;
}): Record<string, unknown> {
  return {
    delivery_id: input.deliveryId,
    session_id: input.sessionId ?? `session-${input.deliveryId}`,
    run_id: input.runId,
    agent_target: input.agentTarget ?? "claude-code",
    query_hash: input.queryHash ?? "abc1234567890abc",
    pointer_count: input.pointerCount,
    latency_ms: input.latencyMs ?? 50,
    workspace_id: input.workspaceId ?? "ws-1",
    occurred_at: input.occurredAt ?? RECALL_UTILIZATION_TEST_ISO
  };
}

export function usagePayload(input: {
  readonly deliveryId: string;
  readonly runId: string | null;
  readonly usageState: "used" | "skipped" | "not_applicable";
  readonly agentTarget?: string;
  readonly sessionId?: string;
  readonly workspaceId?: string;
  readonly occurredAt?: string;
}): Record<string, unknown> {
  return {
    delivery_id: input.deliveryId,
    session_id: input.sessionId ?? `session-${input.deliveryId}`,
    run_id: input.runId,
    agent_target: input.agentTarget ?? "claude-code",
    usage_state: input.usageState,
    workspace_id: input.workspaceId ?? "ws-1",
    occurred_at: input.occurredAt ?? RECALL_UTILIZATION_TEST_ISO
  };
}

export function embeddingQueriedPayload(input: {
  readonly queryId: string;
  readonly runId: string | null;
  readonly latencyMs: number;
  readonly returnedCandidateCount: number;
  readonly workspaceId?: string;
}): Record<string, unknown> {
  return {
    workspace_id: input.workspaceId ?? "ws-1",
    run_id: input.runId,
    query_id: input.queryId,
    requested_limit: 5,
    returned_candidate_count: input.returnedCandidateCount,
    latency_ms: input.latencyMs,
    queried_at: RECALL_UTILIZATION_TEST_ISO
  };
}

export function fakeRecallUtilizationEventLogRepo(
  rows: readonly EventLogEntry[],
  options?: { readonly timeField?: "created_at" | "occurred_at" }
): RecallUtilizationEventLogPort {
  const timeField = options?.timeField ?? "occurred_at";
  return {
    async queryByWorkspaceAndType(workspaceId, eventType, sinceIso, untilIso) {
      return rows.filter((row) => {
        if (row.workspace_id !== workspaceId) return false;
        if (row.event_type !== eventType) return false;
        const instant = resolveRowInstant(row, timeField);
        if (sinceIso !== undefined && !(instant > sinceIso)) return false;
        if (untilIso !== undefined && !(instant <= untilIso)) return false;
        return true;
      });
    }
  };
}

function resolveRowInstant(
  row: EventLogEntry,
  timeField: "created_at" | "occurred_at"
): string {
  if (timeField === "created_at") {
    return row.created_at;
  }
  const payload =
    row.payload_json !== null && typeof row.payload_json === "object" && !Array.isArray(row.payload_json)
      ? (row.payload_json as Record<string, unknown>)
      : null;
  if (payload === null) {
    return row.created_at;
  }
  if (typeof payload.reported_at === "string") {
    return payload.reported_at;
  }
  if (typeof payload.occurred_at === "string") {
    return payload.occurred_at;
  }
  return row.created_at;
}
