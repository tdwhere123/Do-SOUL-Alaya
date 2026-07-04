import { Hono } from "hono";

import { describe, expect, it, vi } from "vitest";

import { CoreError } from "@do-soul/alaya-core";

import {
  RecallContextEventType,
  type EventLogEntry,
  type RecallContextEventTypeValue
} from "@do-soul/alaya-protocol";

import {
  registerRecallUtilizationRoutes,
  type RecallUtilizationRouteServices,
  type SingleUsedAnchorTelemetryEmitter
} from "../../routes/memory/recall-utilization.js";

import type { RecallUtilizationEventLogPort } from "../../services/recall-utilization-service.js";

import { registerErrorHandler } from "../../middleware/error-handler.js";

const WORKSPACE_ID = "ws-1";

const ISO = "2026-05-10T00:00:00.000Z";

function makeRow(input: {
  readonly type: RecallContextEventTypeValue;
  readonly entityId: string;
  readonly runId: string | null;
  readonly payload: Record<string, unknown>;
  readonly createdAt?: string;
  readonly workspaceId?: string;
}): EventLogEntry {
  return {
    event_id: `evt_${input.entityId}_${input.type}_${Math.random().toString(16).slice(2, 8)}`,
    event_type: input.type,
    entity_type: "context_delivery",
    entity_id: input.entityId,
    workspace_id: input.workspaceId ?? WORKSPACE_ID,
    run_id: input.runId,
    caused_by: "claude-code",
    revision: 1,
    payload_json: input.payload,
    created_at: input.createdAt ?? ISO
  };
}

function deliveredPayload(input: {
  readonly deliveryId: string;
  readonly runId: string | null;
  readonly pointerCount: number;
  readonly latencyMs?: number;
  readonly agentTarget?: string;
  readonly sessionId?: string;
  readonly workspaceId?: string;
}): Record<string, unknown> {
  return {
    delivery_id: input.deliveryId,
    session_id: input.sessionId ?? `session-${input.deliveryId}`,
    run_id: input.runId,
    agent_target: input.agentTarget ?? "claude-code",
    query_hash: "abc1234567890abc",
    pointer_count: input.pointerCount,
    latency_ms: input.latencyMs ?? 50,
    workspace_id: input.workspaceId ?? WORKSPACE_ID,
    occurred_at: ISO
  };
}

function usagePayload(input: {
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
    workspace_id: input.workspaceId ?? WORKSPACE_ID,
    occurred_at: input.occurredAt ?? ISO
  };
}

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

function buildApp(services: RecallUtilizationRouteServices): Hono {
  const app = new Hono();
  registerErrorHandler(app, { error: vi.fn() });
  registerRecallUtilizationRoutes(app, services);
  return app;
}

interface RouteResponseShape {
  readonly success: boolean;
  readonly data: {
    readonly window: {
      readonly workspace_id: string;
      readonly since: string | null;
      readonly until: string | null;
    };
    readonly cohorts: ReadonlyArray<{
      readonly workspace_id: string;
      readonly agent_target: string;
      readonly buckets: {
        readonly no_recall: number;
        readonly empty_recall: number;
        readonly delivered_not_reported: number;
        readonly reported_skipped_or_na: number;
        readonly reported_used: number;
      };
      readonly delivery_total: number;
      readonly single_used_anchor_count: number;
    }>;
  };
}

describe("recall-utilization route", () => {

  it("does not emit single_used_anchor when the report is skipped or not_applicable", async () => {
    const emitter: SingleUsedAnchorTelemetryEmitter = { emit: vi.fn().mockResolvedValue(undefined) };
    const rows = [
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d_single",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "d_single", runId: "run-1", pointerCount: 1 })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        entityId: "d_single",
        runId: "run-1",
        payload: usagePayload({
          deliveryId: "d_single",
          runId: "run-1",
          usageState: "skipped"
        })
      })
    ];
    const app = buildApp({
      workspaceService: { getById: vi.fn().mockResolvedValue({ workspace_id: WORKSPACE_ID }) },
      eventLogRepo: fakeEventLogRepo(rows),
      singleUsedAnchorEmitter: emitter
    });
    await app.request(`/workspaces/${WORKSPACE_ID}/recall-utilization`);
    expect(emitter.emit).not.toHaveBeenCalled();
  });

  it("swallows emitter errors so the route response stays 200", async () => {
    const emitter: SingleUsedAnchorTelemetryEmitter = {
      emit: vi.fn().mockRejectedValue(new Error("publish failed"))
    };
    const rows = [
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d_single",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "d_single", runId: "run-1", pointerCount: 1 })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        entityId: "d_single",
        runId: "run-1",
        payload: usagePayload({ deliveryId: "d_single", runId: "run-1", usageState: "used" })
      })
    ];
    const app = buildApp({
      workspaceService: { getById: vi.fn().mockResolvedValue({ workspace_id: WORKSPACE_ID }) },
      eventLogRepo: fakeEventLogRepo(rows),
      singleUsedAnchorEmitter: emitter
    });
    const response = await app.request(`/workspaces/${WORKSPACE_ID}/recall-utilization`);
    expect(response.status).toBe(200);
    expect(emitter.emit).toHaveBeenCalledTimes(1);
  });

  it("counts orphan-report sessions as no_recall", async () => {
    const rows = [
      makeRow({
        type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        entityId: "orphan_a",
        runId: "run-1",
        payload: usagePayload({
          deliveryId: "orphan_a",
          runId: "run-1",
          usageState: "not_applicable",
          sessionId: "sess-A"
        })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        entityId: "orphan_b",
        runId: "run-1",
        payload: usagePayload({
          deliveryId: "orphan_b",
          runId: "run-1",
          usageState: "skipped",
          sessionId: "sess-B"
        })
      })
    ];
    const app = buildApp({
      workspaceService: { getById: vi.fn().mockResolvedValue({ workspace_id: WORKSPACE_ID }) },
      eventLogRepo: fakeEventLogRepo(rows)
    });
    const response = await app.request(`/workspaces/${WORKSPACE_ID}/recall-utilization`);
    const body = (await response.json()) as RouteResponseShape;
    const cohort = body.data.cohorts[0]!;
    expect(cohort.buckets.no_recall).toBe(2);
    expect(cohort.delivery_total).toBe(0);
  });

  it("respects since and until window filters", async () => {
    const rows = [
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d_in",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "d_in", runId: "run-1", pointerCount: 3 }),
        createdAt: "2026-05-10T12:00:00.000Z"
      }),
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d_out",
        runId: "run-2",
        payload: deliveredPayload({ deliveryId: "d_out", runId: "run-2", pointerCount: 7 }),
        createdAt: "2026-04-01T00:00:00.000Z"
      })
    ];
    const app = buildApp({
      workspaceService: { getById: vi.fn().mockResolvedValue({ workspace_id: WORKSPACE_ID }) },
      eventLogRepo: fakeEventLogRepo(rows)
    });
    const response = await app.request(
      `/workspaces/${WORKSPACE_ID}/recall-utilization?since=2026-05-01T00:00:00.000Z&until=2026-05-31T23:59:59.000Z`
    );
    const body = (await response.json()) as RouteResponseShape;
    expect(body.data.cohorts).toHaveLength(1);
    expect(body.data.cohorts[0]?.delivery_total).toBe(1);
    expect(body.data.window.since).toBe("2026-05-01T00:00:00.000Z");
    expect(body.data.window.until).toBe("2026-05-31T23:59:59.000Z");
  });
});
