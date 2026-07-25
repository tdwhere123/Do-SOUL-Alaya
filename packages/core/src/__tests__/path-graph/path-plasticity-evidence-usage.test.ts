import { describe, expect, it } from "vitest";

import {
  buildHarness,
  createPath,
  createUsageRecord
} from "./path-plasticity-service-test-fixtures.js";

describe("path plasticity evidence usage", () => {
  it("reinforces used memory entries without treating used evidence as a path anchor", async () => {
    const memoryPath = createPath({
      path_id: "path-memory",
      anchors: {
        source_anchor: { kind: "object", object_id: "memory-a" },
        target_anchor: { kind: "object", object_id: "memory-target" }
      }
    });
    const evidencePath = createPath({
      path_id: "path-evidence",
      anchors: {
        source_anchor: { kind: "object", object_id: "evidence-a" },
        target_anchor: { kind: "object", object_id: "evidence-target" }
      }
    });
    const harness = buildHarness({
      usageRecords: [
        createUsageRecord({
          delivery_id: "delivery-mixed",
          usage_state: "used",
          used_object_ids: ["memory-a", "evidence-a"],
          used_objects: [
            { object_id: "memory-a", object_kind: "memory_entry" },
            { object_id: "evidence-a", object_kind: "evidence_capsule" }
          ]
        })
      ],
      pathsByObjectId: {
        "memory-a": [memoryPath],
        "evidence-a": [evidencePath]
      },
      deliveredObjectIdsByDeliveryId: {
        "delivery-mixed": ["memory-a", "evidence-a"]
      },
      deliveredObjectsByDeliveryId: {
        "delivery-mixed": [
          { object_id: "memory-a", object_kind: "memory_entry" },
          { object_id: "evidence-a", object_kind: "evidence_capsule" }
        ]
      }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.affectedPathIds).toEqual(["path-memory"]);
    expect(harness.pathRepo.findByAnchor).toHaveBeenCalledWith(
      "workspace-1",
      { kind: "object", object_id: "memory-a" }
    );
    expect(harness.pathRepo.findByAnchor).not.toHaveBeenCalledWith(
      "workspace-1",
      { kind: "object", object_id: "evidence-a" }
    );
    expect(harness.usageReader.findDeliveredObjects).not.toHaveBeenCalled();
  });

  it("does not reinforce a same-id memory path when only evidence was used", async () => {
    const memoryPath = createPath({
      path_id: "path-shared-memory",
      anchors: {
        source_anchor: { kind: "object", object_id: "shared-object" },
        target_anchor: { kind: "object", object_id: "memory-target" }
      }
    });
    const harness = buildHarness({
      usageRecords: [
        createUsageRecord({
          delivery_id: "delivery-shared",
          used_object_ids: ["shared-object"],
          used_objects: [
            { object_id: "shared-object", object_kind: "evidence_capsule" }
          ]
        })
      ],
      pathsByObjectId: { "shared-object": [memoryPath] },
      deliveredObjectsByDeliveryId: {
        "delivery-shared": [
          { object_id: "shared-object", object_kind: "memory_entry" },
          { object_id: "shared-object", object_kind: "evidence_capsule" }
        ]
      }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.affectedPathIds).toEqual([]);
    expect(harness.pathRepo.findByAnchor).not.toHaveBeenCalled();
  });
});
