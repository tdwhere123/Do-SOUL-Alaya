import { describe, expect, it, vi } from "vitest";
import {
  RuntimeGovernanceEventType,
  type EventLogEntry,
  type PathRelation,
  type SoulContextObjectIdentity,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import {
  PATH_PLASTICITY_CONSTANTS,
  PathPlasticityService,
  type PathPlasticityRepoPort,
  type UsageProofReaderPort
} from "../path-plasticity-service.js";
import { EventPublisher, type RuntimeNotifier } from "../event-publisher.js";

const NOW_ISO = "2026-05-04T12:00:00.000Z";
const PAST_REINFORCED_ISO = "2026-04-01T12:00:00.000Z";
const RECENT_REINFORCED_ISO = "2026-05-04T11:00:00.000Z";

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
  // invariant: audit_event_id is the durable dedupe key. A generated
  // sequence keeps fixtures distinct unless a test overrides it.
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
    findDeliveredObjects: ReturnType<typeof vi.fn>;
  };
  readonly pathRepo: {
    findByAnchor: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  readonly getPath: (pathId: string) => Readonly<PathRelation> | undefined;
}

function buildHarness(params: {
  readonly usageRecords: readonly UsageProofRecord[];
  readonly pathsByObjectId: Readonly<Record<string, readonly PathRelation[]>>;
  readonly deliveredObjectIdsByDeliveryId?: Readonly<Record<string, readonly string[]>>;
  readonly deliveredObjectsByDeliveryId?: Readonly<Record<string, readonly SoulContextObjectIdentity[]>>;
  readonly runtimeNotifier?: Partial<RuntimeNotifier>;
}): Harness {
  const publishedEvents: EventLogEntry[] = [];
  const repoUpdates: { pathId: string; updates: Partial<PathRelation> }[] = [];
  const pathStateById = new Map<string, PathRelation>();
  for (const path of Object.values(params.pathsByObjectId).flat()) {
    pathStateById.set(path.path_id, path);
  }

  let eventSavepointStart: number | null = null;
  let repoUpdateSavepointStart: number | null = null;
  let pathStateSavepoint: Map<string, PathRelation> | null = null;
  const buildEntry = (input: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry => {
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
    append: vi.fn((entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry => {
      const persisted = buildEntry(entry);
      publishedEvents.push(persisted);
      return persisted;
    }),
    deleteById: vi.fn((eventId: string): void => {
      const index = publishedEvents.findIndex((event) => event.event_id === eventId);
      if (index >= 0) {
        publishedEvents.splice(index, 1);
      }
    }),
    transactional: <T,>(fn: () => T): T => {
      eventSavepointStart = publishedEvents.length;
      repoUpdateSavepointStart = repoUpdates.length;
      pathStateSavepoint = new Map(pathStateById);
      try {
        const result = fn();
        eventSavepointStart = null;
        repoUpdateSavepointStart = null;
        pathStateSavepoint = null;
        return result;
      } catch (error) {
        if (eventSavepointStart !== null) {
          publishedEvents.splice(eventSavepointStart);
          eventSavepointStart = null;
        }
        if (repoUpdateSavepointStart !== null) {
          repoUpdates.splice(repoUpdateSavepointStart);
          repoUpdateSavepointStart = null;
        }
        if (pathStateSavepoint !== null) {
          pathStateById.clear();
          for (const [pathId, path] of pathStateSavepoint.entries()) {
            pathStateById.set(pathId, path);
          }
          pathStateSavepoint = null;
        }
        throw error;
      }
    },
    queryByEntity: vi.fn(async (_entityType: string, entityId: string): Promise<readonly EventLogEntry[]> => {
      return publishedEvents.filter((event) => event.entity_id === entityId);
    })
  };
  const runHotState = { apply: vi.fn(async () => undefined) };
  const runtimeNotifier: RuntimeNotifier = {
    notify: params.runtimeNotifier?.notify ?? vi.fn(() => undefined),
    notifyEntry: params.runtimeNotifier?.notifyEntry ?? vi.fn(() => undefined)
  };

  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: runHotState,
    runtimeNotifier
  });

  const pathRepo: PathPlasticityRepoPort & {
    findByAnchor: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  } = {
    findByAnchor: vi.fn(async (_workspaceId: string, anchorRef) => {
      if (anchorRef.kind !== "object") {
        return [];
      }
      return (params.pathsByObjectId[anchorRef.object_id] ?? []).map(
        (path) => pathStateById.get(path.path_id) ?? path
      );
    }),
    update: vi.fn((pathId, updates) => {
      repoUpdates.push({ pathId, updates });
      const original = pathStateById.get(pathId) ?? createPath({ path_id: pathId });
      const updatedPath = {
        ...(original ?? createPath({ path_id: pathId })),
        ...(updates as Partial<PathRelation>),
        updated_at: updates.updated_at ?? NOW_ISO
      } as Readonly<PathRelation>;
      pathStateById.set(pathId, updatedPath as PathRelation);
      return updatedPath;
    })
  };

  const usageReader: UsageProofReaderPort & {
    listRecentUsage: ReturnType<typeof vi.fn>;
    findDeliveredObjectIds: ReturnType<typeof vi.fn>;
    findDeliveredObjects: ReturnType<typeof vi.fn>;
  } = {
    listRecentUsage: vi.fn(async () => params.usageRecords),
    findDeliveredObjectIds: vi.fn(async (deliveryId: string) => {
      return params.deliveredObjectIdsByDeliveryId?.[deliveryId] ?? null;
    }),
    findDeliveredObjects: vi.fn(async (deliveryId: string) => {
      return params.deliveredObjectsByDeliveryId?.[deliveryId] ?? null;
    })
  };

  const service = new PathPlasticityService({
    usageProofReader: usageReader,
    pathRelationRepo: pathRepo,
    eventPublisher,
    eventLogRepo,
    now: () => NOW_ISO
  });

  return {
    service,
    publishedEvents,
    repoUpdates,
    usageReader,
    pathRepo,
    getPath: (pathId) => pathStateById.get(pathId)
  };
}

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
      retirement_reason: "strength_below_threshold_and_inactive",
      retired_at: NOW_ISO
    });
    expect(harness.repoUpdates[0]?.updates.lifecycle).toMatchObject({
      status: "retired"
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
      retirement_reason: "strength_below_threshold_and_inactive",
      final_strength: 0
    });
    expect(harness.repoUpdates[0]?.updates.lifecycle).toMatchObject({
      status: "retired"
    });
  });

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

