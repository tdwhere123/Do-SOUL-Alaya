import { describe, expect, it, vi } from "vitest";

import {
  createMcpMemoryToolHandler,
  type McpMemoryToolHandlerDependencies
} from "../../../mcp-memory/tool/tool-handler.js";
import {
  context,
  createRecallCandidate,
  createDeliveryRecord,
  createDeps
} from "../tool/mcp-memory-tool-handler-fixture.js";

const EVIDENCE_ID = "evidence-1";

function createEvidence(
  overrides: Readonly<{
    lifecycle_state?: string;
    evidence_health_state?: string;
  }> = {}
) {
  return {
    object_id: EVIDENCE_ID,
    object_kind: "evidence_capsule",
    schema_version: 1,
    workspace_id: context.workspaceId,
    lifecycle_state: overrides.lifecycle_state ?? "active",
    evidence_health_state: overrides.evidence_health_state ?? "verified",
    gist: "assistant response",
    excerpt: "The assistant returned the requested prior output."
  };
}

function createEvidenceDelivery(
  deliveredObjects: readonly Readonly<{ object_id: string; object_kind: string }>[]
) {
  return {
    ...createDeliveryRecord("delivery_1"),
    delivered_object_ids: deliveredObjects.map((object) => object.object_id),
    delivered_objects: deliveredObjects
  };
}

function withEvidenceService(
  deps: McpMemoryToolHandlerDependencies,
  findByIdScoped: NonNullable<
    McpMemoryToolHandlerDependencies["evidenceService"]
  >["findByIdScoped"]
): McpMemoryToolHandlerDependencies {
  return {
    ...deps,
    evidenceService: { findByIdScoped }
  };
}

