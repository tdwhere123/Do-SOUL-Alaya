import { describe, expect, it, vi } from "vitest";
import {
  DYNAMICS_CONSTANTS,
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
} from "../../memory/consolidation-executor.js";
import { EventPublisher, type RuntimeNotifier } from "../../event-publisher.js";

const NOW_ISO = "2026-05-20T12:00:00.000Z";
const MERGE_WHY_MAX_ENTRIES =
  DYNAMICS_CONSTANTS.path_plasticity.consolidation_merge_why_max_entries;

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

// A merge loser must be dormant-at-apply and deletable (mergeable disposition).
// The executor re-enforces the importance gate + the dormant predicate at the
// delete site, so a loser fixture must carry lifecycle.status === "dormant".
function createDormantLoser(overrides: Partial<PathRelation> = {}): PathRelation {
  const base = createPath(overrides);
  return {
    ...base,
    lifecycle: { ...base.lifecycle, status: "dormant" }
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
  readonly repoDeletes: string[];
  readonly pathStateById: Map<string, PathRelation>;
  readonly budgetUpserts: ConsolidationTriggerBudget[];
}

function buildHarness(params: {
  readonly paths?: readonly PathRelation[];
  readonly budget?: ConsolidationTriggerBudget | null;
}): Harness {
  const publishedEvents: EventLogEntry[] = [];
  const repoUpdates: { pathId: string; updates: Partial<PathRelation> }[] = [];
  const repoDeletes: string[] = [];
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
    }),
    delete: vi.fn((pathId: string) => {
      repoDeletes.push(pathId);
      pathStateById.delete(pathId);
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

  return { executor, publishedEvents, repoUpdates, repoDeletes, pathStateById, budgetUpserts };
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

  it("applies a merge: concats survivor why (deduped), deletes losers, emits PATH_RELATION_MERGED", async () => {
    const survivor = createPath({
      path_id: "path-survivor",
      constitution: {
        relation_kind: "supports",
        why_this_relation_exists: ["survivor-why", "shared-why"]
      },
      legitimacy: { evidence_basis: ["ev-survivor"], governance_class: "recall_allowed" }
    });
    const loserA = createDormantLoser({
      path_id: "path-loser-a",
      constitution: {
        relation_kind: "supports",
        // "shared-why" duplicates the survivor's; "loser-a-why" is new.
        why_this_relation_exists: ["shared-why", "loser-a-why"]
      },
      legitimacy: { evidence_basis: ["ev-loser-a"], governance_class: "recall_allowed" }
    });
    const loserB = createDormantLoser({
      path_id: "path-loser-b",
      constitution: {
        relation_kind: "supports",
        why_this_relation_exists: ["loser-b-why"]
      },
      // evidence_basis length 1 keeps this loser "mergeable" (deletable); a
      // second source from the survivor still lands in the survivor's absorbed
      // evidence list.
      legitimacy: { evidence_basis: ["ev-loser-b"], governance_class: "recall_allowed" }
    });
    const harness = buildHarness({ paths: [survivor, loserA, loserB] });

    const result = await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan({
        merges: [
          {
            survivor_path_id: "path-survivor",
            merged_path_ids: ["path-loser-a", "path-loser-b"]
          }
        ]
      })
    });

    expect(result.fuse_outcome).toBe("ok");
    expect(result.merges_committed).toBe(1);

    // Survivor's why_this_relation_exists is survivor-first, deduped union.
    const survivorUpdate = harness.repoUpdates.find((row) => row.pathId === "path-survivor");
    expect(survivorUpdate?.updates.constitution?.why_this_relation_exists).toEqual([
      "survivor-why",
      "shared-why",
      "loser-a-why",
      "loser-b-why"
    ]);
    // Survivor absorbs losers' evidence too (survivor-first, deduped union).
    expect(survivorUpdate?.updates.legitimacy?.evidence_basis).toEqual([
      "ev-survivor",
      "ev-loser-a",
      "ev-loser-b"
    ]);

    // Losers are deleted; survivor is not.
    expect(harness.repoDeletes.sort()).toEqual(["path-loser-a", "path-loser-b"]);
    expect(harness.pathStateById.has("path-survivor")).toBe(true);
    expect(harness.pathStateById.has("path-loser-a")).toBe(false);
    expect(harness.pathStateById.has("path-loser-b")).toBe(false);

    // One merged audit event carries the losers and the survivor relation kind.
    const mergedEvents = harness.publishedEvents.filter(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_MERGED
    );
    expect(mergedEvents).toHaveLength(1);
    const mergedPayload = mergedEvents[0]?.payload_json as Record<string, unknown>;
    expect(mergedPayload.survivor_path_id).toBe("path-survivor");
    expect(mergedPayload.merged_path_ids).toEqual(["path-loser-a", "path-loser-b"]);
    expect(mergedPayload.relation_kind).toBe("supports");

    // The completed event counts the deleted losers toward paths_retired.
    const completed = harness.publishedEvents.find(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_CONSOLIDATION_COMPLETED
    );
    expect((completed?.payload_json as Record<string, unknown>).paths_retired).toBe(2);
  });

  it("merges in the same transaction as other mutations and charges one attempt", async () => {
    const survivor = createPath({ path_id: "path-survivor" });
    const loser = createDormantLoser({ path_id: "path-loser" });
    const promote = createPath({ path_id: "path-promote" });
    const harness = buildHarness({ paths: [survivor, loser, promote] });

    const result = await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan({
        promotions: [{ path_id: "path-promote", from_stability: "normal", to_stability: "stable" }],
        merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-loser"] }]
      })
    });

    expect(result.fuse_outcome).toBe("ok");
    expect(result.promotions_committed).toBe(1);
    expect(result.merges_committed).toBe(1);
    expect(harness.repoDeletes).toEqual(["path-loser"]);
    // A single budget charge for the whole cycle.
    expect(harness.budgetUpserts).toHaveLength(1);
  });

  it("bounds the concatenated survivor why to the configured max entries", async () => {
    // Build a survivor + loser whose combined unique why entries exceed the
    // DYNAMICS_CONSTANTS bound; the survivor's own entries are always kept.
    const survivorWhy = Array.from({ length: 4 }, (_, index) => `survivor-why-${index}`);
    const loserWhy = Array.from({ length: 40 }, (_, index) => `loser-why-${index}`);
    const survivor = createPath({
      path_id: "path-survivor",
      constitution: { relation_kind: "supports", why_this_relation_exists: survivorWhy }
    });
    const loser = createDormantLoser({
      path_id: "path-loser",
      constitution: { relation_kind: "supports", why_this_relation_exists: loserWhy }
    });
    const harness = buildHarness({ paths: [survivor, loser] });

    await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan({
        merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-loser"] }]
      })
    });

    const survivorUpdate = harness.repoUpdates.find((row) => row.pathId === "path-survivor");
    const mergedWhy = survivorUpdate?.updates.constitution?.why_this_relation_exists ?? [];
    expect(mergedWhy.length).toBe(MERGE_WHY_MAX_ENTRIES);
    // Survivor's own entries lead and are never trimmed.
    expect(mergedWhy.slice(0, survivorWhy.length)).toEqual(survivorWhy);
  });

  it("rejects a merge whose survivor lists itself as a loser, burning no budget", async () => {
    // Survivor-also-loser is an id overlap (path-survivor in both lanes), caught
    // by the overlap guard before any path is loaded.
    const survivor = createPath({ path_id: "path-survivor" });
    const harness = buildHarness({
      paths: [survivor],
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
          merges: [
            { survivor_path_id: "path-survivor", merged_path_ids: ["path-survivor"] }
          ]
        })
      })
    ).rejects.toThrow(/appears in more than one mutation/);

    expect(harness.budgetUpserts).toHaveLength(0);
    expect(harness.repoDeletes).toHaveLength(0);
  });

  it("keeps the full survivor why/evidence when the survivor alone exceeds the bound", async () => {
    // C2 regression guard: the bound caps only ABSORBED loser entries. A
    // survivor whose own why/evidence already holds more than the bound must
    // emerge untrimmed — the survivor never loses its own provenance.
    const overBound = MERGE_WHY_MAX_ENTRIES + 4;
    const survivorWhy = Array.from({ length: overBound }, (_, index) => `survivor-why-${index}`);
    const survivorEvidence = Array.from(
      { length: overBound },
      (_, index) => `survivor-ev-${index}`
    );
    const survivor = createPath({
      path_id: "path-survivor",
      constitution: { relation_kind: "supports", why_this_relation_exists: survivorWhy },
      legitimacy: { evidence_basis: survivorEvidence, governance_class: "recall_allowed" }
    });
    const loser = createDormantLoser({
      path_id: "path-loser",
      constitution: { relation_kind: "supports", why_this_relation_exists: ["loser-why"] }
    });
    const harness = buildHarness({ paths: [survivor, loser] });

    await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan({
        merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-loser"] }]
      })
    });

    const survivorUpdate = harness.repoUpdates.find((row) => row.pathId === "path-survivor");
    // The survivor's own oversized list is preserved in full (length === overBound,
    // strictly greater than the bound), proving the cap never trims the survivor.
    expect(survivorUpdate?.updates.constitution?.why_this_relation_exists).toEqual(survivorWhy);
    expect(survivorUpdate?.updates.constitution?.why_this_relation_exists?.length).toBe(overBound);
    expect(overBound).toBeGreaterThan(MERGE_WHY_MAX_ENTRIES);
    expect(survivorUpdate?.updates.legitimacy?.evidence_basis).toEqual(survivorEvidence);
  });

  it("throws when a plan names a protected (evidence-rich) path as a merge loser, burning no budget", async () => {
    // The plan is externally constructable; a buggy/future caller could name a
    // protected path as a loser. The executor re-runs the importance gate at the
    // delete site and refuses — the protected path is never deleted.
    const survivor = createPath({ path_id: "path-survivor" });
    const protectedLoser = createDormantLoser({
      path_id: "path-protected",
      // evidence_basis length 2 => "keep" disposition => not deletable.
      legitimacy: { evidence_basis: ["ev-1", "ev-2"], governance_class: "recall_allowed" }
    });
    const harness = buildHarness({
      paths: [survivor, protectedLoser],
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
          merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-protected"] }]
        })
      })
    ).rejects.toThrow(/protected from deletion/);

    expect(harness.budgetUpserts).toHaveLength(0);
    expect(harness.repoDeletes).toHaveLength(0);
  });

  it("throws when a plan names a strictly_governed path as a merge loser", async () => {
    const survivor = createPath({ path_id: "path-survivor" });
    const governedLoser = createDormantLoser({
      path_id: "path-governed",
      legitimacy: { evidence_basis: ["ev-1"], governance_class: "strictly_governed" }
    });
    const harness = buildHarness({ paths: [survivor, governedLoser] });

    await expect(
      harness.executor.runCycle({
        triggerSource: "native_surface_drift",
        plan: emptyPlan({
          merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-governed"] }]
        })
      })
    ).rejects.toThrow(/protected from deletion/);

    expect(harness.repoDeletes).toHaveLength(0);
  });

  it("throws when a plan names a pinned path as a merge loser", async () => {
    const survivor = createPath({ path_id: "path-survivor" });
    const pinnedLoser = createDormantLoser({
      path_id: "path-pinned",
      plasticity_state: {
        strength: 0.5,
        direction_bias: "source_to_target",
        stability_class: "pinned",
        support_events_count: 0,
        contradiction_events_count: 0
      }
    });
    const harness = buildHarness({ paths: [survivor, pinnedLoser] });

    await expect(
      harness.executor.runCycle({
        triggerSource: "native_surface_drift",
        plan: emptyPlan({
          merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-pinned"] }]
        })
      })
    ).rejects.toThrow(/protected from deletion/);

    expect(harness.repoDeletes).toHaveLength(0);
  });

  it("throws when a merge loser is no longer dormant at apply time (TOCTOU guard)", async () => {
    // The loser is deletable by the gate (mergeable) but its lifecycle.status is
    // active, not dormant — it revived between plan emission and commit. The
    // dormant-at-apply re-check refuses the delete.
    const survivor = createPath({ path_id: "path-survivor" });
    const revivedLoser = createPath({
      path_id: "path-revived",
      lifecycle: { retirement_rule: "default", status: "active" }
    });
    const harness = buildHarness({ paths: [survivor, revivedLoser] });

    await expect(
      harness.executor.runCycle({
        triggerSource: "native_surface_drift",
        plan: emptyPlan({
          merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-revived"] }]
        })
      })
    ).rejects.toThrow(/no longer dormant/);

    expect(harness.repoDeletes).toHaveLength(0);
  });

  it("throws when a survivor is itself protected (not survivor-eligible)", async () => {
    const protectedSurvivor = createPath({
      path_id: "path-survivor",
      legitimacy: { evidence_basis: ["ev-1"], governance_class: "strictly_governed" }
    });
    const loser = createDormantLoser({ path_id: "path-loser" });
    const harness = buildHarness({ paths: [protectedSurvivor, loser] });

    await expect(
      harness.executor.runCycle({
        triggerSource: "native_surface_drift",
        plan: emptyPlan({
          merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-loser"] }]
        })
      })
    ).rejects.toThrow(/not survivor-eligible/);

    expect(harness.repoDeletes).toHaveLength(0);
  });

  it("throws when a path is both a merge survivor and a loser in another merge, burning no budget", async () => {
    const shared = createPath({ path_id: "path-shared" });
    const loser = createDormantLoser({ path_id: "path-loser" });
    const otherSurvivor = createPath({ path_id: "path-other" });
    const harness = buildHarness({
      paths: [shared, loser, otherSurvivor],
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
          merges: [
            { survivor_path_id: "path-shared", merged_path_ids: ["path-loser"] },
            { survivor_path_id: "path-other", merged_path_ids: ["path-shared"] }
          ]
        })
      })
    ).rejects.toThrow(/appears in more than one mutation/);

    expect(harness.budgetUpserts).toHaveLength(0);
    expect(harness.repoDeletes).toHaveLength(0);
  });

  it("throws when the same loser appears in two merges", async () => {
    const survivorA = createPath({ path_id: "path-survivor-a" });
    const survivorB = createPath({ path_id: "path-survivor-b" });
    const sharedLoser = createDormantLoser({ path_id: "path-loser" });
    const harness = buildHarness({ paths: [survivorA, survivorB, sharedLoser] });

    await expect(
      harness.executor.runCycle({
        triggerSource: "native_surface_drift",
        plan: emptyPlan({
          merges: [
            { survivor_path_id: "path-survivor-a", merged_path_ids: ["path-loser"] },
            { survivor_path_id: "path-survivor-b", merged_path_ids: ["path-loser"] }
          ]
        })
      })
    ).rejects.toThrow(/appears in more than one mutation/);

    expect(harness.repoDeletes).toHaveLength(0);
  });

  it("throws when a path appears in both a merge and the retirements list", async () => {
    const survivor = createPath({ path_id: "path-survivor" });
    const loser = createDormantLoser({ path_id: "path-loser" });
    const harness = buildHarness({ paths: [survivor, loser] });

    await expect(
      harness.executor.runCycle({
        triggerSource: "native_surface_drift",
        plan: emptyPlan({
          retirements: [{ path_id: "path-loser", reason: "stale" }],
          merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-loser"] }]
        })
      })
    ).rejects.toThrow(/appears in more than one mutation/);

    expect(harness.repoDeletes).toHaveLength(0);
  });

  it("captures each deleted loser's full why/evidence/effect in PATH_RELATION_MERGED beyond the survivor bound", async () => {
    // R2/R3 regression guard: the survivor row is bounded, but the event is the
    // ONLY durable record of the destroyed losers, so it must carry each loser's
    // FULL why + evidence (even the entries dropped past the survivor bound) plus
    // an effect summary that distinguishes a negative-family (suppressing) loser.
    const survivorWhy = Array.from({ length: 12 }, (_, index) => `survivor-why-${index}`);
    const survivor = createPath({
      path_id: "path-survivor",
      constitution: { relation_kind: "supports", why_this_relation_exists: survivorWhy }
    });
    const loserWhy = Array.from({ length: 20 }, (_, index) => `loser-why-${index}`);
    // A single evidence source keeps the loser "mergeable" (deletable); the
    // event still records the loser's full evidence_basis regardless of length.
    const loserEvidence = ["loser-ev-0"];
    const negativeLoser = createDormantLoser({
      path_id: "path-loser",
      constitution: { relation_kind: "supports", why_this_relation_exists: loserWhy },
      legitimacy: { evidence_basis: loserEvidence, governance_class: "recall_allowed" },
      effect_vector: {
        salience: 0.2,
        recall_bias: -0.8,
        verification_bias: 0,
        unfinishedness_bias: 0,
        default_manifestation_preference: "stance_bias"
      },
      plasticity_state: {
        strength: 0.5,
        direction_bias: "target_to_source",
        stability_class: "normal",
        support_events_count: 0,
        contradiction_events_count: 0
      }
    });
    const harness = buildHarness({ paths: [survivor, negativeLoser] });

    await harness.executor.runCycle({
      triggerSource: "native_surface_drift",
      plan: emptyPlan({
        merges: [{ survivor_path_id: "path-survivor", merged_path_ids: ["path-loser"] }]
      })
    });

    // The survivor row is bounded — its absorbed loser entries were trimmed.
    const survivorUpdate = harness.repoUpdates.find((row) => row.pathId === "path-survivor");
    const survivorMergedWhy =
      survivorUpdate?.updates.constitution?.why_this_relation_exists ?? [];
    expect(survivorMergedWhy.length).toBe(MERGE_WHY_MAX_ENTRIES);
    // Some loser why entries did NOT fit into the bounded survivor row.
    const absorbedLoserWhy = survivorMergedWhy.filter((entry) => entry.startsWith("loser-why-"));
    expect(absorbedLoserWhy.length).toBeLessThan(loserWhy.length);

    // The event is the durable record: it carries the loser's FULL why/evidence,
    // including the entries the survivor row could not absorb.
    const mergedEvents = harness.publishedEvents.filter(
      (event) => event.event_type === RuntimeGovernanceEventType.PATH_RELATION_MERGED
    );
    expect(mergedEvents).toHaveLength(1);
    const mergedPayload = mergedEvents[0]?.payload_json as Record<string, unknown>;
    const mergedLosers = mergedPayload.merged_losers as readonly Record<string, unknown>[];
    expect(mergedLosers).toHaveLength(1);
    const recorded = mergedLosers[0]!;
    expect(recorded.path_id).toBe("path-loser");
    expect(recorded.why_this_relation_exists).toEqual(loserWhy);
    expect(recorded.evidence_basis).toEqual(loserEvidence);
    expect(recorded.recall_bias_sign).toBe("negative");
    expect(recorded.recall_bias_magnitude).toBeCloseTo(0.8);
    expect(recorded.direction_bias).toBe("target_to_source");
  });
});
