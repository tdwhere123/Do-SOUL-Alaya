import { describe, expect, it, vi } from "vitest";
import {
  ControlPlaneObjectKind,
  MemoryDimension,
  RetentionPolicy,
  ScopeClass,
  StorageTier,
  type EventLogEntry,
  type MemoryEntry,
  type PathRelation,
  type RecallCandidate,
  type RecallPolicy,
  type Slot,
  type SoulActiveConstraint,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import { RecallService, type RecallServiceDependencies } from "../../recall-service.js";
import { selectCandidatesWithinBudgets } from "../../recall-candidate-builder.js";
import { compareRecallCandidates } from "../../recall-service-helpers.js";
import { compileRecallQueryProbes } from "../../recall-query-probes.js";

const WS = "workspace-regression";
const NOW = "2026-05-18T00:00:00.000Z";

describe("recall regression suite", () => {
  it.each([
    ["mixed dimensions", ["gold", "peer-1", "peer-2", "peer-3", "peer-4"]],
    ["warm workspace peers", ["gold", "warm-1", "warm-2", "warm-3", "warm-4"]],
    ["constraint peers", ["gold", "constraint-1", "constraint-2", "constraint-3", "constraint-4"]]
  ])("keeps high-lexical gold inside top five under %s", (_name, ids) => {
    const candidates = ids.map((id, index) =>
      candidate(id, id === "gold" ? 0.98 : 0.7 - index * 0.05, id === "gold" ? 0.2 : 0.9)
    );
    const topFive = [...candidates].sort(compareRecallCandidates).slice(0, 5);
    expect(topFive.map((item) => item.object_id)).toContain("gold");
  });

  it.each([
    ["simple descending", [0.9, 0.8, 0.7, 0.6]],
    ["tie broken by activation", [0.8, 0.8, 0.7, 0.7]],
    ["long tail", [0.95, 0.9, 0.6, 0.4, 0.2]]
  ])("keeps delivered ordering monotonic for %s", (_name, scores) => {
    const sorted = scores
      .map((score, index) => candidate(`mem-${index}`, score, index % 2 === 0 ? 0.5 : 0.4))
      .sort(compareRecallCandidates);
    expect(sorted.map((item) => item.relevance_score)).toEqual(
      [...scores].sort((left, right) => right - left)
    );
  });

  it("drops excess candidates by max_entries", () => {
    const selected = selectCandidatesWithinBudgets(
      [candidate("a", 0.9), candidate("b", 0.8), candidate("c", 0.7)],
      fineConfig({ max_entries: 2, max_total_tokens: 1000 })
    );
    expect(selected.map((item) => item.object_id)).toEqual(["a", "b"]);
  });

  it("drops candidates that would exceed token budget", () => {
    const selected = selectCandidatesWithinBudgets(
      [candidate("a", 0.9, 0.5, 8), candidate("b", 0.8, 0.5, 8)],
      fineConfig({ max_entries: 5, max_total_tokens: 10 })
    );
    expect(selected.map((item) => item.object_id)).toEqual(["a"]);
  });

  it("keeps winning admission diagnostics aligned to the first specific attribution plane", async () => {
    const mem = memory({ object_id: "lexical-gold", content: "release checklist lexical-gold" });
    const { dependencies } = deps([mem], {
      searchByKeyword: async () => [{ object_id: "lexical-gold", normalized_rank: 1 }]
    });
    const result = await new RecallService(dependencies).recall({
      taskSurface: task("release checklist lexical-gold"),
      workspaceId: WS,
      strategy: "analyze"
    });
    const diag = result.diagnostics?.candidates.find((item) => item.object_id === "lexical-gold");
    expect(diag?.plane_first_admitted).toBe("activation");
    expect(diag?.admission_planes).toContain("lexical");
    expect(diag?.plane_winning_admission).toBe("lexical");
  });

  it("records path_expansion as the winning admission plane for path-only linked candidates", async () => {
    const seed = memory({ object_id: "seed", content: "needle seed" });
    const linked = memory({ object_id: "linked", content: "linked recall target" });
    const relation = pathRelation("seed", "linked");
    const { dependencies } = deps([seed, linked], {
      searchByKeyword: async () => [{ object_id: "seed", normalized_rank: 1 }],
      pathExpansionPort: {
        findByAnchors: vi.fn(async () => [relation])
      }
    });
    const result = await new RecallService(dependencies).recall({
      taskSurface: task("needle seed"),
      workspaceId: WS,
      strategy: "analyze"
    });
    const diag = result.diagnostics?.candidates.find((item) => item.object_id === "linked");
    expect(diag?.admission_planes).toContain("path_expansion");
    expect(diag?.plane_winning_admission).toBe("path_expansion");
    expect(diag?.path_expansion_sources).toEqual([
      {
        path_id: relation.path_id,
        seed_id: "seed",
        seed_kind: "memory",
        target_object_id: "linked",
        source_channel: "path_expansion"
      }
    ]);
  });

  it.each([
    ["yesterday", "What changed yesterday?"],
    ["last-week-cn", "上周做了什么决定？"]
  ])("extracts time concern query probes for %s", (_name, query) => {
    expect(compileRecallQueryProbes(query).date_terms.length).toBeGreaterThan(0);
  });

  it.each([
    ["plain release query", "recall release checklist"],
    ["plain Chinese query", "召回发布检查项"]
  ])("does not emit temporal probes for %s", (_name, query) => {
    expect(compileRecallQueryProbes(query).date_terms).toEqual([]);
  });

  it("returns active constraints outside the ranked result budget", async () => {
    const ranked = memory({ object_id: "ranked", dimension: MemoryDimension.PROCEDURE });
    const constraint = activeConstraint(memory({ object_id: "constraint", dimension: MemoryDimension.CONSTRAINT }));
    const { dependencies } = deps([ranked], { activeConstraints: [constraint] });
    const service = new RecallService(dependencies);
    const policy = withBudgets(service.buildDefaultPolicy("analyze", task().runtime_id), {
      max_entries: 1,
      max_total_tokens: 1000
    });
    const result = await service.recall({
      taskSurface: task(),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: policy
    });
    expect(result.candidates.map((item) => item.object_id)).toEqual(["ranked"]);
    expect(result.active_constraints.map((item) => item.object_id)).toEqual(["constraint"]);
  });

  it("reports active constraints count from the active constraints port", async () => {
    const constraint = activeConstraint(memory({ object_id: "constraint", dimension: MemoryDimension.HAZARD }));
    const { dependencies } = deps([], { activeConstraints: [constraint] });
    const result = await new RecallService(dependencies).recall({
      taskSurface: task(),
      workspaceId: WS,
      strategy: "analyze"
    });
    expect(result.active_constraints_count).toBe(1);
  });

  it("passes active constraints cap through to the port", async () => {
    const findActiveConstraints = vi.fn(async () => ({ constraints: [], total_count: 0 }));
    const { dependencies } = deps([], {
      activeConstraintsPort: { findActiveConstraints }
    });
    await new RecallService(dependencies).recall({
      taskSurface: task(),
      workspaceId: WS,
      strategy: "analyze",
      activeConstraintsCap: 3
    });
    expect(findActiveConstraints).toHaveBeenCalledWith({ workspaceId: WS, cap: 3 });
  });

  it("uses path expansion in a cold workspace without usage proof lookup", async () => {
    const seed = memory({ object_id: "seed", content: "cold seed", storage_tier: StorageTier.COLD });
    const linked = memory({ object_id: "linked", content: "cold linked", storage_tier: StorageTier.COLD });
    const queryByEntity = vi.fn(async () => []);
    const { dependencies } = deps([seed, linked], {
      searchByKeyword: async () => [{ object_id: "seed", normalized_rank: 1 }],
      queryByEntity,
      pathExpansionPort: {
        findByAnchors: vi.fn(async () => [pathRelation("seed", "linked")])
      }
    });
    const result = await new RecallService(dependencies).recall({
      taskSurface: task("cold seed"),
      workspaceId: WS,
      strategy: "analyze"
    });
    expect(result.candidates.some((item) => item.object_id === "linked")).toBe(true);
    expect(queryByEntity).not.toHaveBeenCalled();
  });

  it("marks path expansion source channels on cold linked candidates", async () => {
    const seed = memory({ object_id: "seed", content: "cold seed", storage_tier: StorageTier.COLD });
    const linked = memory({ object_id: "linked", content: "cold linked", storage_tier: StorageTier.COLD });
    const { dependencies } = deps([seed, linked], {
      searchByKeyword: async () => [{ object_id: "seed", normalized_rank: 1 }],
      pathExpansionPort: {
        findByAnchors: vi.fn(async () => [pathRelation("seed", "linked")])
      }
    });
    const result = await new RecallService(dependencies).recall({
      taskSurface: task("cold seed"),
      workspaceId: WS,
      strategy: "analyze"
    });
    const linkedCandidate = result.candidates.find((item) => item.object_id === "linked");
    expect(linkedCandidate?.source_channels).toContain("path_expansion");
  });

  it("falls back to lexical results when embedding precheck fails", async () => {
    const mem = memory({ object_id: "lexical", content: "embedding fallback lexical" });
    const { dependencies } = deps([mem], {
      searchByKeyword: async () => [{ object_id: "lexical", normalized_rank: 1 }],
      embeddingRecallService: {
        prepareQueryEmbedding: vi.fn(() => ({
          queryId: "q-1",
          getSnapshot: () => ({ status: "pending" as const })
        })),
        hasStoredVectors: vi.fn(async () => {
          throw { reason: "query_embedding_failed" };
        }),
        recordPrecheckDegraded: vi.fn(async () => undefined),
        querySupplementIfReady: vi.fn(async () => ({
          supplementaryEntries: [],
          similarityHintsByObjectId: {}
        })),
        querySupplement: vi.fn(async () => ({
          supplementaryEntries: [],
          similarityHintsByObjectId: {}
        }))
      }
    });
    const service = new RecallService(dependencies);
    const result = await service.recall({
      taskSurface: task("embedding fallback lexical"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: withEmbedding(service.buildDefaultPolicy("analyze", task().runtime_id))
    });
    expect(result.candidates.map((item) => item.object_id)).toContain("lexical");
    expect(result.diagnostics?.embedding_provider_status).toBe("provider_failed");
  });

  it("falls back to lexical results while embedding query is pending", async () => {
    const mem = memory({ object_id: "lexical", content: "embedding pending lexical" });
    const { dependencies } = deps([mem], {
      searchByKeyword: async () => [{ object_id: "lexical", normalized_rank: 1 }],
      embeddingRecallService: {
        hasStoredVectors: vi.fn(async () => true),
        prepareQueryEmbedding: vi.fn(() => ({
          queryId: "q-1",
          getSnapshot: () => ({ status: "pending" as const })
        })),
        querySupplementIfReady: vi.fn(async () => ({
          supplementaryEntries: [],
          similarityHintsByObjectId: {}
        })),
        querySupplement: vi.fn(async () => ({
          supplementaryEntries: [],
          similarityHintsByObjectId: {}
        }))
      }
    });
    const service = new RecallService(dependencies);
    const result = await service.recall({
      taskSurface: task("embedding pending lexical"),
      workspaceId: WS,
      strategy: "analyze",
      policyOverride: withEmbedding(service.buildDefaultPolicy("analyze", task().runtime_id))
    });
    expect(result.candidates.map((item) => item.object_id)).toContain("lexical");
    expect(result.diagnostics?.embedding_provider_status).toBe("provider_pending");
  });
});

function candidate(
  object_id: string,
  relevance_score: number,
  activation_score = 0.5,
  token_estimate = 4
): RecallCandidate {
  return {
    object_id,
    object_kind: "memory_entry",
    activation_score,
    relevance_score,
    content_preview: `${object_id} preview`,
    token_estimate,
    manifestation: "excerpt",
    dimension: MemoryDimension.FACT,
    scope_class: ScopeClass.PROJECT,
    origin_plane: "workspace_local",
    selection_reason: "selected",
    source_channels: ["ranked_recall"],
    score_factors: { activation: activation_score, relevance: relevance_score },
    budget_state: {
      token_estimate,
      max_entries: 10,
      max_total_tokens: 1000,
      remaining_entries: 9,
      remaining_tokens: 1000 - token_estimate,
      within_budget: true
    }
  };
}

function fineConfig(
  budgets: Partial<RecallPolicy["fine_assessment"]["budgets"]>
): RecallPolicy["fine_assessment"] {
  return {
    budgets: {
      max_entries: 10,
      max_total_tokens: 1000,
      per_dimension_limits: null,
      ...budgets
    },
    conflict_awareness: false
  };
}

function withBudgets(
  policy: RecallPolicy,
  budgets: Partial<RecallPolicy["fine_assessment"]["budgets"]>
): RecallPolicy {
  return {
    ...policy,
    fine_assessment: {
      ...policy.fine_assessment,
      budgets: {
        ...policy.fine_assessment.budgets,
        ...budgets
      }
    }
  };
}

function withEmbedding(policy: RecallPolicy): RecallPolicy {
  return {
    ...policy,
    coarse_filter: {
      ...policy.coarse_filter,
      semantic_supplement: {
        ...policy.coarse_filter.semantic_supplement,
        enabled: true,
        embedding_enabled: true,
        max_supplement: 5
      }
    }
  };
}

function deps(
  memories: readonly MemoryEntry[],
  options: {
    readonly activeConstraints?: readonly Readonly<SoulActiveConstraint>[];
    readonly activeConstraintsPort?: RecallServiceDependencies["activeConstraintsPort"];
    readonly embeddingRecallService?: RecallServiceDependencies["embeddingRecallService"];
    readonly pathExpansionPort?: RecallServiceDependencies["pathExpansionPort"];
    readonly queryByEntity?: RecallServiceDependencies["eventLogRepo"]["queryByEntity"];
    readonly searchByKeyword?: RecallServiceDependencies["memoryRepo"]["searchByKeyword"];
  } = {}
): { readonly dependencies: RecallServiceDependencies } {
  const findByWorkspaceId = async (_workspaceId: string, tier?: StorageTier) =>
    tier === undefined ? memories : memories.filter((entry) => entry.storage_tier === tier);
  return {
    dependencies: {
      now: () => NOW,
      generateRuntimeId: () => "85b3671a-d8d8-4848-9e5c-07d0a89f5ae9",
      memoryRepo: {
        findByWorkspaceId,
        findByDimension: async (_workspaceId, dimension) =>
          memories.filter((entry) => entry.dimension === dimension),
        findByScopeClass: async (_workspaceId, scopeClass) =>
          memories.filter((entry) => entry.scope_class === scopeClass),
        searchByKeyword: options.searchByKeyword
      },
      slotRepo: {
        findByWorkspace: async (): Promise<readonly Slot[]> => []
      },
      eventLogRepo: {
        append: async (
          entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">
        ): Promise<EventLogEntry> => ({
          event_id: `event-${entry.event_type}`,
          created_at: NOW,
          revision: 0,
          ...entry
        }),
        queryByEntity: options.queryByEntity ?? vi.fn(async () => [])
      },
      activeConstraintsPort:
        options.activeConstraintsPort ??
        (options.activeConstraints === undefined
          ? undefined
          : {
              findActiveConstraints: async () => ({
                constraints: options.activeConstraints ?? [],
                total_count: options.activeConstraints?.length ?? 0
              })
            }),
      embeddingRecallService: options.embeddingRecallService,
      pathExpansionPort: options.pathExpansionPort
    }
  };
}

function memory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: NOW,
    updated_at: NOW,
    created_by: "system",
    dimension: MemoryDimension.FACT,
    source_kind: "user",
    formation_kind: "explicit",
    scope_class: ScopeClass.PROJECT,
    content: "memory content",
    domain_tags: ["regression"],
    evidence_refs: [],
    workspace_id: WS,
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.7,
    retention_score: null,
    manifestation_state: null,
    retention_state: null,
    decay_profile: null,
    confidence: null,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: null,
    contradiction_count: null,
    superseded_by: null,
    ...overrides
  };
}

