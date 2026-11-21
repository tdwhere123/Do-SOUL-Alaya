import { describe, expect, it } from "vitest";
import {
  ComputeRecallGardenEventType,
  RecallContextEventType
} from "@do-soul/alaya-protocol";
import { HTTP_REVIEWER_AGENT_TARGET } from "../../mcp-memory/proposal/reviewer-surfaces.js";
import { createRecallUtilizationService } from "../../services/status/recall-utilization-service.js";
import {
  deliveredPayload,
  embeddingQueriedPayload,
  fakeRecallUtilizationEventLogRepo,
  makeMalformedRecallUtilizationRow,
  makeRecallUtilizationRow,
  usagePayload
} from "../support/recall-utilization-fixtures.js";

const WORKSPACE_ID = "workspace-1";

describe("recall-utilization-service", () => {
  it("returns zero counts and null latency percentiles when no events are present", async () => {
    const service = createRecallUtilizationService({
      eventLogRepo: fakeRecallUtilizationEventLogRepo([])
    });
    const stats = await service.getStats({ workspaceId: WORKSPACE_ID });

    expect(stats.window).toEqual({
      workspace_id: WORKSPACE_ID,
      since: null,
      until: null,
      excluded_agent_targets: ["cli", HTTP_REVIEWER_AGENT_TARGET, "tools-cli"]
    });
    expect(stats.recall.total).toBe(0);
    expect(stats.recall.unique_runs).toBe(0);
    expect(stats.recall.miss_ratio).toBe(0);
    expect(stats.recall.p50_pointer_count).toBe(0);
    expect(stats.recall.p50_latency_ms).toBeNull();
    expect(stats.recall.p95_latency_ms).toBeNull();
    expect(stats.recall.p99_latency_ms).toBeNull();
    expect(stats.embedding).toEqual({
      total_queries: 0,
      returned_candidate_count: 0,
      p50_latency_ms: null,
      p95_latency_ms: null,
      p99_latency_ms: null,
      latency_buckets: [
        { label: "<=150ms", count: 0 },
        { label: "<=300ms", count: 0 },
        { label: "<=800ms", count: 0 },
        { label: "<=1100ms", count: 0 },
        { label: ">1100ms", count: 0 }
      ]
    });
    expect(stats.usage.total).toBe(0);
    expect(stats.usage.used_ratio).toBe(0);
    expect(stats.usage.follow_through_ratio).toBe(0);
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
      type: ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
      entityId: "bad-embedding-array",
      payload: []
    }
  ])("throws a typed validation error for malformed $type payload_json", async ({ type, entityId, payload }) => {
    const service = createRecallUtilizationService({
      eventLogRepo: fakeRecallUtilizationEventLogRepo([
        makeMalformedRecallUtilizationRow({
          type,
          entityId,
          runId: "run-1",
          payload,
          workspaceId: WORKSPACE_ID
        })
      ])
    });

    await expect(service.getStats({ workspaceId: WORKSPACE_ID })).rejects.toMatchObject({
      code: "VALIDATION",
      message: `Invalid recall utilization EventLog payload for ${type}`
    });
  });

  it("aggregates embedding supplement latency percentiles and buckets", async () => {
    const rows = [
      makeRecallUtilizationRow({
        type: ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
        entityId: "query-1",
        runId: "run-1",
        workspaceId: WORKSPACE_ID,
        payload: embeddingQueriedPayload({
          queryId: "query-1",
          runId: "run-1",
          latencyMs: 120,
          returnedCandidateCount: 5,
          workspaceId: WORKSPACE_ID
        })
      }),
      makeRecallUtilizationRow({
        type: ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
        entityId: "query-2",
        runId: "run-1",
        workspaceId: WORKSPACE_ID,
        payload: embeddingQueriedPayload({
          queryId: "query-2",
          runId: "run-1",
          latencyMs: 280,
          returnedCandidateCount: 1,
          workspaceId: WORKSPACE_ID
        })
      }),
      makeRecallUtilizationRow({
        type: ComputeRecallGardenEventType.RECALL_EMBEDDING_SUPPLEMENT_QUERIED,
        entityId: "query-3",
        runId: "run-2",
        workspaceId: WORKSPACE_ID,
        payload: embeddingQueriedPayload({
          queryId: "query-3",
          runId: "run-2",
          latencyMs: 1250,
          returnedCandidateCount: 0,
          workspaceId: WORKSPACE_ID
        })
      })
    ];

    const stats = await createRecallUtilizationService({
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
    }).getStats({ workspaceId: WORKSPACE_ID });

    expect(stats.embedding).toEqual({
      total_queries: 3,
      returned_candidate_count: 6,
      p50_latency_ms: 280,
      p95_latency_ms: 1250,
      p99_latency_ms: 1250,
      latency_buckets: [
        { label: "<=150ms", count: 1 },
        { label: "<=300ms", count: 1 },
        { label: "<=800ms", count: 0 },
        { label: "<=1100ms", count: 0 },
        { label: ">1100ms", count: 1 }
      ]
    });
  });

  it("aggregates recall delivery end-to-end latency percentiles", async () => {
    const latencyMsByDelivery = [120, 280, 90, 1250, 40, 600, 150, 95, 310, 180] as const;
    const rows = latencyMsByDelivery.map((latencyMs, index) =>
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: `delivery_${index + 1}`,
        runId: `run-${(index % 3) + 1}`,
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({
          deliveryId: `delivery_${index + 1}`,
          runId: `run-${(index % 3) + 1}`,
          pointerCount: index + 1,
          latencyMs,
          workspaceId: WORKSPACE_ID
        })
      })
    );

    const stats = await createRecallUtilizationService({
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
    }).getStats({ workspaceId: WORKSPACE_ID });

    expect(stats.recall.total).toBe(10);
    expect(stats.recall.p50_latency_ms).toBe(165);
    expect(stats.recall.p95_latency_ms).toBe(1250);
    expect(stats.recall.p99_latency_ms).toBe(1250);
  });

  it("computes a single recall with no usage report", async () => {
    const rows = [
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_1",
        runId: "run-1",
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({
          deliveryId: "delivery_1",
          runId: "run-1",
          pointerCount: 3,
          latencyMs: 142,
          workspaceId: WORKSPACE_ID
        })
      })
    ];
    const stats = await createRecallUtilizationService({
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
    }).getStats({ workspaceId: WORKSPACE_ID });

    expect(stats.recall.total).toBe(1);
    expect(stats.recall.unique_runs).toBe(1);
    expect(stats.recall.null_run).toBe(0);
    expect(stats.recall.miss_count).toBe(0);
    expect(stats.recall.miss_ratio).toBe(0);
    expect(stats.recall.p50_pointer_count).toBe(3);
    expect(stats.recall.p50_latency_ms).toBe(142);
    expect(stats.recall.p95_latency_ms).toBe(142);
    expect(stats.recall.p99_latency_ms).toBe(142);
    expect(stats.usage.total).toBe(0);
    expect(stats.usage.follow_through_ratio).toBe(0);
  });

  it("counts unique runs and null-run recalls separately", async () => {
    const rows = [
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_1",
        runId: "run-1",
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({ deliveryId: "delivery_1", runId: "run-1", pointerCount: 5, latencyMs: 100, workspaceId: WORKSPACE_ID })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_2",
        runId: "run-1",
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({ deliveryId: "delivery_2", runId: "run-1", pointerCount: 2, latencyMs: 80, workspaceId: WORKSPACE_ID })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_3",
        runId: "run-2",
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({ deliveryId: "delivery_3", runId: "run-2", pointerCount: 0, latencyMs: 60, workspaceId: WORKSPACE_ID })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_4",
        runId: null,
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({ deliveryId: "delivery_4", runId: null, pointerCount: 1, latencyMs: 200, workspaceId: WORKSPACE_ID })
      })
    ];
    const stats = await createRecallUtilizationService({
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
    }).getStats({ workspaceId: WORKSPACE_ID });

    expect(stats.recall.total).toBe(4);
    expect(stats.recall.unique_runs).toBe(2);
    expect(stats.recall.null_run).toBe(1);
    expect(stats.recall.miss_count).toBe(1);
    expect(stats.recall.miss_ratio).toBe(0.25);
    expect(stats.recall.p50_pointer_count).toBe(1.5);
    expect(stats.recall.p50_latency_ms).toBe(90);
    expect(stats.recall.p95_latency_ms).toBe(200);
    expect(stats.recall.p99_latency_ms).toBe(200);
  });

  it("computes used_ratio across used / skipped only and follow_through_ratio over recalls", async () => {
    const rows = [
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_1",
        runId: "run-1",
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({ deliveryId: "delivery_1", runId: "run-1", pointerCount: 3, latencyMs: 50, workspaceId: WORKSPACE_ID })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_2",
        runId: "run-1",
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({ deliveryId: "delivery_2", runId: "run-1", pointerCount: 4, latencyMs: 70, workspaceId: WORKSPACE_ID })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        entityId: "delivery_1",
        runId: "run-1",
        workspaceId: WORKSPACE_ID,
        payload: usagePayload({ deliveryId: "delivery_1", runId: "run-1", usageState: "used", workspaceId: WORKSPACE_ID })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        entityId: "delivery_2",
        runId: "run-1",
        workspaceId: WORKSPACE_ID,
        payload: usagePayload({ deliveryId: "delivery_2", runId: "run-1", usageState: "skipped", workspaceId: WORKSPACE_ID })
      })
    ];
    const stats = await createRecallUtilizationService({
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
    }).getStats({ workspaceId: WORKSPACE_ID });

    expect(stats.usage.total).toBe(2);
    expect(stats.usage.used).toBe(1);
    expect(stats.usage.skipped).toBe(1);
    expect(stats.usage.not_applicable).toBe(0);
    expect(stats.usage.used_ratio).toBe(0.5);
    expect(stats.usage.follow_through_ratio).toBe(1);
  });

  it("excludes not_applicable from used_ratio denominator", async () => {
    const rows = [
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_1",
        runId: "run-1",
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({ deliveryId: "delivery_1", runId: "run-1", pointerCount: 1, latencyMs: 10, workspaceId: WORKSPACE_ID })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        entityId: "delivery_1",
        runId: "run-1",
        workspaceId: WORKSPACE_ID,
        payload: usagePayload({ deliveryId: "delivery_1", runId: "run-1", usageState: "not_applicable", workspaceId: WORKSPACE_ID })
      })
    ];
    const stats = await createRecallUtilizationService({
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
    }).getStats({ workspaceId: WORKSPACE_ID });

    expect(stats.usage.total).toBe(1);
    expect(stats.usage.not_applicable).toBe(1);
    expect(stats.usage.used_ratio).toBe(0);
  });

  it("filters by since and until window", async () => {
    const rows = [
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_inside",
        runId: "run-1",
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({
          deliveryId: "delivery_inside",
          runId: "run-1",
          pointerCount: 2,
          latencyMs: 50,
          workspaceId: WORKSPACE_ID,
          occurredAt: "2026-05-10T12:00:00.000Z"
        }),
        createdAt: "2026-05-10T12:00:00.000Z"
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_outside",
        runId: "run-2",
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({
          deliveryId: "delivery_outside",
          runId: "run-2",
          pointerCount: 7,
          latencyMs: 90,
          workspaceId: WORKSPACE_ID,
          occurredAt: "2026-04-01T00:00:00.000Z"
        }),
        createdAt: "2026-04-01T00:00:00.000Z"
      })
    ];
    const stats = await createRecallUtilizationService({
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
    }).getStats({
      workspaceId: WORKSPACE_ID,
      since: "2026-05-01T00:00:00.000Z",
      until: "2026-05-31T23:59:59.000Z"
    });

    expect(stats.recall.total).toBe(1);
    expect(stats.recall.p50_pointer_count).toBe(2);
  });

  it("counts unique_sessions independently from unique_runs", async () => {
    const rows = [
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_a",
        runId: null,
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({
          deliveryId: "delivery_a",
          runId: null,
          pointerCount: 1,
          latencyMs: 10,
          sessionId: "mcp-session-A",
          workspaceId: WORKSPACE_ID
        })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_b",
        runId: null,
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({
          deliveryId: "delivery_b",
          runId: null,
          pointerCount: 2,
          latencyMs: 20,
          sessionId: "mcp-session-A",
          workspaceId: WORKSPACE_ID
        })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_c",
        runId: null,
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({
          deliveryId: "delivery_c",
          runId: null,
          pointerCount: 3,
          latencyMs: 30,
          sessionId: "mcp-session-B",
          workspaceId: WORKSPACE_ID
        })
      })
    ];
    const stats = await createRecallUtilizationService({
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
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
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_at_since",
        runId: "run-since",
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({
          deliveryId: "delivery_at_since",
          runId: "run-since",
          pointerCount: 1,
          latencyMs: 10,
          workspaceId: WORKSPACE_ID,
          occurredAt: SINCE
        }),
        createdAt: UNTIL
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_at_until",
        runId: "run-until",
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({
          deliveryId: "delivery_at_until",
          runId: "run-until",
          pointerCount: 2,
          latencyMs: 20,
          workspaceId: WORKSPACE_ID,
          occurredAt: UNTIL
        }),
        createdAt: SINCE
      })
    ];
    const stats = await createRecallUtilizationService({
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
    }).getStats({ workspaceId: WORKSPACE_ID, since: SINCE, until: UNTIL });

    expect(stats.recall.total).toBe(1);
    expect(stats.recall.p50_pointer_count).toBe(2);
  });

  it("excludes http-reviewer, cli, and tools-cli agent targets by default", async () => {
    const rows = [
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_agent",
        runId: "run-1",
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({
          deliveryId: "delivery_agent",
          runId: "run-1",
          pointerCount: 5,
          latencyMs: 100,
          agentTarget: "claude-code",
          workspaceId: WORKSPACE_ID
        })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_http_reviewer",
        runId: null,
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({
          deliveryId: "delivery_http_reviewer",
          runId: null,
          pointerCount: 99,
          latencyMs: 999,
          agentTarget: HTTP_REVIEWER_AGENT_TARGET,
          workspaceId: WORKSPACE_ID
        })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_cli",
        runId: "run-2",
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({
          deliveryId: "delivery_cli",
          runId: "run-2",
          pointerCount: 7,
          latencyMs: 50,
          agentTarget: "cli",
          workspaceId: WORKSPACE_ID
        })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_tools_cli",
        runId: "run-3",
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({
          deliveryId: "delivery_tools_cli",
          runId: "run-3",
          pointerCount: 11,
          latencyMs: 200,
          agentTarget: "tools-cli",
          workspaceId: WORKSPACE_ID
        })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_CONTEXT_USAGE_REPORTED,
        entityId: "delivery_http_reviewer",
        runId: null,
        workspaceId: WORKSPACE_ID,
        payload: usagePayload({
          deliveryId: "delivery_http_reviewer",
          runId: null,
          usageState: "skipped",
          agentTarget: HTTP_REVIEWER_AGENT_TARGET,
          workspaceId: WORKSPACE_ID
        })
      })
    ];
    const stats = await createRecallUtilizationService({
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
    }).getStats({ workspaceId: WORKSPACE_ID });

    expect(stats.recall.total).toBe(1);
    expect(stats.recall.p50_pointer_count).toBe(5);
    expect(stats.recall.p50_latency_ms).toBe(100);
    expect(stats.usage.total).toBe(0);
    expect(stats.window.excluded_agent_targets).toEqual(["cli", HTTP_REVIEWER_AGENT_TARGET, "tools-cli"]);
  });

  it("respects an explicit excludeAgentTargets override", async () => {
    const rows = [
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_http_reviewer",
        runId: null,
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({
          deliveryId: "delivery_http_reviewer",
          runId: null,
          pointerCount: 2,
          latencyMs: 30,
          agentTarget: HTTP_REVIEWER_AGENT_TARGET,
          workspaceId: WORKSPACE_ID
        })
      })
    ];
    const stats = await createRecallUtilizationService({
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
    }).getStats({ workspaceId: WORKSPACE_ID, excludeAgentTargets: [] });

    expect(stats.recall.total).toBe(1);
    expect(stats.window.excluded_agent_targets).toEqual([]);
  });

  it("isolates stats per workspace", async () => {
    const rows = [
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_1",
        runId: "run-1",
        workspaceId: WORKSPACE_ID,
        payload: deliveredPayload({ deliveryId: "delivery_1", runId: "run-1", pointerCount: 3, latencyMs: 100, workspaceId: WORKSPACE_ID })
      }),
      makeRecallUtilizationRow({
        type: RecallContextEventType.SOUL_RECALL_DELIVERED,
        entityId: "delivery_other",
        runId: "run-9",
        workspaceId: "workspace-other",
        payload: deliveredPayload({
          deliveryId: "delivery_other",
          runId: "run-9",
          pointerCount: 99,
          latencyMs: 999,
          workspaceId: "workspace-other"
        })
      })
    ];
    const stats = await createRecallUtilizationService({
      eventLogRepo: fakeRecallUtilizationEventLogRepo(rows)
    }).getStats({ workspaceId: WORKSPACE_ID });

    expect(stats.recall.total).toBe(1);
    expect(stats.recall.p50_latency_ms).toBe(100);
  });
});
