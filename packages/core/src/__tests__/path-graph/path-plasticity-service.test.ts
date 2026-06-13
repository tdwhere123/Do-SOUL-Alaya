import { describe, expect, it } from "vitest";
import { RuntimeGovernanceEventType, type PathRelation } from "@do-soul/alaya-protocol";
import { PATH_PLASTICITY_CONSTANTS } from "../../path-plasticity/index.js";
import {
  NOW_ISO,
  PAST_REINFORCED_ISO,
  RECENT_REINFORCED_ISO,
  buildHarness,
  createPath,
  createUsageRecord
} from "./path-plasticity-service-test-fixtures.js";

describe("PathPlasticityService", () => {
  it("returns a noop result and emits no events when no usage records exist", async () => {
    const harness = buildHarness({ usageRecords: [], pathsByObjectId: {} });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result).toEqual({
      reinforced: 0,
      weakened: 0,
      retired: 0,
      dormant: 0,
      revived: 0,
      affectedPathIds: [],
      promotions: []
    });
    expect(harness.publishedEvents).toHaveLength(0);
    expect(harness.repoUpdates).toHaveLength(0);
  });

  it("emits PathRelationReinforced and updates plasticity_state when a path's anchor is in a `used` receipt", async () => {
    const path = createPath({ plasticity_state: { strength: 0.4, direction_bias: "source_to_target", stability_class: "normal", support_events_count: 2, contradiction_events_count: 0 } });
    const harness = buildHarness({
      usageRecords: [createUsageRecord({ used_object_ids: ["obj-target"] })],
      pathsByObjectId: { "obj-target": [path] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.reinforced).toBe(1);
    expect(result.affectedPathIds).toEqual(["path-1"]);

    const reinforcedEvent = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_REINFORCED
    );
    expect(reinforcedEvent).toBeDefined();
    expect(reinforcedEvent?.payload_json).toMatchObject({
      path_id: "path-1",
      previous_strength: 0.4,
      new_strength: 0.4 + PATH_PLASTICITY_CONSTANTS.USED_DELTA,
      support_events_count: 3,
      reinforced_at: NOW_ISO
    });

    expect(harness.repoUpdates).toHaveLength(1);
    expect(harness.repoUpdates[0]?.updates.plasticity_state).toMatchObject({
      strength: 0.4 + PATH_PLASTICITY_CONSTANTS.USED_DELTA,
      support_events_count: 3,
      last_reinforced_at: NOW_ISO
    });
  });

  it("emits PathRelationRedirected before reinforcement and mutates direction_bias when target-anchor usage reverses the current bias", async () => {
    const path = createPath({
      plasticity_state: {
        strength: 0.4,
        direction_bias: "target_to_source",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0
      }
    });
    const harness = buildHarness({
      usageRecords: [
        createUsageRecord({
          used_object_ids: [],
          per_anchor_usage: [{ object_id: "obj-target", anchor_role: "target" }]
        })
      ],
      pathsByObjectId: { "obj-target": [path] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.reinforced).toBe(1);
    expect(result.affectedPathIds).toEqual(["path-1"]);
    expect(harness.publishedEvents.map((event) => event.event_type)).toEqual([
      RuntimeGovernanceEventType.PATH_RELATION_REDIRECTED,
      RuntimeGovernanceEventType.PATH_RELATION_REINFORCED
    ]);
    expect(harness.publishedEvents[0]?.payload_json).toMatchObject({
      path_id: "path-1",
      previous_direction_bias: "target_to_source",
      new_direction_bias: "source_to_target",
      source_usage_count: 0,
      target_usage_count: 1,
      redirected_at: NOW_ISO
    });
    expect(harness.repoUpdates).toHaveLength(1);
    expect(harness.repoUpdates[0]?.updates.plasticity_state).toMatchObject({
      strength: 0.4 + PATH_PLASTICITY_CONSTANTS.USED_DELTA,
      direction_bias: "source_to_target",
      support_events_count: 1
    });
  });

  it.each([
    {
      name: "source-anchor usage selects target_to_source",
      initialBias: "source_to_target",
      perAnchorUsage: [{ object_id: "obj-source", anchor_role: "source" }],
      expectedBias: "target_to_source",
      sourceUsageCount: 1,
      targetUsageCount: 0
    },
    {
      name: "balanced source and target usage selects bidirectional_asymmetric",
      initialBias: "source_to_target",
      perAnchorUsage: [
        { object_id: "obj-source", anchor_role: "source" },
        { object_id: "obj-target", anchor_role: "target" }
      ],
      expectedBias: "bidirectional_asymmetric",
      sourceUsageCount: 1,
      targetUsageCount: 1
    }
  ] as const)("redirects direction_bias when $name", async (row) => {
    const path = createPath({
      plasticity_state: {
        strength: 0.4,
        direction_bias: row.initialBias,
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0
      }
    });
    const harness = buildHarness({
      usageRecords: [
        createUsageRecord({
          used_object_ids: [],
          per_anchor_usage: row.perAnchorUsage
        })
      ],
      pathsByObjectId: {
        "obj-source": [path],
        "obj-target": [path]
      }
    });

    await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    const redirectedEvent = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_REDIRECTED
    );
    expect(redirectedEvent?.payload_json).toMatchObject({
      previous_direction_bias: row.initialBias,
      new_direction_bias: row.expectedBias,
      source_usage_count: row.sourceUsageCount,
      target_usage_count: row.targetUsageCount
    });
    expect(harness.repoUpdates[0]?.updates.plasticity_state).toMatchObject({
      direction_bias: row.expectedBias
    });
  });

  it("does not emit PathRelationRedirected when per-anchor usage agrees with the current bias", async () => {
    const path = createPath({
      plasticity_state: {
        strength: 0.4,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0
      }
    });
    const harness = buildHarness({
      usageRecords: [
        createUsageRecord({
          used_object_ids: ["obj-target"],
          per_anchor_usage: [{ object_id: "obj-target", anchor_role: "target" }]
        })
      ],
      pathsByObjectId: { "obj-target": [path] }
    });

    await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(
      harness.publishedEvents.some(
        (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_REDIRECTED
      )
    ).toBe(false);
    expect(harness.repoUpdates[0]?.updates.plasticity_state).toMatchObject({
      direction_bias: "source_to_target"
    });
  });

  it("emits PathRelationWeakened and decrements strength when a delivery is `skipped`", async () => {
    const path = createPath({ plasticity_state: { strength: 0.5, direction_bias: "source_to_target", stability_class: "normal", support_events_count: 0, contradiction_events_count: 0 } });
    const harness = buildHarness({
      usageRecords: [createUsageRecord({ usage_state: "skipped", used_object_ids: [] })],
      pathsByObjectId: { "obj-target": [path] },
      deliveredObjectIdsByDeliveryId: { "delivery-1": ["obj-target"] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.weakened).toBe(1);
    expect(result.retired).toBe(0);

    const weakenedEvent = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_WEAKENED
    );
    expect(weakenedEvent).toBeDefined();
    expect(weakenedEvent?.payload_json).toMatchObject({
      path_id: "path-1",
      previous_strength: 0.5,
      new_strength: 0.5 - PATH_PLASTICITY_CONSTANTS.SKIPPED_DELTA,
      reason: "skipped_usage",
      weakened_at: NOW_ISO
    });

    expect(harness.repoUpdates[0]?.updates.plasticity_state).toMatchObject({
      strength: 0.5 - PATH_PLASTICITY_CONSTANTS.SKIPPED_DELTA,
      last_weakened_at: NOW_ISO
    });
    expect(harness.repoUpdates[0]?.updates.lifecycle).toMatchObject({
      status: "active"
    });
  });

  it.each(["skipped", "not_applicable"] as const)(
    "ignores synthesis-only delivered objects for %s fallback plasticity",
    async (usageState) => {
      const path = createPath({
        path_id: "path-shared-object",
        anchors: {
          source_anchor: { kind: "object", object_id: "shared-object" },
          target_anchor: { kind: "object", object_id: "other-object" }
        }
      });
      const harness = buildHarness({
        usageRecords: [
          createUsageRecord({
            delivery_id: "delivery-synthesis-only",
            usage_state: usageState,
            used_object_ids: []
          })
        ],
        pathsByObjectId: { "shared-object": [path] },
        deliveredObjectIdsByDeliveryId: { "delivery-synthesis-only": ["shared-object"] },
        deliveredObjectsByDeliveryId: {
          "delivery-synthesis-only": [
            { object_id: "shared-object", object_kind: "synthesis_capsule" }
          ]
        }
      });

      const result = await harness.service.computeAndApplyPlasticity({
        workspaceId: "workspace-1",
        sinceIso: "2026-05-03T00:00:00.000Z"
      });

      expect(result).toMatchObject({
        reinforced: 0,
        weakened: 0,
        retired: 0,
        affectedPathIds: []
      });
      expect(harness.usageReader.findDeliveredObjects).toHaveBeenCalledWith(
        "delivery-synthesis-only"
      );
      expect(harness.usageReader.findDeliveredObjectIds).not.toHaveBeenCalled();
      expect(harness.repoUpdates).toEqual([]);
      expect(harness.publishedEvents).toEqual([]);
    }
  );

  it("ignores synthesis per-anchor usage for used path plasticity", async () => {
    // direction_bias target_to_source makes the test non-tautological: an
    // UNFILTERED synthesis target-anchor usage would reverse the bias and
    // emit PathRelationRedirected (see the redirect test above), so the
    // empty-events assertion only holds because resolveDirectionalPathUsage
    // filters synthesis_capsule per-anchor usage out.
    const path = createPath({
      path_id: "path-synthesis-anchor",
      plasticity_state: {
        strength: 0.5,
        direction_bias: "target_to_source",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0
      }
    });
    const harness = buildHarness({
      usageRecords: [
        createUsageRecord({
          usage_state: "used",
          used_object_ids: [],
          per_anchor_usage: [
            {
              object_id: "obj-target",
              object_kind: "synthesis_capsule",
              anchor_role: "target"
            }
          ]
        })
      ],
      pathsByObjectId: { "obj-target": [path] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.affectedPathIds).toEqual([]);
    expect(harness.repoUpdates).toEqual([]);
    expect(harness.publishedEvents).toEqual([]);
  });

  it("emits PathRelationRetired when a skipped receipt drops strength to the threshold and the path has been inactive for more than the retirement window", async () => {
    const path = createPath({
      plasticity_state: {
        strength: 0.05, // already at threshold; one skip will keep it ≤ threshold
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0,
        last_reinforced_at: PAST_REINFORCED_ISO
      }
    });
    const harness = buildHarness({
      usageRecords: [createUsageRecord({ usage_state: "skipped", used_object_ids: [] })],
      pathsByObjectId: { "obj-target": [path] },
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
      path_id: "path-1",
      // R3d acceptance #5: the importance gate stamps its verdict onto the
      // retirement_reason. A thin/mergeable path retires cleanly with gate=mergeable.
      retirement_reason: "strength_below_threshold_and_inactive; gate=mergeable",
      retired_at: NOW_ISO
    });
    expect(harness.repoUpdates[0]?.updates.lifecycle).toMatchObject({
      status: "retired"
    });
  });

  it("redteam-I1 + reviewer-I3: a NON-mergeable (strictly-governed) idle negative path goes DORMANT (reversible), NEVER terminally retires", async () => {
    // A strictly-governed path classifies as report_only (NOT mergeable). Even
    // when it is neutral/negative family and idle past the retirement window, it
    // must NOT terminally retire (which would lose its live suppression). It is
    // routed to reversible dormancy instead. see shouldRouteToDormant.
    const path = createPath({
      path_id: "path-governed",
      plasticity_state: {
        strength: 0.05,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0,
        last_reinforced_at: PAST_REINFORCED_ISO
      },
      legitimacy: {
        evidence_basis: ["evidence-1"],
        governance_class: "strictly_governed"
      }
    });
    const harness = buildHarness({
      usageRecords: [createUsageRecord({ usage_state: "skipped", used_object_ids: [] })],
      pathsByObjectId: { "obj-target": [path] },
      deliveredObjectIdsByDeliveryId: { "delivery-1": ["obj-target"] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.retired).toBe(0);
    expect(result.dormant).toBe(1);
    const retiredEvent = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_RETIRED
    );
    expect(retiredEvent).toBeUndefined();
    const dormantEvent = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_DORMANT
    );
    expect(dormantEvent?.payload_json).toMatchObject({ path_id: "path-governed" });
    expect(harness.repoUpdates[0]?.updates.lifecycle).toMatchObject({ status: "dormant" });
  });

  it("emits PathRelationWeakened (not Retired) when strength drops to the threshold but the path was reinforced inside the retirement window", async () => {
    const path = createPath({
      plasticity_state: {
        strength: 0.05,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0,
        last_reinforced_at: RECENT_REINFORCED_ISO
      }
    });
    const harness = buildHarness({
      usageRecords: [createUsageRecord({ usage_state: "skipped", used_object_ids: [] })],
      pathsByObjectId: { "obj-target": [path] },
      deliveredObjectIdsByDeliveryId: { "delivery-1": ["obj-target"] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.weakened).toBe(1);
    expect(result.retired).toBe(0);
  });

  it("treats `not_applicable` as a contradiction-only signal: no strength delta, contradiction_events_count incremented, weakened audit event emitted", async () => {
    const path = createPath({
      plasticity_state: {
        strength: 0.5,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 1,
        contradiction_events_count: 0
      }
    });
    const harness = buildHarness({
      usageRecords: [createUsageRecord({ usage_state: "not_applicable", used_object_ids: [] })],
      pathsByObjectId: { "obj-target": [path] },
      deliveredObjectIdsByDeliveryId: { "delivery-1": ["obj-target"] }
    });

    await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    const weakenedEvent = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_WEAKENED
    );
    expect(weakenedEvent?.payload_json).toMatchObject({
      previous_strength: 0.5,
      new_strength: 0.5,
      reason: "not_applicable_recurrence"
    });
    expect(harness.repoUpdates[0]?.updates.plasticity_state).toMatchObject({
      strength: 0.5,
      contradiction_events_count: 1
    });
  });

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
