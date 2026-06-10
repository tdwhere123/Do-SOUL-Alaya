import { describe, expect, it, vi } from "vitest";
import {
  PathGovernanceClass,
  StabilityClass,
  type EventLogEntry,
  type PathRelation,
  type UsageProofRecord
} from "@do-soul/alaya-protocol";
import {
  PathPlasticityService,
  type PathPlasticityRepoPort,
  type UsageProofReaderPort
} from "../../path-plasticity-service.js";
import { EventPublisher, type RuntimeNotifier } from "../../event-publisher.js";

const NOW_ISO = "2026-05-04T12:00:00.000Z";

let usageRecordSeq = 0;
function createUsageRecord(overrides: Partial<UsageProofRecord> = {}): UsageProofRecord {
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
      stability_class: StabilityClass.VOLATILE,
      support_events_count: 0,
      contradiction_events_count: 0
    },
    lifecycle: { retirement_rule: "default" },
    legitimacy: {
      evidence_basis: ["evidence-1"],
      governance_class: PathGovernanceClass.HINT_ONLY
    },
    created_at: "2026-04-01T00:00:00.000Z",
    updated_at: "2026-04-01T00:00:00.000Z",
    ...overrides
  } as PathRelation;
}

interface Harness {
  readonly service: PathPlasticityService;
  readonly publishedEvents: EventLogEntry[];
  readonly repoUpdates: { pathId: string; updates: Partial<PathRelation> }[];
  readonly getPath: (pathId: string) => Readonly<PathRelation> | undefined;
}

function buildHarness(params: {
  readonly usageRecords: readonly UsageProofRecord[];
  readonly pathsByObjectId: Readonly<Record<string, readonly PathRelation[]>>;
}): Harness {
  const publishedEvents: EventLogEntry[] = [];
  const repoUpdates: { pathId: string; updates: Partial<PathRelation> }[] = [];
  const pathStateById = new Map<string, PathRelation>();
  for (const path of Object.values(params.pathsByObjectId).flat()) {
    pathStateById.set(path.path_id, path);
  }

  const buildEntry = (
    input: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
  ): EventLogEntry => {
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
    append: vi.fn(
      (input: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry => {
        const persisted = buildEntry(input);
        publishedEvents.push(persisted);
        return persisted;
      }
    ),
    deleteById: vi.fn((eventId: string): void => {
      const index = publishedEvents.findIndex((event) => event.event_id === eventId);
      if (index >= 0) {
        publishedEvents.splice(index, 1);
      }
    }),
    transactional: <T,>(fn: () => T): T => fn(),
    queryByEntity: vi.fn(async (_entityType: string, entityId: string) =>
      publishedEvents.filter((event) => event.entity_id === entityId)
    )
  };
  const runHotState = { apply: vi.fn(async () => undefined) };
  const runtimeNotifier: RuntimeNotifier = {
    notify: vi.fn(() => undefined),
    notifyEntry: vi.fn(() => undefined)
  };
  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: runHotState,
    runtimeNotifier
  });

  const pathRepo: PathPlasticityRepoPort = {
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
        ...original,
        ...(updates as Partial<PathRelation>),
        updated_at: updates.updated_at ?? NOW_ISO
      } as Readonly<PathRelation>;
      pathStateById.set(pathId, updatedPath as PathRelation);
      return updatedPath;
    })
  };

  const usageReader: UsageProofReaderPort = {
    listRecentUsage: vi.fn(async () => params.usageRecords),
    findDeliveredObjectIds: vi.fn(async () => null)
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
    getPath: (pathId) => pathStateById.get(pathId)
  };
}

function buildUsedReceipts(count: number): readonly UsageProofRecord[] {
  return Array.from({ length: count }, () =>
    createUsageRecord({ usage_state: "used", used_object_ids: ["obj-target"] })
  );
}

