import { describe, expect, it, vi } from "vitest";
import { RuntimeGovernanceEventType, type PathRelation } from "@do-soul/alaya-protocol";
import { PATH_PLASTICITY_CONSTANTS } from "../../path-plasticity/index.js";
import {
  NOW_ISO,
  buildHarness,
  createPath,
  createUsageRecord
} from "./path-plasticity-service-test-fixtures.js";

describe("PathPlasticityService", () => {
  it("processes each usage receipt exactly once across two consecutive ticks even when the second sinceIso overlaps the first window (audit_event_id high-water-mark dedup)", async () => {
    // invariant: duplicate audit_event_id rows inside one compute call are
    // one logical usage receipt.
    const path = createPath({
      plasticity_state: {
        strength: 0.4,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0
      }
    });
    const sharedReceipt = createUsageRecord({
      delivery_id: "delivery-overlap",
      used_object_ids: ["obj-target"],
      audit_event_id: "audit-overlap-stable"
    });

    const harness = buildHarness({
      usageRecords: [sharedReceipt],
      pathsByObjectId: { "obj-target": [path] }
    });

    const result1 = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });
    expect(result1.reinforced).toBe(1);
    const reinforcedAfterTick1 = harness.publishedEvents.filter(
      (e) => e.event_type === RuntimeGovernanceEventType.PATH_RELATION_REINFORCED
    ).length;
    expect(reinforcedAfterTick1).toBe(1);

    const result2 = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-02T00:00:00.000Z"
    });
    expect(result2.reinforced).toBe(1);

    const harness3 = buildHarness({
      usageRecords: [sharedReceipt, sharedReceipt],
      pathsByObjectId: { "obj-target": [path] }
    });
    const result3 = await harness3.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });
    expect(result3.reinforced).toBe(1);
    const reinforcedTick3 = harness3.publishedEvents.filter(
      (e) => e.event_type === RuntimeGovernanceEventType.PATH_RELATION_REINFORCED
    ).length;
    expect(reinforcedTick3).toBe(1);
  });

  it("includes contradiction_events_count in PATH_RELATION_WEAKENED payload (symmetric with REINFORCED.support_events_count)", async () => {
    const path = createPath({
      plasticity_state: {
        strength: 0.5,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 2
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
      contradiction_events_count: 3
    });
  });

  it("rolls back the runtime-governance EventLog row when pathRelationRepo.update throws", async () => {
    // invariant: if the SQL mutate raises after the EventLog row is appended
    // in-transaction, the row rolls back with the durable state mutation.
    const path = createPath({ path_id: "path-roll-1" });
    const harness = buildHarness({
      pathsByObjectId: { "obj-target": [path] },
      usageRecords: [
        createUsageRecord({
          delivery_id: "delivery-roll",
          usage_state: "used",
          used_object_ids: ["obj-target"],
          reported_at: "2026-05-03T01:00:00.000Z"
        })
      ],
      deliveredObjectIdsByDeliveryId: { "delivery-roll": ["obj-target"] }
    });

    const failure = new Error("synthetic SQL failure inside transaction");
    harness.pathRepo.update.mockImplementationOnce(() => {
      throw failure;
    });

    await expect(
      harness.service.computeAndApplyPlasticity({
        workspaceId: "workspace-1",
        sinceIso: "2026-05-03T00:00:00.000Z"
      })
    ).rejects.toThrow(failure);

    // The PATH_RELATION_REINFORCED row appended inside the transaction must
    // be rolled back; nothing is durable.
    const reinforcedRows = harness.publishedEvents.filter(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_REINFORCED
    );
    expect(reinforcedRows).toEqual([]);
  });

  it("rolls back a whole usage window when a later path update throws, then applies the receipt once on retry", async () => {
    const pathA = createPath({
      path_id: "path-batch-a",
      anchors: {
        source_anchor: { kind: "object", object_id: "obj-a-source" },
        target_anchor: { kind: "object", object_id: "obj-a" }
      }
    });
    const pathB = createPath({
      path_id: "path-batch-b",
      anchors: {
        source_anchor: { kind: "object", object_id: "obj-b-source" },
        target_anchor: { kind: "object", object_id: "obj-b" }
      }
    });
    const harness = buildHarness({
      pathsByObjectId: {
        "obj-a": [pathA],
        "obj-b": [pathB]
      },
      usageRecords: [
        createUsageRecord({
          delivery_id: "delivery-batch-rollback",
          usage_state: "used",
          used_object_ids: ["obj-a", "obj-b"],
          reported_at: "2026-05-03T01:00:00.000Z"
        })
      ]
    });
    const defaultUpdate = harness.pathRepo.update.getMockImplementation();
    if (defaultUpdate === undefined) {
      throw new Error("test harness pathRepo.update must have a default implementation");
    }
    const failure = new Error("synthetic second path update failure");
    harness.pathRepo.update
      .mockImplementationOnce(defaultUpdate)
      .mockImplementationOnce(() => {
        throw failure;
      });

    await expect(
      harness.service.computeAndApplyPlasticity({
        workspaceId: "workspace-1",
        sinceIso: "2026-05-03T00:00:00.000Z",
        untilIso: "2026-05-03T02:00:00.000Z"
      })
    ).rejects.toThrow(failure);

    expect(harness.repoUpdates).toEqual([]);
    expect(harness.publishedEvents).toEqual([]);
    expect(harness.getPath("path-batch-a")?.plasticity_state.strength).toBe(0.5);
    expect(harness.getPath("path-batch-b")?.plasticity_state.strength).toBe(0.5);

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z",
      untilIso: "2026-05-03T02:00:00.000Z"
    });

    expect(result).toMatchObject({
      reinforced: 2,
      weakened: 0,
      retired: 0,
      affectedPathIds: ["path-batch-a", "path-batch-b"]
    });
    expect(harness.repoUpdates.map((update) => update.pathId)).toEqual([
      "path-batch-a",
      "path-batch-b"
    ]);
    expect(harness.publishedEvents.map((event) => event.entity_id)).toEqual([
      "path-batch-a",
      "path-batch-b"
    ]);
    expect(harness.publishedEvents).toHaveLength(2);
    expect(harness.getPath("path-batch-a")?.plasticity_state.strength).toBeCloseTo(
      0.5 + PATH_PLASTICITY_CONSTANTS.USED_DELTA,
      10
    );
    expect(harness.getPath("path-batch-b")?.plasticity_state.strength).toBeCloseTo(
      0.5 + PATH_PLASTICITY_CONSTANTS.USED_DELTA,
      10
    );
    expect(harness.getPath("path-batch-a")?.plasticity_state.support_events_count).toBe(1);
    expect(harness.getPath("path-batch-b")?.plasticity_state.support_events_count).toBe(1);
  });

  it("does not apply late path mutations after the compute abort signal fires", async () => {
    const path = createPath({ path_id: "path-abort-late-1" });
    const harness = buildHarness({
      pathsByObjectId: { "obj-target": [path] },
      usageRecords: [
        createUsageRecord({
          delivery_id: "delivery-abort-late",
          usage_state: "used",
          used_object_ids: ["obj-target"],
          reported_at: "2026-05-03T01:00:00.000Z"
        })
      ],
      deliveredObjectIdsByDeliveryId: { "delivery-abort-late": ["obj-target"] }
    });
    let resolveLookupStarted!: () => void;
    let resolveLookup!: (paths: readonly Readonly<PathRelation>[]) => void;
    const lookupStarted = new Promise<void>((resolve) => {
      resolveLookupStarted = resolve;
    });
    const lookupResult = new Promise<readonly Readonly<PathRelation>[]>((resolve) => {
      resolveLookup = resolve;
    });
    harness.pathRepo.findByAnchor.mockImplementationOnce(async () => {
      resolveLookupStarted();
      return await lookupResult;
    });

    const controller = new AbortController();
    const compute = harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z",
      untilIso: "2026-05-03T02:00:00.000Z",
      abortSignal: controller.signal
    });

    await lookupStarted;
    controller.abort(new Error("path_plasticity_update timed out after 5ms"));
    resolveLookup([path]);

    await expect(compute).rejects.toThrow("path_plasticity_update timed out after 5ms");
    expect(harness.repoUpdates).toEqual([]);
    expect(harness.publishedEvents).toEqual([]);
  });

  it("treats EventPublisher post-commit propagation failure as durable path plasticity success", async () => {
    const path = createPath({ path_id: "path-propagation-committed-1" });
    const notifyEntry = vi.fn(async () => {
      throw new Error("notify exploded after commit");
    });
    const harness = buildHarness({
      pathsByObjectId: { "obj-target": [path] },
      usageRecords: [
        createUsageRecord({
          delivery_id: "delivery-propagation-committed",
          usage_state: "used",
          used_object_ids: ["obj-target"],
          reported_at: "2026-05-03T01:00:00.000Z"
        })
      ],
      deliveredObjectIdsByDeliveryId: { "delivery-propagation-committed": ["obj-target"] },
      runtimeNotifier: { notifyEntry }
    });
    const onMutationBoundaryEntered = vi.fn();

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z",
      untilIso: "2026-05-03T02:00:00.000Z",
      onMutationBoundaryEntered
    });

    expect(result).toMatchObject({
      reinforced: 1,
      weakened: 0,
      retired: 0,
      affectedPathIds: ["path-propagation-committed-1"]
    });
    expect(onMutationBoundaryEntered).toHaveBeenCalledTimes(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(notifyEntry).toHaveBeenCalledTimes(1);
    expect(harness.repoUpdates).toHaveLength(1);
    expect(harness.publishedEvents).toHaveLength(1);
  });

  it("returns after durable path mutation when post-commit propagation never settles", async () => {
    const path = createPath({ path_id: "path-propagation-hung-1" });
    const notifyEntry = vi.fn(() => new Promise<void>(() => undefined));
    const harness = buildHarness({
      pathsByObjectId: { "obj-target": [path] },
      usageRecords: [
        createUsageRecord({
          delivery_id: "delivery-propagation-hung",
          usage_state: "used",
          used_object_ids: ["obj-target"],
          reported_at: "2026-05-03T01:00:00.000Z"
        })
      ],
      deliveredObjectIdsByDeliveryId: { "delivery-propagation-hung": ["obj-target"] },
      runtimeNotifier: { notifyEntry }
    });
    const onMutationBoundaryEntered = vi.fn();

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z",
      untilIso: "2026-05-03T02:00:00.000Z",
      onMutationBoundaryEntered
    });

    expect(result).toMatchObject({
      reinforced: 1,
      weakened: 0,
      retired: 0,
      affectedPathIds: ["path-propagation-hung-1"]
    });
    expect(onMutationBoundaryEntered).toHaveBeenCalledTimes(1);
    expect(harness.repoUpdates).toHaveLength(1);
    expect(harness.publishedEvents).toHaveLength(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(notifyEntry).toHaveBeenCalledTimes(1);
  });

  it("preserves support_events_count on mixed receipts that net-weaken", async () => {
    // invariant: used receipts remain support evidence even when skipped
    // receipts make the weighted strength delta net-weaken.
    const path = createPath({
      path_id: "path-mixed-1",
      plasticity_state: {
        strength: 0.5,
        direction_bias: "bidirectional_asymmetric",
        stability_class: "volatile",
        support_events_count: 3,
        contradiction_events_count: 0,
        last_reinforced_at: NOW_ISO,
        last_weakened_at: undefined
      }
    });
    const harness = buildHarness({
      pathsByObjectId: { "obj-target": [path] },
      usageRecords: [
        createUsageRecord({ usage_state: "used", used_object_ids: ["obj-target"] }),
        createUsageRecord({ usage_state: "used", used_object_ids: ["obj-target"] }),
        createUsageRecord({ usage_state: "skipped", used_object_ids: [] }),
        createUsageRecord({ usage_state: "skipped", used_object_ids: [] }),
        createUsageRecord({ usage_state: "skipped", used_object_ids: [] }),
        createUsageRecord({ usage_state: "skipped", used_object_ids: [] }),
        createUsageRecord({ usage_state: "skipped", used_object_ids: [] })
      ],
      deliveredObjectIdsByDeliveryId: { "delivery-1": ["obj-target"] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.weakened).toBe(1);
    const updated = harness.repoUpdates.find((entry) => entry.pathId === "path-mixed-1");
    expect(updated?.updates.plasticity_state).toMatchObject({
      support_events_count: 5
    });
  });

  it("preserves support_events_count on mixed receipts that net-zero into retirement", async () => {
    // invariant: a floor-strength path can retire on skipped receipts while
    // still carrying forward any used support seen in the same aggregate.
    const path = createPath({
      path_id: "path-zero-retire-1",
      plasticity_state: {
        strength: 0,
        direction_bias: "bidirectional_asymmetric",
        stability_class: "volatile",
        support_events_count: 4,
        contradiction_events_count: 0,
        last_reinforced_at: "2025-01-01T00:00:00.000Z",
        last_weakened_at: undefined
      }
    });
    const harness = buildHarness({
      pathsByObjectId: { "obj-target": [path] },
      usageRecords: [
        createUsageRecord({ usage_state: "used", used_object_ids: ["obj-target"] }),
        createUsageRecord({ usage_state: "skipped", used_object_ids: [] }),
        createUsageRecord({ usage_state: "skipped", used_object_ids: [] })
      ],
      deliveredObjectIdsByDeliveryId: { "delivery-1": ["obj-target"] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.retired).toBe(1);
    const updated = harness.repoUpdates.find((entry) => entry.pathId === "path-zero-retire-1");
    expect(updated?.updates.plasticity_state).toMatchObject({
      support_events_count: 5
    });
  });
});
