import { describe, expect, it } from "vitest";

import {
  ComputeRecallGardenEventType,
  type ComputeRecallGardenEventTypeValue,
  RecallContextEventType,
  type EventLogEntry,
  type RecallContextEventTypeValue
} from "@do-soul/alaya-protocol";

import {
  createRecallUtilizationService,
  type RecallUtilizationEventLogPort
} from "../../services/recall-utilization-service.js";

const WORKSPACE_ID = "workspace-1";

const ISO = "2026-05-10T00:00:00.000Z";

function makeRow(input: {
  readonly type: RecallContextEventTypeValue | ComputeRecallGardenEventTypeValue;
  readonly entityId: string;
  readonly runId: string | null;
  readonly payload: Record<string, unknown>;
  readonly causedBy?: string;
  readonly createdAt?: string;
}): EventLogEntry {
  return {
    event_id: `evt_${input.entityId}_${input.type}_${Math.random().toString(16).slice(2, 8)}`,
    event_type: input.type,
    entity_type: "context_delivery",
    entity_id: input.entityId,
    workspace_id: WORKSPACE_ID,
    run_id: input.runId,
    caused_by: input.causedBy ?? "claude-code",
    revision: 1,
    payload_json: input.payload,
    created_at: input.createdAt ?? ISO
  };
}

function embeddingQueriedPayload(input: {
  readonly queryId: string;
  readonly runId: string | null;
  readonly latencyMs: number;
  readonly returnedCandidateCount: number;
}): Record<string, unknown> {
  return {
    workspace_id: WORKSPACE_ID,
    run_id: input.runId,
    query_id: input.queryId,
    requested_limit: 5,
    returned_candidate_count: input.returnedCandidateCount,
    latency_ms: input.latencyMs,
    queried_at: ISO
  };
}

function deliveredPayload(input: {
  readonly deliveryId: string;
  readonly runId: string | null;
  readonly pointerCount: number;
  readonly latencyMs: number;
  readonly agentTarget?: string;
  readonly queryHash?: string;
  readonly sessionId?: string;
}): Record<string, unknown> {
  return {
    delivery_id: input.deliveryId,
    session_id: input.sessionId ?? `session-${input.deliveryId}`,
    run_id: input.runId,
    agent_target: input.agentTarget ?? "claude-code",
    query_hash: input.queryHash ?? "abc1234567890abc",
    pointer_count: input.pointerCount,
    latency_ms: input.latencyMs,
    workspace_id: WORKSPACE_ID,
    occurred_at: ISO
  };
}

function usagePayload(input: {
  readonly deliveryId: string;
  readonly runId: string | null;
  readonly usageState: "used" | "skipped" | "not_applicable";
  readonly agentTarget?: string;
  readonly sessionId?: string;
}): Record<string, unknown> {
  return {
    delivery_id: input.deliveryId,
    session_id: input.sessionId ?? `session-${input.deliveryId}`,
    run_id: input.runId,
    agent_target: input.agentTarget ?? "claude-code",
    usage_state: input.usageState,
    workspace_id: WORKSPACE_ID,
    occurred_at: ISO
  };
}

// Mirrors the production SQL semantics in
// `packages/storage/src/repos/runtime/event-log-repo.ts` queryByWorkspaceAndTypeStatement:
//   COALESCE(payload_json.reported_at, created_at) > since      (strict)
//   COALESCE(payload_json.reported_at, created_at) <= until     (inclusive)
// The new recall-context payloads carry occurred_at, not reported_at, so
// the SQL falls back to created_at — same as this fake.
function fakeEventLogRepo(rows: readonly EventLogEntry[]): RecallUtilizationEventLogPort {
  return {
    async queryByWorkspaceAndType(workspaceId, eventType, sinceIso, untilIso) {
      return rows.filter((row) => {
        if (row.workspace_id !== workspaceId) return false;
        if (row.event_type !== eventType) return false;
        if (sinceIso !== undefined && !(row.created_at > sinceIso)) return false;
        if (untilIso !== undefined && !(row.created_at <= untilIso)) return false;
        return true;
      });
    }
  };
}

