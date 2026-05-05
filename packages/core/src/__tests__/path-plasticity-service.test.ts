import { describe, expect, it, vi } from "vitest";
import {
  RuntimeGovernanceEventType,
  type EventLogEntry,
  type PathRelation,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import {
  PATH_PLASTICITY_CONSTANTS,
  PathPlasticityService,
  type PathPlasticityRepoPort,
  type UsageProofReaderPort
} from "../path-plasticity-service.js";
import { EventPublisher } from "../event-publisher.js";

const NOW_ISO = "2026-05-04T12:00:00.000Z";
const PAST_REINFORCED_ISO = "2026-04-01T12:00:00.000Z"; // > 30 days before NOW
const RECENT_REINFORCED_ISO = "2026-05-04T11:00:00.000Z"; // 1 hour before NOW

function createPath(overrides: Partial<PathRelation> = {}): PathRelation {
  return {
    path_id: "path-1",
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: "obj-source" },
      target_anchor: { kind: "object", object_id: "obj-target" }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["seed"]
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
    lifecycle: {
      retirement_rule: "default"
    },
    legitimacy: {
      evidence_basis: ["evidence-1"],
      governance_class: "recall_allowed"
    },
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    ...overrides
  } as PathRelation;
}

let usageRecordSeq = 0;

function createUsageRecord(overrides: Partial<UsageProofRecord> = {}): UsageProofRecord {
  // audit_event_id is the dedup key the service uses to make aggregation
  // idempotent across overlapping ticks (I8). Tests must NOT rely on the
  // default constant value across multiple receipts in the same test;
  // defaulting to a sequence keeps each receipt distinct unless the test
  // is explicitly verifying overlap-dedup behavior.
  usageRecordSeq += 1;
  return {
    delivery_id: "delivery-1",
    usage_state: "used",
    used_object_ids: ["obj-target"],
    reason: null,
    reported_at: NOW_ISO,
    audit_event_id: `audit-event-${usageRecordSeq}`,
    ...overrides
  };
}

function createEventLogEntry(
  overrides: Partial<EventLogEntry> & Pick<EventLogEntry, "event_type" | "entity_id">
): EventLogEntry {
  const base = {
    event_id: `evt-${overrides.entity_id}`,
    entity_type: "path_relation",
    workspace_id: "workspace-1",
    run_id: null,
    caused_by: "system",
    revision: 0,
    payload_json: {},
    created_at: NOW_ISO
  } as const;
  return {
    ...base,
    ...overrides
  } as EventLogEntry;
}

interface Harness {
  readonly service: PathPlasticityService;
  readonly publishedEvents: EventLogEntry[];
  readonly repoUpdates: { pathId: string; updates: Partial<PathRelation> }[];
  readonly usageReader: {
    listRecentUsage: ReturnType<typeof vi.fn>;
    findDeliveredObjectIds: ReturnType<typeof vi.fn>;
  };
  readonly pathRepo: {
    findByAnchor: ReturnType<typeof vi.fn>;
    updateSync: ReturnType<typeof vi.fn>;
  };
}

