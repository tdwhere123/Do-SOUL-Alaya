import { describe, expect, it, vi } from "vitest";

import { PathPlasticityService } from "@do-soul/alaya-core";
import type {
  ContextDeliveryRecord,
  EventLogEntry,
  PathRelation,
  UsageProofRecord
} from "@do-soul/alaya-protocol";

import {
  createMcpMemoryToolHandler,
  type McpMemoryToolHandlerDependencies
} from "../../mcp-memory/tool-handler.js";
import {
  TrustStateRecorder,
  type TrustStateRecorderDependencies
} from "../../trust/state.js";
import {
  context,
  createDeps
} from "./mcp-memory-tool-handler-fixture.js";

const NOW = "2026-04-30T00:00:00.000Z";

describe("recall usage evidence integration", () => {
  it("records mixed usage through TrustState but reinforces only the memory path", async () => {
    const trustRecorder = createTrustRecorder();
    const delivery = await trustRecorder.recordDelivery(createMixedDelivery());
    let recordedUsage: UsageProofRecord | null = null;
    const base = createDeps();
    const handler = createMcpMemoryToolHandler({
      ...base,
      evidenceService: {
        findByIdScoped: vi.fn(async () => ({
          object_id: "evidence-1",
          object_kind: "evidence_capsule",
          schema_version: 1,
          workspace_id: context.workspaceId,
          lifecycle_state: "active",
          evidence_health_state: "verified",
          gist: "verified assistant response",
          excerpt: "The assistant returned the requested prior output."
        }))
      },
      trustStateRecorder: wrapRecorder(trustRecorder, (usage) => {
        recordedUsage = usage;
      })
    });

    const report = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: delivery.delivery_id,
        usage_state: "used",
        used_object_ids: ["mem1", "evidence-1"],
        delivered_objects: [
          { object_id: "mem1", object_kind: "memory_entry", usage_status: "used" },
          {
            object_id: "evidence-1",
            object_kind: "evidence_capsule",
            usage_status: "used"
          }
        ],
        reason: "both objects informed the response"
      },
      context
    });

    expect(report.ok).toBe(true);
    expect(recordedUsage).toMatchObject({
      delivery_id: delivery.delivery_id,
      used_object_ids: ["mem1", "evidence-1"],
      used_objects: [
        { object_id: "mem1", object_kind: "memory_entry" },
        { object_id: "evidence-1", object_kind: "evidence_capsule" }
      ]
    });

    const memoryPath = createPath("path-memory", "mem1");
    const evidencePath = createPath("path-evidence", "evidence-1");
    const findByAnchor = vi.fn(async (_workspaceId: string, anchor: { object_id?: string }) => {
      if (anchor.object_id === "mem1") return [memoryPath];
      if (anchor.object_id === "evidence-1") return [evidencePath];
      return [];
    });
    const service = new PathPlasticityService({
      usageProofReader: {
        listRecentUsage: async () => [requireUsage(recordedUsage)],
        findDeliveredObjectIds: async () => delivery.delivered_object_ids,
        findDeliveredObjects: async () => delivery.delivered_objects ?? null
      },
      pathRelationRepo: {
        findByAnchor,
        update: (_pathId, updates) => ({ ...memoryPath, ...updates })
      },
      eventPublisher: {
        appendManyWithMutationAndDetachPropagation: (_inputs: unknown, mutate: () => unknown) =>
          mutate()
      } as unknown as ConstructorParameters<typeof PathPlasticityService>[0]["eventPublisher"],
      eventLogRepo: { queryByEntity: async () => [] },
      now: () => NOW
    });

    const result = await service.computeAndApplyPlasticity({
      workspaceId: context.workspaceId,
      sinceIso: "2026-04-01T00:00:00.000Z"
    });

    expect(result.affectedPathIds).toEqual(["path-memory"]);
    expect(findByAnchor).toHaveBeenCalledWith(
      context.workspaceId,
      { kind: "object", object_id: "mem1" }
    );
    expect(findByAnchor).not.toHaveBeenCalledWith(
      context.workspaceId,
      { kind: "object", object_id: "evidence-1" }
    );
  });

  it("uses kind-qualified evidence identity when delivered raw ids collide", async () => {
    const trustRecorder = createTrustRecorder();
    const delivery = await trustRecorder.recordDelivery({
      ...createMixedDelivery(),
      delivery_id: "delivery-shared-id",
      delivered_object_ids: ["shared-object"],
      delivered_objects: [
        { object_id: "shared-object", object_kind: "memory_entry" },
        { object_id: "shared-object", object_kind: "evidence_capsule" }
      ]
    });
    let recordedUsage: UsageProofRecord | null = null;
    const base = createDeps();
    const handler = createMcpMemoryToolHandler({
      ...base,
      evidenceService: {
        findByIdScoped: vi.fn(async () => ({
          object_id: "shared-object",
          object_kind: "evidence_capsule",
          schema_version: 1,
          workspace_id: context.workspaceId,
          lifecycle_state: "active",
          evidence_health_state: "verified",
          gist: "verified assistant response",
          excerpt: "The assistant returned the requested prior output."
        }))
      },
      trustStateRecorder: wrapRecorder(trustRecorder, (usage) => {
        recordedUsage = usage;
      })
    });

    const report = await handler.call({
      toolName: "soul.report_context_usage",
      arguments: {
        delivery_id: delivery.delivery_id,
        usage_state: "used",
        used_object_ids: ["shared-object"],
        delivered_objects: [
          {
            object_id: "shared-object",
            object_kind: "memory_entry",
            usage_status: "skipped"
          },
          {
            object_id: "shared-object",
            object_kind: "evidence_capsule",
            usage_status: "used"
          }
        ]
      },
      context
    });

    expect(report.ok).toBe(true);
    expect(recordedUsage).toMatchObject({
      used_object_ids: ["shared-object"],
      used_objects: [
        { object_id: "shared-object", object_kind: "evidence_capsule" }
      ]
    });
    expect(base.memoryService.findByIdsScoped).not.toHaveBeenCalled();
    expect(base.memoryService.updateScoped).not.toHaveBeenCalled();
  });
});

