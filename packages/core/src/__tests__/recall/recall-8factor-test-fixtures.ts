import { expect, vi } from "vitest";
import {
  BankruptcyKind,
  ControlPlaneObjectKind,
  DYNAMICS_CONSTANTS,
  MemoryDimension,
  RetentionPolicy,
  RuntimeMode,
  ScopeClass,
  type ActivationWeights,
  type BudgetSnapshot,
  type EventLogEntry,
  type MemoryEntry,
  type RecallPolicy,
  type Slot,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import type { RecallServiceDependencies } from "../../recall/recall-service.js";
import { PATH_PLASTICITY_WEIGHT } from "../../recall/runtime/recall-service-helpers.js";

export function createTaskSurface(displayName = "Implement recall"): TaskObjectSurface {
  return {
    runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-03-23T00:30:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "build",
    display_name: displayName,
    context_refs: []
  };
}

export function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "system",
    dimension: MemoryDimension.PROCEDURE,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for workspace commands.",
    domain_tags: ["repo"],
    evidence_refs: [],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: "hot",
    activation_score: 0.7,
    retention_score: 0.8,
    manifestation_state: "full_eligible",
    retention_state: "consolidated",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: "2026-03-23T00:00:00.000Z",
    last_hit_at: "2026-03-23T00:00:00.000Z",
    reinforcement_count: 3,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

export function createSlot(overrides: Partial<Slot> = {}): Slot {
  return {
    object_id: "slot-1",
    object_kind: "slot",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "system",
    governance_subject: {
      subject_domain: "repo",
      subject_qualifiers: { category: "tooling" },
      canonical_key: "repo::category=tooling"
    },
    claim_kind: "constraint",
    scope_class: ScopeClass.PROJECT,
    winner_claim_id: "claim-form-winner-1",
    incumbent_since: "2026-03-20T00:00:00.000Z",
    flip_conditions: [],
    workspace_id: "workspace-1",
    ...overrides
  };
}

export function createDependencies(
  memories: readonly MemoryEntry[],
  slots: readonly Slot[] = [],
  // Maps claim object_id -> source_object_refs (backing memory IDs).
  claimSourceRefs: Readonly<Record<string, readonly string[]>> = {},
  supportOptions: Readonly<{
    readonly graphSupportByMemoryId?: Readonly<Record<string, number>>;
    readonly recallsEdgeCountByMemoryId?: Readonly<Record<string, number>>;
    readonly pathPlasticityByMemoryId?: Readonly<Record<string, number>>;
  }> = {}
): {
  readonly dependencies: RecallServiceDependencies;
  readonly searchByKeyword: ReturnType<typeof vi.fn>;
  readonly countInboundSupports: ReturnType<typeof vi.fn>;
  readonly countInboundEdgesWeighted: ReturnType<typeof vi.fn>;
  readonly append: ReturnType<typeof vi.fn>;
  readonly getSnapshot: ReturnType<typeof vi.fn>;
} {
  const searchByKeyword = vi.fn(async () => [{ object_id: memories[1]?.object_id ?? "memory-2", normalized_rank: 1 }]);
  const countInboundSupports = vi.fn(async (memoryId: string) => {
    if (supportOptions.graphSupportByMemoryId !== undefined) {
      return supportOptions.graphSupportByMemoryId[memoryId] ?? 0;
    }
    return memoryId === "memory-2" ? 3 : 0;
  });
  const countInboundRecalls = vi.fn(async (memoryId: string) =>
    supportOptions.recallsEdgeCountByMemoryId?.[memoryId] ?? 0
  );
  const getStrengthByMemoryId = vi.fn(async (_workspaceId: string, memoryIds: readonly string[]) =>
    new Map(
      memoryIds.flatMap((memoryId) => {
        const strength = supportOptions.pathPlasticityByMemoryId?.[memoryId];
        return strength === undefined ? [] : [[memoryId, strength] as const];
      })
    )
  );
  const getSnapshot = vi.fn(
    async (): Promise<Readonly<BudgetSnapshot>> => ({
      snapshot_at: "2026-03-23T00:00:00.000Z",
      run_id: "run-1",
      current_mode: RuntimeMode.LEAN,
      bankruptcy_kind: BankruptcyKind.SOFT,
      pressure_ratio: 0,
      trigger_summary: "over budget",
      active_dossier: null,
      pending_proposal: null
    })
  );
  const append = vi.fn(
    async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): Promise<EventLogEntry> => ({
      event_id: `event-${entry.event_type}`,
      created_at: "2026-03-23T00:00:00.000Z",
      revision: 0,
      ...entry
    })
  );

  const dependencies: RecallServiceDependencies = {
    now: () => "2026-03-23T00:00:00.000Z",
    generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
    memoryRepo: {
      findByWorkspaceId: vi.fn(async () => memories),
      findByDimension: vi.fn(async () => memories),
      findByScopeClass: vi.fn(async () => memories),
      searchByKeyword
    },
    slotRepo: {
      findByWorkspace: vi.fn(async () => slots)
    },
    eventLogRepo: {
      append,
      queryByEntity: vi.fn(async () => [])
    },
    graphSupportPort: {
      countInboundSupports,
      countInboundEdgesWeighted: countInboundSupports,
      countInboundRecalls
    },
    budgetPenaltyPort: {
      getSnapshot
    },
    ...(supportOptions.pathPlasticityByMemoryId === undefined
      ? {}
      : {
          pathPlasticityPort: {
            getStrengthByMemoryId
          }
        }),
    claimResolverPort: {
      findByIds: vi.fn(async (_workspaceId: string, ids: readonly string[]) =>
        ids
          .filter((id) => claimSourceRefs[id] !== undefined)
          .map((id) => ({ object_id: id, source_object_refs: claimSourceRefs[id] ?? [] }))
      )
    }
  };

  return {
    dependencies,
    searchByKeyword,
    countInboundSupports,
    countInboundEdgesWeighted: countInboundSupports,
    append,
    getSnapshot
  };
}

export function overridePolicy(base: Readonly<RecallPolicy>, patch: Partial<RecallPolicy>): RecallPolicy {
  return {
    ...base,
    ...patch,
    coarse_filter: patch.coarse_filter ?? base.coarse_filter,
    fine_assessment: patch.fine_assessment ?? base.fine_assessment
  };
}

function sumActivationWeights(weights: Readonly<ActivationWeights>): number {
  return (
    weights.scope_match +
    weights.domain_match +
    weights.retention +
    weights.freshness +
    weights.relevance +
    weights.graph_support +
    weights.budget_penalty +
    weights.conflict_penalty
  );
}

export function expectScoreWeightTotalConserved(
  weights: Readonly<ActivationWeights>,
  effectivePathWeight: number
): void {
  expect(sumActivationWeights(weights) + effectivePathWeight).toBeCloseTo(
    sumActivationWeights(DYNAMICS_CONSTANTS.activation_weights_phase4b) + PATH_PLASTICITY_WEIGHT
  );
}