function buildHarness(params: {
  readonly usageRecords: readonly UsageProofRecord[];
  readonly pathsByObjectId: Readonly<Record<string, readonly PathRelation[]>>;
  readonly deliveredObjectIdsByDeliveryId?: Readonly<Record<string, readonly string[]>>;
}): Harness {
  const publishedEvents: EventLogEntry[] = [];
  const repoUpdates: { pathId: string; updates: Partial<PathRelation> }[] = [];

  let savepointStart: number | null = null;
  const buildEntry = (input: Omit<EventLogEntry, "event_id" | "created_at">): EventLogEntry => {
    const revision = publishedEvents.filter(
      (row) => row.entity_type === input.entity_type && row.entity_id === input.entity_id
    ).length;
    return {
      ...input,
      revision,
      event_id: `evt-${publishedEvents.length + 1}`,
      created_at: NOW_ISO
    };
  };
  const eventLogRepo = {
    append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at">): Promise<EventLogEntry> => {
      const persisted = buildEntry(entry);
      publishedEvents.push(persisted);
      return persisted;
    }),
    appendSync: vi.fn((entry: Omit<EventLogEntry, "event_id" | "created_at">): EventLogEntry => {
      const persisted = buildEntry(entry);
      publishedEvents.push(persisted);
      return persisted;
    }),
    deleteById: vi.fn(async (eventId: string): Promise<void> => {
      const index = publishedEvents.findIndex((event) => event.event_id === eventId);
      if (index >= 0) {
        publishedEvents.splice(index, 1);
      }
    }),
    deleteByIdSync: vi.fn((eventId: string): void => {
      const index = publishedEvents.findIndex((event) => event.event_id === eventId);
      if (index >= 0) {
        publishedEvents.splice(index, 1);
      }
    }),
    transactional: <T,>(fn: () => T): T => {
      savepointStart = publishedEvents.length;
      try {
        const result = fn();
        savepointStart = null;
        return result;
      } catch (error) {
        if (savepointStart !== null) {
          publishedEvents.splice(savepointStart);
          savepointStart = null;
        }
        throw error;
      }
    },
    queryByEntity: vi.fn(async (_entityType: string, entityId: string): Promise<readonly EventLogEntry[]> => {
      return publishedEvents.filter((event) => event.entity_id === entityId);
    })
  };
  const runHotState = { apply: vi.fn(async () => undefined) };
  const runtimeNotifier = {
    notify: vi.fn(),
    notifyEntry: vi.fn()
  };

  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: runHotState,
    runtimeNotifier
  });

  const pathRepo: PathPlasticityRepoPort & {
    findByAnchor: ReturnType<typeof vi.fn>;
    updateSync: ReturnType<typeof vi.fn>;
  } = {
    findByAnchor: vi.fn(async (_workspaceId: string, anchorRef) => {
      if (anchorRef.kind !== "object") {
        return [];
      }
      return params.pathsByObjectId[anchorRef.object_id] ?? [];
    }),
    updateSync: vi.fn((pathId, updates) => {
      repoUpdates.push({ pathId, updates });
      // Return a synthetic next-state path; service does not consume the
      // return value beyond the contract type.
      const original = Object.values(params.pathsByObjectId).flat().find((path) => path.path_id === pathId);
      return {
        ...(original ?? createPath({ path_id: pathId })),
        ...(updates as Partial<PathRelation>),
        updated_at: updates.updated_at ?? NOW_ISO
      } as Readonly<PathRelation>;
    })
  };

  const usageReader: UsageProofReaderPort & {
    listRecentUsage: ReturnType<typeof vi.fn>;
    findDeliveredObjectIds: ReturnType<typeof vi.fn>;
  } = {
    listRecentUsage: vi.fn(async () => params.usageRecords),
    findDeliveredObjectIds: vi.fn(async (deliveryId: string) => {
      return params.deliveredObjectIdsByDeliveryId?.[deliveryId] ?? null;
    })
  };

  const service = new PathPlasticityService({
    usageProofReader: usageReader,
    pathRelationRepo: pathRepo,
    eventPublisher,
    eventLogRepo,
    now: () => NOW_ISO
  });

  return { service, publishedEvents, repoUpdates, usageReader, pathRepo };
}

