import { vi } from "vitest";
import { DYNAMICS_CONSTANTS, type ConsolidationCyclePlan, type ConsolidationTriggerBudget, type EventLogEntry, type PathRelation } from "@do-soul/alaya-protocol";
import { ConsolidationExecutor, type ConsolidationBudgetStorePort, type ConsolidationPathRelationPort } from "../../memory/consolidation-executor.js";
import { EventPublisher, type RuntimeNotifier } from "../../runtime/event-publisher.js";

export const NOW_ISO = "2026-05-20T12:00:00.000Z";

export const MERGE_WHY_MAX_ENTRIES =
  DYNAMICS_CONSTANTS.path_plasticity.consolidation_merge_why_max_entries;

export function createPath(overrides: Partial<PathRelation> = {}): PathRelation {
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

export // A merge loser must be dormant-at-apply and deletable (mergeable disposition).
// The executor re-enforces the importance gate + the dormant predicate at the
// delete site, so a loser fixture must carry lifecycle.status === "dormant".
function createDormantLoser(overrides: Partial<PathRelation> = {}): PathRelation {
  const base = createPath(overrides);
  return {
    ...base,
    lifecycle: { ...base.lifecycle, status: "dormant" }
  } as PathRelation;
}

export function emptyPlan(overrides: Partial<ConsolidationCyclePlan> = {}): ConsolidationCyclePlan {
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

export interface Harness {
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

export function buildHarness(params: {
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