function activeConstraint(entry: MemoryEntry): SoulActiveConstraint {
  return {
    object_id: entry.object_id,
    object_kind: entry.object_kind,
    content: entry.content,
    dimension: entry.dimension,
    scope_class: entry.scope_class,
    governance_state: {
      claim_status: null,
      governance_class: null,
      source_channels: ["dimension"]
    }
  };
}

function pathRelation(sourceId: string, targetId: string): PathRelation {
  return {
    path_id: `path-${sourceId}-${targetId}`,
    workspace_id: WS,
    anchors: {
      source_anchor: { kind: "object", object_id: sourceId },
      target_anchor: { kind: "object", object_id: targetId }
    },
    constitution: {
      relation_kind: "co_usage",
      why_this_relation_exists: ["regression fixture"]
    },
    effect_vector: {
      salience: 1,
      recall_bias: 1,
      verification_bias: 0,
      unfinishedness_bias: 0,
      default_manifestation_preference: "lens_entry"
    },
    plasticity_state: {
      strength: 1,
      direction_bias: "bidirectional_asymmetric",
      stability_class: "stable",
      support_events_count: 3,
      contradiction_events_count: 0,
      last_reinforced_at: NOW
    },
    lifecycle: {
      status: "active",
      retirement_rule: "janitor_ttl_low_strength"
    },
    legitimacy: {
      evidence_basis: ["regression"],
      governance_class: "recall_allowed"
    },
    created_at: NOW,
    updated_at: NOW
  };
}

function task(display_name = "recall regression"): TaskObjectSurface {
  return {
    runtime_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: "2026-05-18T01:00:00.000Z",
    derived_from: null,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: "build",
    display_name,
    context_refs: []
  };
}
