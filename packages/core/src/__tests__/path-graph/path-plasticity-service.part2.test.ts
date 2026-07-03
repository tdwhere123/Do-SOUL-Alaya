import { describe, expect, it } from "vitest";
import { RuntimeGovernanceEventType, type PathRelation } from "@do-soul/alaya-protocol";
import { PATH_PLASTICITY_CONSTANTS } from "../../path-plasticity/index.js";
import { PAST_REINFORCED_ISO, RECENT_REINFORCED_ISO, buildHarness, createPath, createUsageRecord } from "./path-plasticity-service-test-fixtures.js";

describe("PathPlasticityService", () => {
it("clamps strength at the [0, 1] interval and never produces a negative or super-unitary value", async () => {
    const ceilingPath = createPath({ path_id: "path-ceiling", plasticity_state: { strength: 0.99, direction_bias: "source_to_target", stability_class: "normal", support_events_count: 0, contradiction_events_count: 0 } });
    const floorPath = createPath({ path_id: "path-floor", plasticity_state: { strength: 0.01, direction_bias: "source_to_target", stability_class: "normal", support_events_count: 0, contradiction_events_count: 0, last_reinforced_at: RECENT_REINFORCED_ISO } });

    const harness = buildHarness({
      usageRecords: [
        createUsageRecord({ delivery_id: "delivery-used", used_object_ids: ["obj-ceiling"] }),
        createUsageRecord({ delivery_id: "delivery-skipped", usage_state: "skipped", used_object_ids: [] })
      ],
      pathsByObjectId: {
        "obj-ceiling": [ceilingPath],
        "obj-target": [floorPath]
      },
      deliveredObjectIdsByDeliveryId: { "delivery-skipped": ["obj-target"] }
    });

    await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    const ceilingUpdate = harness.repoUpdates.find((entry) => entry.pathId === "path-ceiling");
    const floorUpdate = harness.repoUpdates.find((entry) => entry.pathId === "path-floor");
    expect(ceilingUpdate?.updates.plasticity_state?.strength).toBeLessThanOrEqual(1);
    expect(floorUpdate?.updates.plasticity_state?.strength).toBeGreaterThanOrEqual(0);
  });

it("aggregates multiple used receipts on the same path into one reinforced event with combined support_events_count", async () => {
    // invariant: distinct used receipts targeting one path collapse into a
    // single reinforced event, while repeated use applies a decayed strength
    // signal instead of a linear multiplier.
    const path = createPath();
    const harness = buildHarness({
      usageRecords: [
        createUsageRecord({ delivery_id: "delivery-1", used_object_ids: ["obj-target"] }),
        createUsageRecord({ delivery_id: "delivery-2", used_object_ids: ["obj-target"], reported_at: "2026-05-04T13:00:00.000Z" })
      ],
      pathsByObjectId: { "obj-target": [path] }
    });

    await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    const reinforcedEvents = harness.publishedEvents.filter(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_REINFORCED
    );
    expect(reinforcedEvents).toHaveLength(1);
    expect(reinforcedEvents[0]?.payload_json).toMatchObject({
      support_events_count: 2,
      new_strength: 0.5 + 1.5 * PATH_PLASTICITY_CONSTANTS.USED_DELTA
    });
  });

it("halves the strength signal for automatic trust-mode used receipts", async () => {
    const path = createPath({ plasticity_state: { strength: 0.4, direction_bias: "source_to_target", stability_class: "normal", support_events_count: 2, contradiction_events_count: 0 } });
    const harness = buildHarness({
      usageRecords: [
        createUsageRecord({
          delivery_id: "delivery-auto",
          used_object_ids: ["obj-target"],
          trust_mode: "automatic"
        })
      ],
      pathsByObjectId: { "obj-target": [path] }
    });

    await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    const reinforcedEvents = harness.publishedEvents.filter(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_REINFORCED
    );
    expect(reinforcedEvents).toHaveLength(1);
    expect(reinforcedEvents[0]?.payload_json).toMatchObject({
      support_events_count: 3,
      new_strength: 0.4 + PATH_PLASTICITY_CONSTANTS.USED_DELTA * 0.5
    });
    expect(harness.repoUpdates[0]?.updates.plasticity_state).toMatchObject({
      support_events_count: 3,
      support_exposure_count: 2.5,
      contradiction_exposure_count: 0
    });
  });

it("dedupes a path whose source_anchor and target_anchor object_ids both appear in one usage receipt — exactly one delta and one audit event", async () => {
    // invariant: citing both anchors of the same PathRelation in one usage
    // receipt produces one logical reinforcement and one durable update.
    const dualAnchorPath = createPath({
      path_id: "path-dual-anchor",
      anchors: {
        source_anchor: { kind: "object", object_id: "obj-source-M1" },
        target_anchor: { kind: "object", object_id: "obj-target-M2" }
      },
      plasticity_state: {
        strength: 0.4,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0
      }
    });
    // invariant: the repository may return the same path from either anchor
    // lookup; aggregation dedupes the path before applying the receipt.
    const harness = buildHarness({
      usageRecords: [
        createUsageRecord({
          delivery_id: "delivery-dual",
          used_object_ids: ["obj-source-M1", "obj-target-M2"]
        })
      ],
      pathsByObjectId: {
        "obj-source-M1": [dualAnchorPath],
        "obj-target-M2": [dualAnchorPath]
      }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.reinforced).toBe(1);
    expect(result.affectedPathIds).toEqual(["path-dual-anchor"]);

    const reinforcedEvents = harness.publishedEvents.filter(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_REINFORCED
    );
    expect(reinforcedEvents).toHaveLength(1);

    expect(reinforcedEvents[0]?.payload_json).toMatchObject({
      previous_strength: 0.4,
      new_strength: 0.4 + PATH_PLASTICITY_CONSTANTS.USED_DELTA,
      support_events_count: 1
    });

    expect(harness.repoUpdates).toHaveLength(1);
    expect(harness.repoUpdates[0]?.pathId).toBe("path-dual-anchor");
    expect(harness.repoUpdates[0]?.updates.plasticity_state?.strength).toBeCloseTo(
      0.4 + PATH_PLASTICITY_CONSTANTS.USED_DELTA,
      10
    );
  });

it("emits no event and does not throw when the receipt cites an object_id with no matching PathRelation", async () => {
    const harness = buildHarness({
      usageRecords: [createUsageRecord({ used_object_ids: ["obj-no-path"] })],
      pathsByObjectId: {} // no paths anchored on obj-no-path
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.reinforced).toBe(0);
    expect(result.weakened).toBe(0);
    expect(result.retired).toBe(0);
    expect(result.affectedPathIds).toEqual([]);
    expect(harness.publishedEvents).toHaveLength(0);
    expect(harness.repoUpdates).toHaveLength(0);
  });

it("ignores receipts against a path whose lifecycle status is already retired — no duplicate retired event, no further updates", async () => {
    const retiredPath = createPath({
      path_id: "path-already-retired",
      lifecycle: {
        status: "retired",
        retirement_rule: "default"
      } as unknown as PathRelation["lifecycle"],
      plasticity_state: {
        strength: 0,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0,
        last_weakened_at: PAST_REINFORCED_ISO
      }
    });

    const harness = buildHarness({
      usageRecords: [createUsageRecord({ usage_state: "skipped", used_object_ids: [] })],
      pathsByObjectId: { "obj-target": [retiredPath] },
      deliveredObjectIdsByDeliveryId: { "delivery-1": ["obj-target"] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    // Should have processed nothing — the path was already retired.
    expect(result.reinforced).toBe(0);
    expect(result.weakened).toBe(0);
    expect(result.retired).toBe(0);
    expect(harness.publishedEvents).toHaveLength(0);
    // No durable repo updates.
    expect(harness.repoUpdates).toHaveLength(0);
  });

// ----- Verification gap: retirement on netDelta == 0 -----------------

  it("retires (does NOT silently no-op) when a skipped receipt arrives on a path already at strength=0 and the inactivity window has elapsed", async () => {
    // The previous code only checked retirement inside the `netDelta < 0`
    // branch. A path at strength=0 receiving another skipped receipt
    // produces clamped proposed=0 → netDelta=0 → fell through to "none",
    // so the path was stuck at strength=0 forever and never retired even
    // when the inactivity window had long passed.
    const stuckAtZeroPath = createPath({
      path_id: "path-stuck-at-zero",
      plasticity_state: {
        strength: 0,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0,
        last_reinforced_at: PAST_REINFORCED_ISO // > 30 days before NOW
      }
    });

    const harness = buildHarness({
      usageRecords: [createUsageRecord({ usage_state: "skipped", used_object_ids: [] })],
      pathsByObjectId: { "obj-target": [stuckAtZeroPath] },
      deliveredObjectIdsByDeliveryId: { "delivery-1": ["obj-target"] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.retired).toBe(1);
    expect(result.weakened).toBe(0);
    const retiredEvent = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_RETIRED
    );
    expect(retiredEvent).toBeDefined();
    expect(retiredEvent?.payload_json).toMatchObject({
      path_id: "path-stuck-at-zero",
      retirement_reason: "strength_below_threshold_and_inactive; gate=mergeable",
      final_strength: 0
    });
    expect(harness.repoUpdates[0]?.updates.lifecycle).toMatchObject({
      status: "retired"
    });
  });
});