describe("recall usage evidence proof", () => {
  it("keeps evidence in recall delivery but excludes it from memory side effects", async () => {
    const deps = createDeps();
    deps.recallService.recall = vi.fn(async () => ({
      candidates: [
        createRecallCandidate({ object_id: "mem1" }),
        createRecallCandidate({
          object_id: EVIDENCE_ID,
          object_kind: "evidence_capsule"
        }),
        createRecallCandidate({ object_id: "mem2" })
      ],
      active_constraints: [],
      active_constraints_count: 0,
      total_scanned: 3,
      coarse_filter_count: 3,
      fine_assessment_count: 3
    })) as typeof deps.recallService.recall;
    const coherentPairKeys = vi.fn(async () => new Set(["mem1|mem2"]));
    const enqueue = vi.fn((input: { readonly id: string }) => ({ task_id: input.id })) as never;
    const handler = createMcpMemoryToolHandler({
      ...deps,
      coRecallCoherenceGate: { coherentPairKeys },
      gardenTaskRepo: {
        enqueue,
        findById: vi.fn(() => null),
        peekPending: vi.fn(() => [])
      } as never
    } as never);

    const result = await handler.call({
      toolName: "soul.recall",
      arguments: {
        query: "recall the earlier assistant response and the related memories",
        recent_turn: "Please use the recalled context to answer this detailed follow-up request.",
        scope_class: null,
        dimension: null,
        domain_tags: null,
        max_results: 3
      },
      context
    });

    expect(result.ok).toBe(true);
    expect(deps.trustStateRecorder.recordDelivery).toHaveBeenCalledWith(
      expect.objectContaining({
        delivered_object_ids: ["mem1", EVIDENCE_ID, "mem2"],
        delivered_objects: [
          { object_id: "mem1", object_kind: "memory_entry" },
          { object_id: EVIDENCE_ID, object_kind: "evidence_capsule" },
          { object_id: "mem2", object_kind: "memory_entry" }
        ]
      })
    );
    expect(coherentPairKeys).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith(
      expect.objectContaining({
        payload: expect.objectContaining({
          turn_digest: expect.objectContaining({
            context_manifest: expect.objectContaining({
              delivered_object_ids: ["mem1", "mem2"]
            })
          })
        })
      })
    );
  });

  it("records a delivered evidence capsule as used without memory side effects", async () => {
    const deps = createDeps();
    deps.trustStateRecorder.findDeliveryById = vi.fn(async () =>
      createEvidenceDelivery([
        { object_id: EVIDENCE_ID, object_kind: "evidence_capsule" }
      ])
    );
    const findEvidence = vi.fn(async () => createEvidence());
    const handler = createMcpMemoryToolHandler(withEvidenceService(deps, findEvidence));

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        delivered_objects: [
          {
            object_id: EVIDENCE_ID,
            object_kind: "evidence_capsule",
            usage_status: "used"
          }
        ]
      },
      context
    });

    expect(result.ok).toBe(true);
    expect(findEvidence).toHaveBeenCalledWith(EVIDENCE_ID, context.workspaceId);
    expect(deps.trustStateRecorder.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        usage_state: "used",
        used_object_ids: [EVIDENCE_ID],
        used_objects: [
          { object_id: EVIDENCE_ID, object_kind: "evidence_capsule" }
        ]
      }),
      expect.objectContaining({
        expectedWorkspaceId: context.workspaceId,
        expectedAgentTarget: context.agentTarget,
        expectedRunId: context.runId
      })
    );
    expect(deps.memoryService.findByIdsScoped).not.toHaveBeenCalled();
    expect(deps.memoryService.findByIdScoped).not.toHaveBeenCalled();
    expect(deps.memoryService.updateScoped).not.toHaveBeenCalled();
  });

  it("keeps mixed self-report telemetry free of memory and co-usage mutation", async () => {
    const deps = createDeps();
    const deliveredObjects = [
      { object_id: "mem1", object_kind: "memory_entry" },
      { object_id: EVIDENCE_ID, object_kind: "evidence_capsule" },
      { object_id: "mem2", object_kind: "memory_entry" }
    ] as const;
    deps.trustStateRecorder.findDeliveryById = vi.fn(async () =>
      createEvidenceDelivery(deliveredObjects)
    );
    const handler = createMcpMemoryToolHandler(
      withEvidenceService(deps, vi.fn(async () => createEvidence()))
    );

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        delivered_objects: deliveredObjects.map((object) => ({
          ...object,
          usage_status: "used"
        }))
      },
      context
    });

    expect(result.ok).toBe(true);
    expect(deps.trustStateRecorder.recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        used_object_ids: ["mem1", EVIDENCE_ID, "mem2"],
        used_objects: [
          { object_id: "mem1", object_kind: "memory_entry" },
          { object_id: EVIDENCE_ID, object_kind: "evidence_capsule" },
          { object_id: "mem2", object_kind: "memory_entry" }
        ]
      }),
      expect.objectContaining({
        expectedWorkspaceId: context.workspaceId,
        expectedAgentTarget: context.agentTarget,
        expectedRunId: context.runId
      })
    );
    expect(deps.memoryService.updateScoped).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "missing",
      evidence: null,
      code: "NOT_FOUND"
    },
    {
      label: "inactive",
      evidence: createEvidence({ lifecycle_state: "deleted" }),
      code: "VALIDATION"
    },
    {
      label: "unhealthy",
      evidence: createEvidence({ evidence_health_state: "questionable" }),
      code: "VALIDATION"
    }
  ])("rejects $label evidence usage", async ({ evidence, code }) => {
    const deps = createDeps();
    deps.trustStateRecorder.findDeliveryById = vi.fn(async () =>
      createEvidenceDelivery([
        { object_id: EVIDENCE_ID, object_kind: "evidence_capsule" }
      ])
    );
    const handler = createMcpMemoryToolHandler(
      withEvidenceService(deps, vi.fn(async () => evidence))
    );

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        delivered_objects: [
          {
            object_id: EVIDENCE_ID,
            object_kind: "evidence_capsule",
            usage_status: "used"
          }
        ]
      },
      context
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code }
    });
    expect(deps.trustStateRecorder.recordUsage).not.toHaveBeenCalled();
    expect(deps.memoryService.updateScoped).not.toHaveBeenCalled();
  });

  it("rejects an evidence report whose kind was not delivered", async () => {
    const deps = createDeps();
    deps.trustStateRecorder.findDeliveryById = vi.fn(async () =>
      createEvidenceDelivery([
        { object_id: EVIDENCE_ID, object_kind: "memory_entry" }
      ])
    );
    const findEvidence = vi.fn(async () => createEvidence());
    const handler = createMcpMemoryToolHandler(withEvidenceService(deps, findEvidence));

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        delivered_objects: [
          {
            object_id: EVIDENCE_ID,
            object_kind: "evidence_capsule",
            usage_status: "used"
          }
        ]
      },
      context
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" }
    });
    expect(findEvidence).not.toHaveBeenCalled();
    expect(deps.trustStateRecorder.recordUsage).not.toHaveBeenCalled();
  });

  it("rejects explicit evidence usage against a legacy id-only delivery", async () => {
    const deps = createDeps();
    deps.trustStateRecorder.findDeliveryById = vi.fn(async () => ({
      ...createDeliveryRecord("delivery_1"),
      delivered_object_ids: [EVIDENCE_ID]
    }));
    const findEvidence = vi.fn(async () => createEvidence());
    const handler = createMcpMemoryToolHandler(withEvidenceService(deps, findEvidence));

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        delivered_objects: [
          {
            object_id: EVIDENCE_ID,
            object_kind: "evidence_capsule",
            usage_status: "used"
          }
        ]
      },
      context
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" }
    });
    expect(findEvidence).not.toHaveBeenCalled();
    expect(deps.trustStateRecorder.recordUsage).not.toHaveBeenCalled();
  });

  it.each([undefined, []] as const)(
    "rejects legacy raw usage when same-id cross-kind delivery has objects=%s",
    async (deliveredObjects) => {
      const deps = createDeps();
      deps.trustStateRecorder.findDeliveryById = vi.fn(async () =>
        createEvidenceDelivery([
          { object_id: "shared-object", object_kind: "memory_entry" },
          { object_id: "shared-object", object_kind: "evidence_capsule" }
        ])
      );
      const handler = createMcpMemoryToolHandler(deps);

      const result = await handler.call({
        toolName: "soul.report_context_usage",
        arguments: {
          delivery_id: "delivery_1",
          usage_state: "used",
          used_object_ids: ["shared-object"],
          ...(deliveredObjects === undefined
            ? {}
            : { delivered_objects: deliveredObjects })
        },
        context
      });

      expect(result).toMatchObject({
        ok: false,
        error: { code: "VALIDATION" }
      });
      expect(deps.trustStateRecorder.recordUsage).not.toHaveBeenCalled();
      expect(deps.memoryService.findByIdsScoped).not.toHaveBeenCalled();
    }
  );

  it.each([
    [
      {
        object_id: "unknown-1",
        object_kind: "future_capsule",
        usage_status: "used"
      }
    ],
    [
      {
        object_id: "mem1",
        object_kind: "memory_entry",
        usage_status: "used"
      },
      {
        object_id: "unknown-1",
        object_kind: "future_capsule",
        usage_status: "used"
      }
    ]
  ])("rejects unknown used object kinds without partial side effects", async (...deliveredObjects) => {
    const deps = createDeps();
    deps.trustStateRecorder.findDeliveryById = vi.fn(async () =>
      createEvidenceDelivery(
        deliveredObjects.map((object) => ({
          object_id: object.object_id,
          object_kind: object.object_kind
        }))
      )
    );
    const handler = createMcpMemoryToolHandler(deps);

    const result = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: "delivery_1",
        usage_state: "used",
        delivered_objects: deliveredObjects
      },
      context
    });

    expect(result).toMatchObject({
      ok: false,
      error: { code: "VALIDATION" }
    });
    expect(deps.trustStateRecorder.recordUsage).not.toHaveBeenCalled();
    expect(deps.memoryService.findByIdsScoped).not.toHaveBeenCalled();
    expect(deps.memoryService.updateScoped).not.toHaveBeenCalled();
  });
});