describe("PathPlasticityService dormant lifecycle (active <-> dormant + revive)", () => {
  const POSITIVE_FAMILY_BIAS = 0.3;
  const NEGATIVE_FAMILY_BIAS = -0.4;

  function positiveFamilyEffectVector(salience: number): PathRelation["effect_vector"] {
    return {
      salience,
      recall_bias: POSITIVE_FAMILY_BIAS,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "stance_bias"
    };
  }

  it("goes dormant (not retired) when a positive-associative path decays to the threshold while inactive: salience cleared, row kept (not deleted)", async () => {
    const path = createPath({
      effect_vector: positiveFamilyEffectVector(0.5),
      plasticity_state: {
        strength: 0.05,
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

    expect(result.dormant).toBe(1);
    expect(result.retired).toBe(0);
    expect(result.weakened).toBe(0);

    // The skip decays strength 0.05 -> 0; the path then goes dormant at that
    // decayed strength (dormant does not invent a separate strength value).
    const dormantEvent = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_DORMANT
    );
    expect(dormantEvent).toBeDefined();
    expect(dormantEvent?.payload_json).toMatchObject({
      path_id: "path-1",
      dormancy_reason: "strength_below_threshold_and_inactive",
      dormant_strength: 0,
      dormant_at: NOW_ISO
    });

    // status flips to dormant, salience cleared, row retained (update, not delete).
    expect(harness.repoUpdates).toHaveLength(1);
    expect(harness.repoUpdates[0]?.updates.lifecycle).toMatchObject({ status: "dormant" });
    expect(harness.repoUpdates[0]?.updates.effect_vector).toMatchObject({ salience: 0 });
    // strength reflects the post-decay value; the row is updated in place, never deleted.
    expect(harness.repoUpdates[0]?.updates.plasticity_state?.strength).toBe(0);
    // The path row still exists in the repo state after dormancy (kept in DB).
    expect(harness.getPath("path-1")).toBeDefined();
    expect(harness.getPath("path-1")?.lifecycle.status).toBe("dormant");
  });

  it("revives a dormant positive path back to active on a used receipt: strength reset to REVIVE_STRENGTH, salience restored, revived audit event", async () => {
    const dormantPath = createPath({
      effect_vector: positiveFamilyEffectVector(0),
      lifecycle: {
        status: "dormant",
        retirement_rule: "default"
      } as unknown as PathRelation["lifecycle"],
      plasticity_state: {
        strength: 0.05,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 1,
        contradiction_events_count: 0,
        last_weakened_at: PAST_REINFORCED_ISO
      }
    });
    const harness = buildHarness({
      usageRecords: [createUsageRecord({ used_object_ids: ["obj-target"] })],
      pathsByObjectId: { "obj-target": [dormantPath] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.revived).toBe(1);
    expect(result.reinforced).toBe(0);

    const revivedEvent = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_REVIVED
    );
    expect(revivedEvent).toBeDefined();
    expect(revivedEvent?.payload_json).toMatchObject({
      path_id: "path-1",
      revive_trigger: "used_receipt",
      previous_strength: 0.05,
      new_strength: PATH_PLASTICITY_CONSTANTS.REVIVE_STRENGTH,
      revived_at: NOW_ISO
    });

    expect(harness.repoUpdates).toHaveLength(1);
    expect(harness.repoUpdates[0]?.updates.lifecycle).toMatchObject({ status: "active" });
    expect(harness.repoUpdates[0]?.updates.plasticity_state?.strength).toBe(
      PATH_PLASTICITY_CONSTANTS.REVIVE_STRENGTH
    );
    // salience restored to the revive strength so the path re-enters recall.
    expect(harness.repoUpdates[0]?.updates.effect_vector).toMatchObject({
      salience: PATH_PLASTICITY_CONSTANTS.REVIVE_STRENGTH
    });
  });

  it("does NOT revive a dormant path on a skipped-only receipt (no used signal)", async () => {
    const dormantPath = createPath({
      effect_vector: positiveFamilyEffectVector(0),
      lifecycle: {
        status: "dormant",
        retirement_rule: "default"
      } as unknown as PathRelation["lifecycle"],
      plasticity_state: {
        strength: 0.05,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0,
        last_weakened_at: PAST_REINFORCED_ISO
      }
    });
    const harness = buildHarness({
      usageRecords: [createUsageRecord({ usage_state: "skipped", used_object_ids: [] })],
      pathsByObjectId: { "obj-target": [dormantPath] },
      deliveredObjectIdsByDeliveryId: { "delivery-1": ["obj-target"] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.revived).toBe(0);
    // A dormant path is not re-retired/re-dormant by a skip; it remains dormant.
    const revivedEvent = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_REVIVED
    );
    expect(revivedEvent).toBeUndefined();
    expect(harness.getPath("path-1")?.lifecycle.status).toBe("dormant");
  });

  it("retires (NOT dormant) a negative-family path that decays to the threshold while inactive", async () => {
    const negativePath = createPath({
      effect_vector: {
        salience: 0.5,
        recall_bias: NEGATIVE_FAMILY_BIAS,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "stance_bias"
      },
      plasticity_state: {
        strength: 0.05,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0,
        last_reinforced_at: PAST_REINFORCED_ISO
      }
    });
    const harness = buildHarness({
      usageRecords: [createUsageRecord({ usage_state: "skipped", used_object_ids: [] })],
      pathsByObjectId: { "obj-target": [negativePath] },
      deliveredObjectIdsByDeliveryId: { "delivery-1": ["obj-target"] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    // Negative family follows the existing terminal-retire path, never dormant.
    expect(result.retired).toBe(1);
    expect(result.dormant).toBe(0);
    expect(harness.repoUpdates[0]?.updates.lifecycle).toMatchObject({ status: "retired" });
    const dormantEvent = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_DORMANT
    );
    expect(dormantEvent).toBeUndefined();
  });

  it("preserves legacy neutral-default retire semantics: a recall_bias=0 path still retires (not dormant)", async () => {
    // invariant: recall_bias === 0 is neutral (not positive-associative) so it
    // keeps the terminal-retire path; the createPath default uses recall_bias 0.
    const neutralPath = createPath({
      plasticity_state: {
        strength: 0.05,
        direction_bias: "source_to_target",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0,
        last_reinforced_at: PAST_REINFORCED_ISO
      }
    });
    expect(neutralPath.effect_vector.recall_bias).toBe(0);
    const harness = buildHarness({
      usageRecords: [createUsageRecord({ usage_state: "skipped", used_object_ids: [] })],
      pathsByObjectId: { "obj-target": [neutralPath] },
      deliveredObjectIdsByDeliveryId: { "delivery-1": ["obj-target"] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(result.retired).toBe(1);
    expect(result.dormant).toBe(0);
    expect(harness.repoUpdates[0]?.updates.lifecycle).toMatchObject({ status: "retired" });
  });
});

// Suppress unused-import warnings for fixtures not used in every test.
void createEventLogEntry;