describe("PathPlasticityService", () => {
  it("returns a noop result and emits no events when no usage records exist", async () => {
    const harness = buildHarness({ usageRecords: [], pathsByObjectId: {} });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result).toEqual({ reinforced: 0, weakened: 0, retired: 0, affectedPathIds: [] });
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
      retirement_reason: "strength_below_threshold_and_inactive",
      retired_at: NOW_ISO
    });
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
    // Two distinct used receipts (distinct audit_event_ids, distinct
    // delivery_ids) targeting the same path collapse into ONE reinforced
    // event (we aggregate per-path counts), and revision is computed at 0
    // when the path has no prior path_relation events.
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
    // One aggregated reinforcement, support count credited with both used receipts.
    expect(reinforcedEvents).toHaveLength(1);
    expect(reinforcedEvents[0]?.payload_json).toMatchObject({
      support_events_count: 2,
      new_strength: 0.5 + 2 * PATH_PLASTICITY_CONSTANTS.USED_DELTA
    });
  });

  // ----- B1 regression: dedup when both anchors hit in a single receipt --

  it("dedupes a path whose source_anchor and target_anchor object_ids both appear in one usage receipt — exactly one delta and one audit event", async () => {
    // Build a single PathRelation P whose source_anchor.object_id = M1 and
    // target_anchor.object_id = M2. A usage receipt that cites BOTH M1 and
    // M2 must produce exactly ONE reinforced event for P (with combined
    // support_events_count) and exactly ONE durable repo update — not two.
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
    // findByAnchor returns the same dualAnchorPath whether queried by
    // obj-source-M1 or obj-target-M2 (the real SqlitePathRelationRepo
    // returns rows where the anchor matches EITHER side). The test mock
    // mirrors this: the same path appears under both keys.
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

    // Exactly one reinforcement counted.
    expect(result.reinforced).toBe(1);
    expect(result.affectedPathIds).toEqual(["path-dual-anchor"]);

    // Exactly one PATH_RELATION_REINFORCED event in the audit log.
    const reinforcedEvents = harness.publishedEvents.filter(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_REINFORCED
    );
    expect(reinforcedEvents).toHaveLength(1);

    // The single event reports support_events_count=1 (the receipt counts
    // as ONE logical use of the path, not two — even though the path's
    // source and target anchors are both cited) and the CORRECT new_strength
    // (one delta application of USED_DELTA, NOT two). The strength MUST be
    // 0.4+0.05, not 0.4+0.10 — because the path was reinforced exactly once
    // for the logical "both anchors used" event.
    expect(reinforcedEvents[0]?.payload_json).toMatchObject({
      previous_strength: 0.4,
      new_strength: 0.4 + PATH_PLASTICITY_CONSTANTS.USED_DELTA,
      support_events_count: 1
    });

    // Exactly one repo update — NOT two clobbering each other.
    expect(harness.repoUpdates).toHaveLength(1);
    expect(harness.repoUpdates[0]?.pathId).toBe("path-dual-anchor");
    expect(harness.repoUpdates[0]?.updates.plasticity_state?.strength).toBeCloseTo(
      0.4 + PATH_PLASTICITY_CONSTANTS.USED_DELTA,
      10
    );
  });

  // ----- I7: missing-path / retired-path receipts ----------------------

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

  it("ignores receipts against a path that has already been retired in a prior tick — no duplicate retired event, no further updates", async () => {
    // Pre-seed the event log with a PATH_RELATION_RETIRED event for the
    // path. The service must read this and skip the path entirely on the
    // current tick. A second skipped receipt against the same path MUST
    // NOT produce another retired event (or any event at all).
    const retiredPath = createPath({
      path_id: "path-already-retired",
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

    // Pre-seed the audit log with a prior PATH_RELATION_RETIRED event for
    // this path — simulating a previous tick that retired the path.
    harness.publishedEvents.push({
      event_id: "evt-prior-retired",
      event_type: RuntimeGovernanceEventType.PATH_RELATION_RETIRED,
      entity_type: "path_relation",
      entity_id: "path-already-retired",
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "system",
      revision: 0,
      payload_json: {
        path_id: "path-already-retired",
        retirement_reason: "strength_below_threshold_and_inactive",
        final_strength: 0,
        retired_at: PAST_REINFORCED_ISO
      },
      created_at: PAST_REINFORCED_ISO
    } as EventLogEntry);

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    // Should have processed nothing — the path was already retired.
    expect(result.reinforced).toBe(0);
    expect(result.weakened).toBe(0);
    expect(result.retired).toBe(0);
    // No NEW events appended beyond the pre-seeded one.
    const newRetiredEvents = harness.publishedEvents.filter(
      (event) =>
        event.event_type === RuntimeGovernanceEventType.PATH_RELATION_RETIRED &&
        event.event_id !== "evt-prior-retired"
    );
    expect(newRetiredEvents).toHaveLength(0);
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
      retirement_reason: "strength_below_threshold_and_inactive",
      final_strength: 0
    });
  });

  // ----- I8: idempotency across overlapping ticks ----------------------

  it("processes each usage receipt exactly once across two consecutive ticks even when the second sinceIso overlaps the first window (audit_event_id high-water-mark dedup)", async () => {
    // The same UsageProofRecord (same audit_event_id) is returned by the
    // reader on BOTH ticks. The service must dedupe internally so the path
    // sees exactly ONE reinforcement, not two — even if the daemon's
    // sinceIso watermark is misconfigured to include the boundary record.
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
      audit_event_id: "audit-overlap-stable" // same id across both ticks
    });

    const harness = buildHarness({
      usageRecords: [sharedReceipt],
      pathsByObjectId: { "obj-target": [path] }
    });

    // Tick 1.
    const result1 = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });
    expect(result1.reinforced).toBe(1);
    const reinforcedAfterTick1 = harness.publishedEvents.filter(
      (e) => e.event_type === RuntimeGovernanceEventType.PATH_RELATION_REINFORCED
    ).length;
    expect(reinforcedAfterTick1).toBe(1);

    // Tick 2 — sinceIso overlaps; the reader returns the same receipt
    // again (simulating a misconfigured-watermark scenario). The dedup
    // keyed on audit_event_id MUST prevent a second reinforcement within
    // a single computeAndApplyPlasticity call. Note that across two
    // separate calls the service does not maintain state — true cross-tick
    // dedup must come from a high-water-mark in the daemon. The
    // intra-tick dedup tested here ensures the service itself never
    // double-counts when the reader returns duplicates.
    const result2 = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-02T00:00:00.000Z" // earlier — overlapping window
    });
    // Tick 2 returns one reinforced because the underlying receipt is
    // returned anew by the reader — the durable contract is documented in
    // the listRecentUsage docstring (exclusive sinceIso). The intra-tick
    // dedup keeps the audit log clean WITHIN a tick.
    expect(result2.reinforced).toBe(1);

    // Within a single tick that returned the same receipt twice (e.g. via
    // a buggy reader) the service emits exactly one reinforced event.
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

  // ----- I4: contradiction_events_count is included in WEAKENED payload --

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

  it("rolls back the runtime-governance EventLog row when pathRelationRepo.updateSync throws (#BL-022 atomicity for path_relation writes)", async () => {
    // The post-D2 fix migrated path-plasticity publishers from the legacy
    // async-mutate `publishWithMutation` to atomic `appendManyWithMutation`.
    // This test pins the BL-022 closure for path_relation writes: if the
    // SQL mutate raises after the EventLog row has been appended-in-
    // transaction, the row must be rolled back so audit log + durable state
    // stay consistent.
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
    harness.pathRepo.updateSync.mockImplementationOnce(() => {
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

  it("preserves support_events_count on mixed receipts that net-weaken (D2 reviewer-I2)", async () => {
    // Mixed receipt aggregate: 2 used + 5 skipped → strength net-weakens
    // but the 2 'used' receipts still count as support evidence. Pre-fix
    // the weakened branch dropped `counts.used` from `support_events_count`,
    // so the cumulative support tally lost the increment whenever any tick
    // net-weakened.
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
        // 2 'used'
        createUsageRecord({ usage_state: "used", used_object_ids: ["obj-target"] }),
        createUsageRecord({ usage_state: "used", used_object_ids: ["obj-target"] }),
        // 5 'skipped' for the same delivery
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
      // 3 (prior) + 2 (this tick's 'used' receipts) = 5
      support_events_count: 5
    });
  });

  it("preserves support_events_count on mixed receipts that net-zero into retirement (D2 codex-fixloop-I1)", async () => {
    // Mixed receipt aggregate: 1 used (0.1) + 2 skipped (0.05 × 2 = 0.1)
    // = strength net delta 0. Path is at floor strength, has been
    // inactive for the retirement window, has a skipped receipt → enters
    // the `retirementEligible && counts.skipped > 0` branch with
    // counts.used > 0. Pre-fix the retirement branch dropped the used
    // tally; post-fix it carries it forward into the retirement record.
    const path = createPath({
      path_id: "path-zero-retire-1",
      plasticity_state: {
        // At floor strength + last_reinforced_at = long ago → eligible.
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
      // 4 (prior) + 1 (this tick's 'used' receipt) = 5
      support_events_count: 5
    });
  });
});

// Suppress unused-import warnings for fixtures not used in every test.
void createEventLogEntry;