describe("PathPlasticityService promotion ladder", () => {
  it("promotes hint_only to attention_only once cumulative support_events_count reaches 3 with zero contradictions", async () => {
    const path = createPath({
      path_id: "path-promo-hint",
      plasticity_state: {
        strength: 0.5,
        direction_bias: "source_to_target",
        stability_class: StabilityClass.NORMAL,
        support_events_count: 2,
        contradiction_events_count: 0
      },
      legitimacy: {
        evidence_basis: ["evidence-1"],
        governance_class: PathGovernanceClass.HINT_ONLY
      }
    });
    const harness = buildHarness({
      usageRecords: buildUsedReceipts(1),
      pathsByObjectId: { "obj-target": [path] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    const promotion = result.promotions.find((row) => row.path_id === "path-promo-hint");
    expect(promotion).toBeDefined();
    expect(promotion?.governance_promoted).toMatchObject({
      kind: "governance_promotion",
      previous: PathGovernanceClass.HINT_ONLY,
      next: PathGovernanceClass.ATTENTION_ONLY
    });
    const updated = harness.getPath("path-promo-hint");
    expect(updated?.legitimacy.governance_class).toBe(PathGovernanceClass.ATTENTION_ONLY);
  });

  it("withholds hint_only promotion when a contradiction is also reported in the tick", async () => {
    const path = createPath({
      path_id: "path-blocked-promo",
      plasticity_state: {
        strength: 0.5,
        direction_bias: "source_to_target",
        stability_class: StabilityClass.NORMAL,
        support_events_count: 2,
        contradiction_events_count: 0
      },
      legitimacy: {
        evidence_basis: ["evidence-1"],
        governance_class: PathGovernanceClass.HINT_ONLY
      }
    });
    const harness = buildHarness({
      usageRecords: [
        createUsageRecord({ usage_state: "used", used_object_ids: ["obj-target"] }),
        createUsageRecord({
          usage_state: "not_applicable",
          used_object_ids: ["obj-target"]
        })
      ],
      pathsByObjectId: { "obj-target": [path] }
    });

    await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    const updated = harness.getPath("path-blocked-promo");
    expect(updated?.legitimacy.governance_class).toBe(PathGovernanceClass.HINT_ONLY);
  });

  it("promotes attention_only to recall_allowed once cumulative support reaches 8", async () => {
    const path = createPath({
      path_id: "path-promo-attention",
      plasticity_state: {
        strength: 0.7,
        direction_bias: "source_to_target",
        stability_class: StabilityClass.NORMAL,
        support_events_count: 7,
        contradiction_events_count: 0
      },
      legitimacy: {
        evidence_basis: ["evidence-1"],
        governance_class: PathGovernanceClass.ATTENTION_ONLY
      }
    });
    const harness = buildHarness({
      usageRecords: buildUsedReceipts(1),
      pathsByObjectId: { "obj-target": [path] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    const promotion = result.promotions.find((row) => row.path_id === "path-promo-attention");
    expect(promotion?.governance_promoted?.next).toBe(PathGovernanceClass.RECALL_ALLOWED);
    expect(harness.getPath("path-promo-attention")?.legitimacy.governance_class).toBe(
      PathGovernanceClass.RECALL_ALLOWED
    );
  });

  it("never auto-promotes strictly_governed", async () => {
    const path = createPath({
      path_id: "path-strict",
      plasticity_state: {
        strength: 0.9,
        direction_bias: "source_to_target",
        stability_class: StabilityClass.NORMAL,
        support_events_count: 99,
        contradiction_events_count: 0
      },
      legitimacy: {
        evidence_basis: ["evidence-1"],
        governance_class: PathGovernanceClass.STRICTLY_GOVERNED
      }
    });
    const harness = buildHarness({
      usageRecords: buildUsedReceipts(1),
      pathsByObjectId: { "obj-target": [path] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    const promotion = result.promotions.find((row) => row.path_id === "path-strict");
    expect(promotion?.governance_promoted).toBeNull();
    expect(harness.getPath("path-strict")?.legitimacy.governance_class).toBe(
      PathGovernanceClass.STRICTLY_GOVERNED
    );
  });

  it("evolves stability_class volatile -> normal at threshold 3", async () => {
    const path = createPath({
      path_id: "path-stability-vol",
      plasticity_state: {
        strength: 0.3,
        direction_bias: "source_to_target",
        stability_class: StabilityClass.VOLATILE,
        support_events_count: 2,
        contradiction_events_count: 0
      },
      legitimacy: {
        evidence_basis: ["evidence-1"],
        governance_class: PathGovernanceClass.RECALL_ALLOWED
      }
    });
    const harness = buildHarness({
      usageRecords: buildUsedReceipts(1),
      pathsByObjectId: { "obj-target": [path] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    const promotion = result.promotions.find((row) => row.path_id === "path-stability-vol");
    expect(promotion?.stability_promoted?.next).toBe(StabilityClass.NORMAL);
    expect(harness.getPath("path-stability-vol")?.plasticity_state.stability_class).toBe(
      StabilityClass.NORMAL
    );
  });

  it("evolves stability_class normal -> stable at threshold 8", async () => {
    const path = createPath({
      path_id: "path-stability-norm",
      plasticity_state: {
        strength: 0.7,
        direction_bias: "source_to_target",
        stability_class: StabilityClass.NORMAL,
        support_events_count: 7,
        contradiction_events_count: 0
      },
      legitimacy: {
        evidence_basis: ["evidence-1"],
        governance_class: PathGovernanceClass.RECALL_ALLOWED
      }
    });
    const harness = buildHarness({
      usageRecords: buildUsedReceipts(1),
      pathsByObjectId: { "obj-target": [path] }
    });

    const result = await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    const promotion = result.promotions.find((row) => row.path_id === "path-stability-norm");
    expect(promotion?.stability_promoted?.next).toBe(StabilityClass.STABLE);
    expect(harness.getPath("path-stability-norm")?.plasticity_state.stability_class).toBe(
      StabilityClass.STABLE
    );
  });

  it("evolves stable -> pinned only when governance_class is strictly_governed", async () => {
    const lockedPath = createPath({
      path_id: "path-stable-non-strict",
      plasticity_state: {
        strength: 0.95,
        direction_bias: "source_to_target",
        stability_class: StabilityClass.STABLE,
        support_events_count: 99,
        contradiction_events_count: 0
      },
      legitimacy: {
        evidence_basis: ["evidence-1"],
        governance_class: PathGovernanceClass.RECALL_ALLOWED
      }
    });
    const pinnablePath = createPath({
      path_id: "path-stable-strict",
      plasticity_state: {
        strength: 0.95,
        direction_bias: "source_to_target",
        stability_class: StabilityClass.STABLE,
        support_events_count: 99,
        contradiction_events_count: 0
      },
      legitimacy: {
        evidence_basis: ["evidence-1"],
        governance_class: PathGovernanceClass.STRICTLY_GOVERNED
      }
    });
    const harness = buildHarness({
      usageRecords: buildUsedReceipts(1),
      pathsByObjectId: { "obj-target": [lockedPath, pinnablePath] }
    });

    await harness.service.computeAndApplyPlasticity({
      workspaceId: "workspace-1",
      sinceIso: "2026-05-03T00:00:00.000Z"
    });

    expect(harness.getPath("path-stable-non-strict")?.plasticity_state.stability_class).toBe(
      StabilityClass.STABLE
    );
    expect(harness.getPath("path-stable-strict")?.plasticity_state.stability_class).toBe(
      StabilityClass.PINNED
    );
  });
});
