import { describe, expect, it, vi } from "vitest";
import {
  RuntimeGovernanceEventType,
  type ConsolidationCyclePlan,
  type ConsolidationTriggerBudget,
  type EventLogEntry,
  type PathRelation
} from "@do-soul/alaya-protocol";
import {
  ConsolidationExecutor,
  type ConsolidationBudgetStorePort,
  type ConsolidationPathRelationPort
} from "../consolidation-executor.js";
import { EventPublisher, type RuntimeNotifier } from "../event-publisher.js";

const NOW_ISO = "2026-05-20T12:00:00.000Z";

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

function emptyPlan(overrides: Partial<ConsolidationCyclePlan> = {}): ConsolidationCyclePlan {
  return {
    workspace_id: "workspace-1",
    planned_at: NOW_ISO,
    promotions: [],
    retirements: [],
    governance_changes: [],
    direction_changes: [],
    fuse_state: { blown: false, retry_count: 0 },
    ...overrides
  };
}

interface Harness {
  readonly executor: ConsolidationExecutor;
  readonly publishedEvents: EventLogEntry[];
  readonly repoUpdates: {
    pathId: string;
    updates: Partial<PathRelation>;
  }[];
  readonly budgetUpserts: ConsolidationTriggerBudget[];
}

function buildHarness(params: {
  readonly paths?: readonly PathRelation[];
  readonly budget?: ConsolidationTriggerBudget | null;
}): Harness {
  const publishedEvents: EventLogEntry[] = [];
  const repoUpdates: { pathId: string; updates: Partial<PathRelation> }[] = [];
  const budgetUpserts: ConsolidationTriggerBudget[] = [];
  const pathStateById = new Map<string, PathRelation>();
  for (const path of params.paths ?? []) {
    pathStateById.set(path.path_id, path);
  }

  const buildEntry = (
    input: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
  ): EventLogEntry => ({
    ...input,
    revision: publishedEvents.filter(
      (row) => row.entity_type === input.entity_type && row.entity_id === input.entity_id
    ).length,
    event_id: `evt-${publishedEvents.length + 1}`,
    created_at: NOW_ISO
  });

  const eventLogRepo = {
    append: vi.fn(
      (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry => {
        const persisted = buildEntry(entry);
        publishedEvents.push(persisted);
        return persisted;
      }
    ),
    deleteById: vi.fn((): void => undefined),
    transactional: <T,>(fn: () => T): T => fn()
  };

  const runtimeNotifier: RuntimeNotifier = {
    notify: vi.fn(() => undefined),
    notifyEntry: vi.fn(() => undefined)
  };

  const eventPublisher = new EventPublisher({
    eventLogRepo,
    runHotStateService: { apply: vi.fn(async () => undefined) },
    runtimeNotifier
  });

  const pathRelationRepo: ConsolidationPathRelationPort = {
    findById: vi.fn(async (pathId: string) => pathStateById.get(pathId) ?? null),
    update: vi.fn((pathId, updates) => {
      repoUpdates.push({ pathId, updates });
      const original = pathStateById.get(pathId) ?? createPath({ path_id: pathId });
      const updated = {
        ...original,
        ...(updates as Partial<PathRelation>),
        updated_at: updates.updated_at ?? NOW_ISO
      } as PathRelation;
      pathStateById.set(pathId, updated);
      return updated;
    })
  };

  let budgetRow = params.budget ?? null;
  const budgetStore: ConsolidationBudgetStorePort = {
    findByTriggerSource: vi.fn(async () => budgetRow),
    upsert: vi.fn(async (budget: ConsolidationTriggerBudget) => {
      budgetUpserts.push(budget);
      budgetRow = budget;
    })
  };

  const executor = new ConsolidationExecutor({
    pathRelationRepo,
    budgetStore,
    eventPublisher,
    now: () => NOW_ISO
  });

  return { executor, publishedEvents, repoUpdates, budgetUpserts };
}

describe("ConsolidationExecutor", () => {
  it("applies planned PathRelation mutations and emits PATH_CONSOLIDATION_COMPLETED", async () => {
    const promotePath = createPath({ path_id: "path-promote" });
    const retirePath = createPath({ path_id: "path-retire" });
    const governPath = createPath({ path_id: "path-govern" });
    const directPath = createPath({ path_id: "path-direct" });
    const harness = buildHarness({
      paths: [promotePath, retirePath, governPath, directPath]
    });

    const result = await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan({
        promotions: [
          { path_id: "path-promote", from_stability: "normal", to_stability: "stable" }
        ],
        retirements: [{ path_id: "path-retire", reason: "stale" }],
        governance_changes: [
          { path_id: "path-govern", from_class: "recall_allowed", to_class: "strictly_governed" }
        ],
        direction_changes: [
          {
            path_id: "path-direct",
            from_bias: "source_to_target",
            to_bias: "target_to_source"
          }
        ]
      })
    });

    expect(result.fuse_outcome).toBe("ok");
    expect(result.promotions_committed).toBe(1);
    expect(result.retirements_committed).toBe(1);
    expect(result.governance_changes_committed).toBe(1);
    expect(result.direction_changes_committed).toBe(1);

    const byPath = new Map(harness.repoUpdates.map((row) => [row.pathId, row.updates]));
    expect(byPath.get("path-promote")?.plasticity_state?.stability_class).toBe("stable");
    expect(byPath.get("path-retire")?.lifecycle?.status).toBe("retired");
    expect(byPath.get("path-govern")?.legitimacy?.governance_class).toBe("strictly_governed");
    expect(byPath.get("path-direct")?.plasticity_state?.direction_bias).toBe("target_to_source");

    expect(
      harness.publishedEvents.some(
        (event) => event.event_type === RuntimeGovernanceEventType.PATH_CONSOLIDATION_COMPLETED
      )
    ).toBe(true);
  });

  it("charges an attempt against the budget for every committed cycle", async () => {
    const harness = buildHarness({
      budget: {
        trigger_id: "consolidation-native_surface_drift",
        trigger_source: "native_surface_drift",
        max_attempts_within_window: 3,
        attempts_used: 1,
        cooldown_until: "1970-01-01T00:00:00.000Z"
      }
    });

    await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan()
    });

    // The prior window (cooldown_until in the past) has elapsed, so the
    // committed cycle restarts the rolling counter at 1 rather than climbing.
    expect(harness.budgetUpserts).toHaveLength(1);
    expect(harness.budgetUpserts[0]?.attempts_used).toBe(1);
  });

  it("refuses with cooldown_active and persists cooldown when the budget is cooling", async () => {
    // A maxed budget whose cooldown window is still open: the cooldown gate
    // refuses re-entry. This is the in-window backpressure path.
    const harness = buildHarness({
      budget: {
        trigger_id: "consolidation-native_surface_drift",
        trigger_source: "native_surface_drift",
        max_attempts_within_window: 3,
        attempts_used: 3,
        cooldown_until: "2999-01-01T00:00:00.000Z"
      }
    });

    const result = await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan({
        promotions: [
          { path_id: "path-1", from_stability: "normal", to_stability: "stable" }
        ]
      })
    });

    expect(result.fuse_outcome).toBe("cooldown_active");
    expect(result.promotions_committed).toBe(0);
    expect(harness.repoUpdates).toHaveLength(0);
    const fused = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_CONSOLIDATION_FUSED
    );
    expect(fused).toBeDefined();
    // The cooldown is persisted so a follow-up cycle stays gated.
    expect(harness.budgetUpserts).toHaveLength(1);
    expect(Date.parse(harness.budgetUpserts[0]!.cooldown_until)).toBeGreaterThan(
      Date.parse(NOW_ISO)
    );
  });

  it("recovers a maxed budget once its cooldown window has elapsed", async () => {
    // The B2 regression guard: a budget at the cap whose cooldown lapsed must
    // NOT stay fused. The window has elapsed, so the cycle commits and the
    // counter restarts — the trigger source is not wedged permanently.
    const harness = buildHarness({
      budget: {
        trigger_id: "consolidation-native_surface_drift",
        trigger_source: "native_surface_drift",
        max_attempts_within_window: 3,
        attempts_used: 3,
        cooldown_until: "1970-01-01T00:00:00.000Z"
      }
    });

    const result = await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan()
    });

    expect(result.fuse_outcome).toBe("ok");
    expect(harness.budgetUpserts).toHaveLength(1);
    expect(harness.budgetUpserts[0]?.attempts_used).toBe(1);
    expect(
      harness.publishedEvents.some(
        (event) => event.event_type === RuntimeGovernanceEventType.PATH_CONSOLIDATION_FUSED
      )
    ).toBe(false);
  });

  it("refuses the cycle while the budget cooldown is still active", async () => {
    const harness = buildHarness({
      budget: {
        trigger_id: "consolidation-native_surface_drift",
        trigger_source: "native_surface_drift",
        max_attempts_within_window: 3,
        attempts_used: 0,
        cooldown_until: "2999-01-01T00:00:00.000Z"
      }
    });

    const result = await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan()
    });

    expect(result.fuse_outcome).toBe("cooldown_active");
    expect(harness.repoUpdates).toHaveLength(0);
  });

  it("does not charge within an unexpired window — the cooldown gate refuses first", async () => {
    // Cooldown is in the future: the window has NOT elapsed. The cooldown
    // gate refuses the cycle before any charge, so the counter is not reset
    // and not incremented by a committed cycle.
    const harness = buildHarness({
      budget: {
        trigger_id: "consolidation-native_surface_drift",
        trigger_source: "native_surface_drift",
        max_attempts_within_window: 3,
        attempts_used: 1,
        cooldown_until: "2999-01-01T00:00:00.000Z"
      }
    });

    const result = await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan()
    });

    expect(result.fuse_outcome).toBe("cooldown_active");
    // The only upsert is the cooldown refresh from refuse(); attempts_used is
    // carried unchanged (not reset to 1, not incremented).
    expect(harness.budgetUpserts).toHaveLength(1);
    expect(harness.budgetUpserts[0]?.attempts_used).toBe(1);
  });

  it("charges the budget only after the cycle commits", async () => {
    const harness = buildHarness({
      budget: {
        trigger_id: "consolidation-native_surface_drift",
        trigger_source: "native_surface_drift",
        max_attempts_within_window: 3,
        attempts_used: 1,
        cooldown_until: "1970-01-01T00:00:00.000Z"
      }
    });

    await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan()
    });

    // A single charge, and it carries the post-window-reset value (1).
    expect(harness.budgetUpserts).toHaveLength(1);
    expect(harness.budgetUpserts[0]?.attempts_used).toBe(1);
    // The completed event was published before the budget charge committed.
    expect(
      harness.publishedEvents.some(
        (event) => event.event_type === RuntimeGovernanceEventType.PATH_CONSOLIDATION_COMPLETED
      )
    ).toBe(true);
  });

  it("does not burn budget when the cycle's path mutation fails", async () => {
    // A plan that references a missing path makes prepareMutations throw
    // before the transaction; the budget must not be charged.
    const harness = buildHarness({
      budget: {
        trigger_id: "consolidation-native_surface_drift",
        trigger_source: "native_surface_drift",
        max_attempts_within_window: 3,
        attempts_used: 1,
        cooldown_until: "1970-01-01T00:00:00.000Z"
      }
    });

    await expect(
      harness.executor.runCycle({
        triggerSource: "native_surface_drift",
        plan: emptyPlan({
          promotions: [
            { path_id: "missing-path", from_stability: "normal", to_stability: "stable" }
          ]
        })
      })
    ).rejects.toThrow(/missing path relation/);

    // No attempt was charged — a failed cycle leaves the budget untouched.
    expect(harness.budgetUpserts).toHaveLength(0);
    expect(
      harness.publishedEvents.some(
        (event) => event.event_type === RuntimeGovernanceEventType.PATH_CONSOLIDATION_COMPLETED
      )
    ).toBe(false);
  });

  it("honors a plan that arrives with the fuse already blown", async () => {
    const harness = buildHarness({});

    const result = await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan({
        fuse_state: { blown: true, reason: "planner abandoned cycle", retry_count: 2 }
      })
    });

    expect(result.fuse_outcome).toBe("tripped");
    expect(harness.repoUpdates).toHaveLength(0);
  });
});