describe("recall-utilization-service", () => {

  it("counts unique_sessions independently from unique_runs", async () => {
    const rows = [
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_a",
        runId: null,
        payload: deliveredPayload({
          deliveryId: "delivery_a",
          runId: null,
          pointerCount: 1,
          latencyMs: 10,
          sessionId: "mcp-session-A"
        })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_b",
        runId: null,
        payload: deliveredPayload({
          deliveryId: "delivery_b",
          runId: null,
          pointerCount: 2,
          latencyMs: 20,
          sessionId: "mcp-session-A"
        })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_c",
        runId: null,
        payload: deliveredPayload({
          deliveryId: "delivery_c",
          runId: null,
          pointerCount: 3,
          latencyMs: 30,
          sessionId: "mcp-session-B"
        })
      })
    ];
    const stats = await createRecallUtilizationService({
      eventLogRepo: fakeEventLogRepo(rows)
    }).getStats({ workspaceId: WORKSPACE_ID });

    expect(stats.recall.total).toBe(3);
    expect(stats.recall.unique_runs).toBe(0);
    expect(stats.recall.null_run).toBe(3);
    expect(stats.recall.unique_sessions).toBe(2);
  });

  it("respects strict-greater-than since and inclusive until at the boundary", async () => {
    const SINCE = "2026-05-10T00:00:00.000Z";
    const UNTIL = "2026-05-10T23:59:59.000Z";
    const rows = [
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_at_since",
        runId: "run-since",
        payload: deliveredPayload({ deliveryId: "delivery_at_since", runId: "run-since", pointerCount: 1, latencyMs: 10 }),
        createdAt: SINCE
      }),
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_at_until",
        runId: "run-until",
        payload: deliveredPayload({ deliveryId: "delivery_at_until", runId: "run-until", pointerCount: 2, latencyMs: 20 }),
        createdAt: UNTIL
      })
    ];
    const stats = await createRecallUtilizationService({
      eventLogRepo: fakeEventLogRepo(rows)
    }).getStats({ workspaceId: WORKSPACE_ID, since: SINCE, until: UNTIL });

    expect(stats.recall.total).toBe(1);
    expect(stats.recall.p50_pointer_count).toBe(2);
  });

  it("excludes inspector, cli, and tools-cli agent targets by default", async () => {
    const rows = [
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_agent",
        runId: "run-1",
        payload: deliveredPayload({
          deliveryId: "delivery_agent",
          runId: "run-1",
          pointerCount: 5,
          latencyMs: 100,
          agentTarget: "claude-code"
        })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_inspector",
        runId: null,
        payload: deliveredPayload({
          deliveryId: "delivery_inspector",
          runId: null,
          pointerCount: 99,
          latencyMs: 999,
          agentTarget: "inspector"
        })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_cli",
        runId: "run-2",
        payload: deliveredPayload({
          deliveryId: "delivery_cli",
          runId: "run-2",
          pointerCount: 7,
          latencyMs: 50,
          agentTarget: "cli"
        })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_tools_cli",
        runId: "run-3",
        payload: deliveredPayload({
          deliveryId: "delivery_tools_cli",
          runId: "run-3",
          pointerCount: 11,
          latencyMs: 200,
          agentTarget: "tools-cli"
        })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        entityId: "delivery_inspector",
        runId: null,
        payload: usagePayload({
          deliveryId: "delivery_inspector",
          runId: null,
          usageState: "skipped",
          agentTarget: "inspector"
        })
      })
    ];
    const stats = await createRecallUtilizationService({
      eventLogRepo: fakeEventLogRepo(rows)
    }).getStats({ workspaceId: WORKSPACE_ID });

    expect(stats.recall.total).toBe(1);
    expect(stats.recall.p50_pointer_count).toBe(5);
    expect(stats.recall.p50_latency_ms).toBe(100);
    expect(stats.usage.total).toBe(0);
    expect(stats.window.excluded_agent_targets).toEqual(["cli", "inspector", "tools-cli"]);
  });

  it("respects an explicit excludeAgentTargets override", async () => {
    const rows = [
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_inspector",
        runId: null,
        payload: deliveredPayload({
          deliveryId: "delivery_inspector",
          runId: null,
          pointerCount: 2,
          latencyMs: 30,
          agentTarget: "inspector"
        })
      })
    ];
    const stats = await createRecallUtilizationService({
      eventLogRepo: fakeEventLogRepo(rows)
    }).getStats({ workspaceId: WORKSPACE_ID, excludeAgentTargets: [] });

    expect(stats.recall.total).toBe(1);
    expect(stats.window.excluded_agent_targets).toEqual([]);
  });

  it("isolates stats per workspace", async () => {
    const rows = [
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_1",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "delivery_1", runId: "run-1", pointerCount: 3, latencyMs: 100 })
      }),
      {
        ...makeRow({
          type: RecallContextEventType.SOUL_RECALL_DELIVERED,
          entityId: "delivery_other",
          runId: "run-9",
          payload: deliveredPayload({
            deliveryId: "delivery_other",
            runId: "run-9",
            pointerCount: 99,
            latencyMs: 999
          })
        }),
        workspace_id: "workspace-other"
      }
    ];
    const stats = await createRecallUtilizationService({
      eventLogRepo: fakeEventLogRepo(rows)
    }).getStats({ workspaceId: WORKSPACE_ID });

    expect(stats.recall.total).toBe(1);
    expect(stats.recall.p50_latency_ms).toBe(100);
  });
});