function createTrustRecorder(): TrustStateRecorder {
  let revision = 0;
  return new TrustStateRecorder({
    ready: true,
    clock: () => NOW,
    eventPublisher: {
      appendManyWithMutation: async (inputs, mutate) => {
        const entries = inputs.map((input) => {
          revision += 1;
          return {
            ...input,
            event_id: `event-${revision}`,
            created_at: NOW,
            revision
          } as EventLogEntry;
        });
        return mutate(entries);
      }
    }
  });
}

function wrapRecorder(
  recorder: TrustStateRecorder,
  onUsage: (usage: UsageProofRecord) => void
): McpMemoryToolHandlerDependencies["trustStateRecorder"] {
  return {
    recordDelivery: (input) => recorder.recordDelivery(input),
    findDeliveryById: (deliveryId) => recorder.findDeliveryById(deliveryId),
    recordUsage: async (input, options) => {
      const usage = await recorder.recordUsage(input, options);
      onUsage(usage);
      return usage;
    }
  };
}

function createMixedDelivery(): Omit<ContextDeliveryRecord, "audit_event_id"> {
  return {
    delivery_id: "delivery-chain",
    agent_target: context.agentTarget,
    workspace_id: context.workspaceId,
    run_id: context.runId,
    delivered_object_ids: ["mem1", "evidence-1"],
    delivered_objects: [
      { object_id: "mem1", object_kind: "memory_entry" },
      { object_id: "evidence-1", object_kind: "evidence_capsule" }
    ],
    delivered_at: NOW
  };
}

function createPath(pathId: string, objectId: string): PathRelation {
  return {
    path_id: pathId,
    workspace_id: context.workspaceId,
    anchors: {
      source_anchor: { kind: "object", object_id: objectId },
      target_anchor: { kind: "object", object_id: `${objectId}-target` }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["usage proof"]
    },
    effect_vector: {
      salience: 0.5,
      recall_bias: 0,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 0.5,
      direction_bias: "source_to_target",
      stability_class: "normal",
      support_events_count: 0,
      contradiction_events_count: 0
    },
    lifecycle: { retirement_rule: "default" },
    legitimacy: {
      evidence_basis: ["evidence-1"],
      governance_class: "recall_allowed"
    },
    created_at: NOW,
    updated_at: NOW
  };
}

function requireUsage(usage: UsageProofRecord | null): UsageProofRecord {
  if (usage === null) throw new Error("Expected TrustState usage proof.");
  return usage;
}
