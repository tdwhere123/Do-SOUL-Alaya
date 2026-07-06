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

function makeMalformedRow(input: {
  readonly type: RecallContextEventTypeValue;
  readonly entityId: string;
  readonly runId: string | null;
  readonly payload: unknown;
}): EventLogEntry {
  return {
    event_id: `evt_${input.entityId}_${input.type}_malformed`,
    event_type: input.type,
    entity_type: "context_delivery",
    entity_id: input.entityId,
    workspace_id: WORKSPACE_ID,
    run_id: input.runId,
    caused_by: "claude-code",
    revision: 1,
    payload_json: input.payload as EventLogEntry["payload_json"],
    created_at: ISO
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

  it("returns empty cohorts when EventLog is empty", async () => {
    const app = buildApp({
      workspaceService: { getById: vi.fn().mockResolvedValue({ workspace_id: WORKSPACE_ID }) },
      eventLogRepo: fakeEventLogRepo([])
    });
    const response = await app.request(`/workspaces/${WORKSPACE_ID}/recall-utilization`);
    expect(response.status).toBe(200);
    const body = (await response.json()) as RouteResponseShape;
    expect(body.success).toBe(true);
    expect(body.data.cohorts).toEqual([]);
    expect(body.data.window).toEqual({
      workspace_id: WORKSPACE_ID,
      since: null,
      until: null
    });
  });

  it("returns 404 when the workspace is not found", async () => {
    const app = buildApp({
      workspaceService: {
        getById: vi.fn().mockRejectedValue(new CoreError("NOT_FOUND", "ws missing"))
      },
      eventLogRepo: fakeEventLogRepo([])
    });
    const response = await app.request(`/workspaces/ws-missing/recall-utilization`);
    expect(response.status).toBe(404);
  });

  it.each([
    {
      type: RecallContextEventType.SOUL_RECALL_DELIVERED,
      entityId: "bad-delivered-null",
      payload: null
    },
    {
      type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
      entityId: "bad-usage-string",
      payload: "corrupt"
    },
    {
      type: RecallContextEventType.SOUL_RECALL_DELIVERED,
      entityId: "bad-delivered-array",
      payload: []
    }
  ])("returns a typed validation response for malformed $type payload_json", async ({ type, entityId, payload }) => {
    const app = buildApp({
      workspaceService: { getById: vi.fn().mockResolvedValue({ workspace_id: WORKSPACE_ID }) },
      eventLogRepo: fakeEventLogRepo([
        makeMalformedRow({
          type,
          entityId,
          runId: "run-1",
          payload
        })
      ])
    });

    const response = await app.request(`/workspaces/${WORKSPACE_ID}/recall-utilization`);
    const body = (await response.json()) as { readonly success: boolean; readonly error: string };

    expect(response.status).toBe(400);
    expect(body).toEqual({
      success: false,
      error: `Invalid recall utilization EventLog payload for ${type}`
    });
  });

  it("partitions deliveries across delivered_not_reported / skipped_or_na / used", async () => {
    const rows = [
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d1",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "d1", runId: "run-1", pointerCount: 4 })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d2",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "d2", runId: "run-1", pointerCount: 2 })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d3",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "d3", runId: "run-1", pointerCount: 6 })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        entityId: "d1",
        runId: "run-1",
        payload: usagePayload({ deliveryId: "d1", runId: "run-1", usageState: "used" })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        entityId: "d2",
        runId: "run-1",
        payload: usagePayload({ deliveryId: "d2", runId: "run-1", usageState: "skipped" })
      })
    ];
    const app = buildApp({
      workspaceService: { getById: vi.fn().mockResolvedValue({ workspace_id: WORKSPACE_ID }) },
      eventLogRepo: fakeEventLogRepo(rows)
    });
    const response = await app.request(`/workspaces/${WORKSPACE_ID}/recall-utilization`);
    const body = (await response.json()) as RouteResponseShape;

    expect(body.data.cohorts).toHaveLength(1);
    const cohort = body.data.cohorts[0]!;
    expect(cohort.workspace_id).toBe(WORKSPACE_ID);
    expect(cohort.agent_target).toBe("claude-code");
    expect(cohort.delivery_total).toBe(3);
    expect(cohort.buckets).toEqual({
      no_recall: 0,
      empty_recall: 0,
      delivered_not_reported: 1,
      reported_skipped_or_na: 1,
      reported_used: 1
    });
    // stop condition: 3-of-5 buckets sum to deliveries
    expect(
      cohort.buckets.delivered_not_reported +
        cohort.buckets.reported_skipped_or_na +
        cohort.buckets.reported_used
    ).toBe(cohort.delivery_total);
  });

  it("counts empty_recall as a carve-out of delivered_not_reported when pointer_count is 0", async () => {
    const rows = [
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d_empty",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "d_empty", runId: "run-1", pointerCount: 0 })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d_nonempty",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "d_nonempty", runId: "run-1", pointerCount: 5 })
      })
    ];
    const app = buildApp({
      workspaceService: { getById: vi.fn().mockResolvedValue({ workspace_id: WORKSPACE_ID }) },
      eventLogRepo: fakeEventLogRepo(rows)
    });
    const response = await app.request(`/workspaces/${WORKSPACE_ID}/recall-utilization`);
    const body = (await response.json()) as RouteResponseShape;
    const cohort = body.data.cohorts[0]!;
    expect(cohort.buckets.empty_recall).toBe(1);
    expect(cohort.buckets.delivered_not_reported).toBe(2);
  });

  it("groups cohorts by (workspace_id, agent_target)", async () => {
    const rows = [
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d1",
        runId: "run-1",
        payload: deliveredPayload({
          deliveryId: "d1",
          runId: "run-1",
          pointerCount: 2,
          agentTarget: "claude-code"
        })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d2",
        runId: "run-2",
        payload: deliveredPayload({
          deliveryId: "d2",
          runId: "run-2",
          pointerCount: 4,
          agentTarget: "codex"
        })
      })
    ];
    const app = buildApp({
      workspaceService: { getById: vi.fn().mockResolvedValue({ workspace_id: WORKSPACE_ID }) },
      eventLogRepo: fakeEventLogRepo(rows)
    });
    const response = await app.request(`/workspaces/${WORKSPACE_ID}/recall-utilization`);
    const body = (await response.json()) as RouteResponseShape;
    expect(body.data.cohorts).toHaveLength(2);
    const targets = body.data.cohorts.map((row) => row.agent_target);
    expect(targets).toEqual(["claude-code", "codex"]);
  });

  it("isolates cohorts per workspace via the query workspace filter", async () => {
    const rows = [
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d1",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "d1", runId: "run-1", pointerCount: 3 })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d_other",
        runId: "run-9",
        payload: deliveredPayload({
          deliveryId: "d_other",
          runId: "run-9",
          pointerCount: 5,
          workspaceId: "ws-other"
        }),
        workspaceId: "ws-other"
      })
    ];
    const app = buildApp({
      workspaceService: { getById: vi.fn().mockResolvedValue({ workspace_id: WORKSPACE_ID }) },
      eventLogRepo: fakeEventLogRepo(rows)
    });
    const response = await app.request(`/workspaces/${WORKSPACE_ID}/recall-utilization`);
    const body = (await response.json()) as RouteResponseShape;
    expect(body.data.cohorts).toHaveLength(1);
    expect(body.data.cohorts[0]?.delivery_total).toBe(1);
  });

  it("emits single_used_anchor telemetry when pointer_count is 1 and the report is used", async () => {
    const emitted: Array<{
      readonly workspaceId: string;
      readonly runId: string | null;
      readonly agentTarget: string;
      readonly sessionId: string;
      readonly deliveryId: string;
      readonly occurredAt: string;
    }> = [];
    const emitter: SingleUsedAnchorTelemetryEmitter = {
      async emit(input) {
        emitted.push(input);
      }
    };
    const rows = [
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d_single",
        runId: "run-1",
        payload: deliveredPayload({
          deliveryId: "d_single",
          runId: "run-1",
          pointerCount: 1,
          sessionId: "sess-1"
        })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d_multi",
        runId: "run-1",
        payload: deliveredPayload({
          deliveryId: "d_multi",
          runId: "run-1",
          pointerCount: 4,
          sessionId: "sess-2"
        })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        entityId: "d_single",
        runId: "run-1",
        payload: usagePayload({
          deliveryId: "d_single",
          runId: "run-1",
          usageState: "used",
          sessionId: "sess-1"
        })
      }),
      makeRow({
        type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        entityId: "d_multi",
        runId: "run-1",
        payload: usagePayload({
          deliveryId: "d_multi",
          runId: "run-1",
          usageState: "used",
          sessionId: "sess-2"
        })
      })
    ];
    const app = buildApp({
      workspaceService: { getById: vi.fn().mockResolvedValue({ workspace_id: WORKSPACE_ID }) },
      eventLogRepo: fakeEventLogRepo(rows),
      singleUsedAnchorEmitter: emitter
    });
    const response = await app.request(`/workspaces/${WORKSPACE_ID}/recall-utilization`);
    const body = (await response.json()) as RouteResponseShape;

    expect(response.status).toBe(200);
    expect(emitted).toHaveLength(1);
    expect(emitted[0]?.deliveryId).toBe("d_single");
    expect(emitted[0]?.sessionId).toBe("sess-1");
    expect(emitted[0]?.runId).toBe("run-1");
    const cohort = body.data.cohorts[0]!;
    expect(cohort.single_used_anchor_count).toBe(1);
  });
});
