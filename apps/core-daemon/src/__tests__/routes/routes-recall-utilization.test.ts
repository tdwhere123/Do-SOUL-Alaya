import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import { CoreError } from "@do-soul/alaya-core";
import { RecallContextEventType, type EventLogEntry } from "@do-soul/alaya-protocol";
import {
  registerRecallUtilizationRoutes,
  type RecallUtilizationRouteServices,
  type SingleUsedAnchorDeliveryReader,
  type SingleUsedAnchorEmitInput,
  type SingleUsedAnchorTelemetryEmitter
} from "../../routes/memory/recall/recall-utilization.js";
import { registerErrorHandler } from "../../middleware/error-handler.js";
import {
  deliveredPayload,
  fakeRecallUtilizationEventLogRepo,
  makeMalformedRecallUtilizationRow,
  makeRecallUtilizationRow,
  usagePayload
} from "../support/recall-utilization-fixtures.js";

const WORKSPACE_ID = "ws-1";

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
        readonly orphan_report_count: number;
        readonly orphan_session_count: number;
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
      eventLogRepo: fakeRecallUtilizationEventLogRepo([])
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
      eventLogRepo: fakeRecallUtilizationEventLogRepo([])
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
      eventLogRepo: fakeRecallUtilizationEventLogRepo([
        makeMalformedRecallUtilizationRow({
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
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d1",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "d1", runId: "run-1", pointerCount: 4 })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d2",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "d2", runId: "run-1", pointerCount: 2 })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d3",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "d3", runId: "run-1", pointerCount: 6 })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        entityId: "d1",
        runId: "run-1",
        payload: usagePayload({ deliveryId: "d1", runId: "run-1", usageState: "used" })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        entityId: "d2",
        runId: "run-1",
        payload: usagePayload({ deliveryId: "d2", runId: "run-1", usageState: "skipped" })
      })
    ];
    const app = buildApp({
      workspaceService: { getById: vi.fn().mockResolvedValue({ workspace_id: WORKSPACE_ID }) },
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
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
      reported_used: 1,
      orphan_report_count: 0,
      orphan_session_count: 0
    });
    expect(
      cohort.buckets.delivered_not_reported +
        cohort.buckets.reported_skipped_or_na +
        cohort.buckets.reported_used
    ).toBe(cohort.delivery_total);
  });

  it("counts empty_recall as a carve-out of delivered_not_reported when pointer_count is 0", async () => {
    const rows = [
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d_empty",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "d_empty", runId: "run-1", pointerCount: 0 })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d_nonempty",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "d_nonempty", runId: "run-1", pointerCount: 5 })
      })
    ];
    const app = buildApp({
      workspaceService: { getById: vi.fn().mockResolvedValue({ workspace_id: WORKSPACE_ID }) },
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
    });
    const response = await app.request(`/workspaces/${WORKSPACE_ID}/recall-utilization`);
    const body = (await response.json()) as RouteResponseShape;
    const cohort = body.data.cohorts[0]!;
    expect(cohort.buckets.empty_recall).toBe(1);
    expect(cohort.buckets.delivered_not_reported).toBe(2);
  });

  it("groups cohorts by (workspace_id, agent_target)", async () => {
    const rows = [
      makeRecallUtilizationRow({
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
      makeRecallUtilizationRow({
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
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
    });
    const response = await app.request(`/workspaces/${WORKSPACE_ID}/recall-utilization`);
    const body = (await response.json()) as RouteResponseShape;
    expect(body.data.cohorts).toHaveLength(2);
    const targets = body.data.cohorts.map((row) => row.agent_target);
    expect(targets).toEqual(["claude-code", "codex"]);
  });

  it("isolates cohorts per workspace via the query workspace filter", async () => {
    const rows = [
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d1",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "d1", runId: "run-1", pointerCount: 3 })
      }),
      makeRecallUtilizationRow({
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
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
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
      makeRecallUtilizationRow({
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
      makeRecallUtilizationRow({
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
      makeRecallUtilizationRow({
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
      makeRecallUtilizationRow({
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
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows),
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

  it("does not emit single_used_anchor when the report is skipped or not_applicable", async () => {
    const emitter: SingleUsedAnchorTelemetryEmitter = { emit: vi.fn().mockResolvedValue(undefined) };
    const rows = [
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d_single",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "d_single", runId: "run-1", pointerCount: 1 })
      }),
      makeRecallUtilizationRow({
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
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows),
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
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d_single",
        runId: "run-1",
        payload: deliveredPayload({ deliveryId: "d_single", runId: "run-1", pointerCount: 1 })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        entityId: "d_single",
        runId: "run-1",
        payload: usagePayload({ deliveryId: "d_single", runId: "run-1", usageState: "used" })
      })
    ];
    const app = buildApp({
      workspaceService: { getById: vi.fn().mockResolvedValue({ workspace_id: WORKSPACE_ID }) },
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows),
      singleUsedAnchorEmitter: emitter
    });
    const response = await app.request(`/workspaces/${WORKSPACE_ID}/recall-utilization`);
    expect(response.status).toBe(200);
    expect(emitter.emit).toHaveBeenCalledTimes(1);
  });

  it("counts orphan-report sessions as no_recall", async () => {
    const rows = [
      makeRecallUtilizationRow({
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
      makeRecallUtilizationRow({
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
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
    });
    const response = await app.request(`/workspaces/${WORKSPACE_ID}/recall-utilization`);
    const body = (await response.json()) as RouteResponseShape;
    const cohort = body.data.cohorts[0]!;
    expect(cohort.buckets.no_recall).toBe(2);
    expect(cohort.delivery_total).toBe(0);
  });

  it("respects since and until window filters", async () => {
    const rows = [
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d_in",
        runId: "run-1",
        payload: deliveredPayload({
          deliveryId: "d_in",
          runId: "run-1",
          pointerCount: 3,
          occurredAt: "2026-05-10T12:00:00.000Z"
        }),
        createdAt: "2026-04-01T00:00:00.000Z"
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "d_out",
        runId: "run-2",
        payload: deliveredPayload({
          deliveryId: "d_out",
          runId: "run-2",
          pointerCount: 7,
          occurredAt: "2026-04-01T00:00:00.000Z"
        }),
        createdAt: "2026-05-10T12:00:00.000Z"
      })
    ];
    const app = buildApp({
      workspaceService: { getById: vi.fn().mockResolvedValue({ workspace_id: WORKSPACE_ID }) },
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
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

  it("looks up 1000 single-used anchors with one batch query", async () => {
    const matchCount = 1000;
    const rows: EventLogEntry[] = [];
    for (let index = 0; index < matchCount; index += 1) {
      const deliveryId = `d_${index}`;
      rows.push(
        makeRecallUtilizationRow({
          type: RecallContextEventType.SOUL_RECALL_DELIVERED,
          entityId: deliveryId,
          runId: "run-1",
          payload: deliveredPayload({ deliveryId, runId: "run-1", pointerCount: 1 })
        }),
        makeRecallUtilizationRow({
          type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
          entityId: deliveryId,
          runId: "run-1",
          payload: usagePayload({ deliveryId, runId: "run-1", usageState: "used" })
        })
      );
    }
    let queryCount = 0;
    const findDeliveredObjectIds = vi.fn(
      async (_deliveryId: string): Promise<readonly string[] | null> => {
        throw new Error("serial lookup must not run when a batch port exists");
      }
    );
    const findDeliveredObjectIdsMany = vi.fn(
      async (
        deliveryIds: readonly string[]
      ): Promise<ReadonlyMap<string, readonly string[] | null>> => {
        queryCount += 1;
        return new Map(
          deliveryIds.map((deliveryId): readonly [string, readonly string[]] => [
            deliveryId,
            [`obj-${deliveryId}`]
          ])
        );
      }
    );
    const emitMany = vi.fn(
      async (_inputs: readonly SingleUsedAnchorEmitInput[]): Promise<void> => undefined
    );
    const anchorReader: SingleUsedAnchorDeliveryReader = {
      findDeliveredObjectIds,
      findDeliveredObjectIdsMany
    };
    const emitter: SingleUsedAnchorTelemetryEmitter = {
      emit: vi.fn(
        async (_input: SingleUsedAnchorEmitInput): Promise<void> => {
          throw new Error("serial emit must not run when emitMany exists");
        }
      ),
      emitMany
    };
    const app = buildApp({
      workspaceService: { getById: vi.fn().mockResolvedValue({ workspace_id: WORKSPACE_ID }) },
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows),
      singleUsedAnchorEmitter: emitter,
      deliveryAnchorReader: anchorReader
    });
    const response = await app.request(`/workspaces/${WORKSPACE_ID}/recall-utilization`);
    expect(response.status).toBe(200);
    expect(queryCount).toBe(1);
    expect(findDeliveredObjectIdsMany).toHaveBeenCalledOnce();
    expect(emitMany).toHaveBeenCalledOnce();
    const emittedBatch = emitMany.mock.calls.at(0)?.at(0);
    expect(emittedBatch).toHaveLength(matchCount);
    expect(findDeliveredObjectIds).not.toHaveBeenCalled();
    expect(emitter.emit).not.toHaveBeenCalled();
  });
});
