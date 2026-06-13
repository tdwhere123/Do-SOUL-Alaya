import { vi } from "vitest";
import {
  ControlPlaneObjectKind,
  MemoryDimension,
  RetentionPolicy,
  ScopeClass,
  StorageTier,
  type EvidenceCapsule,
  type EventLogEntry,
  type MemoryEntry,
  type PathRelation,
  type RecallCandidate,
  type RecallPolicy,
  type Slot,
  type SoulActiveConstraint,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import type { RecallServiceDependencies } from "../../recall/recall-service.js";

export const WS = "workspace-regression";
export const NOW = "2026-05-18T00:00:00.000Z";

export function candidate(
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

export function fineConfig(
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

export function withBudgets(
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

export function withEmbedding(policy: RecallPolicy): RecallPolicy {
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

export function deps(
  memories: readonly MemoryEntry[],
  options: {
    readonly activeConstraints?: readonly Readonly<SoulActiveConstraint>[];
    readonly activeConstraintsPort?: RecallServiceDependencies["activeConstraintsPort"];
    readonly embeddingRecallService?: RecallServiceDependencies["embeddingRecallService"];
    readonly pathExpansionPort?: RecallServiceDependencies["pathExpansionPort"];
    readonly queryByEntity?: RecallServiceDependencies["eventLogRepo"]["queryByEntity"];
    readonly evidenceSearchPort?: RecallServiceDependencies["evidenceSearchPort"];
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
        searchByKeyword: options.searchByKeyword,
        findByEvidenceRefs: async (_workspaceId, evidenceObjectIds) =>
          memories.filter((entry) =>
            entry.evidence_refs.some((ref) => evidenceObjectIds.includes(ref))
          )
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
      pathExpansionPort: options.pathExpansionPort,
      evidenceSearchPort: options.evidenceSearchPort
    }
  };
}

export function memory(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
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

export function evidenceCapsule(objectId: string, artifactRef: string): EvidenceCapsule {
  return {
    object_id: objectId,
    object_kind: "evidence_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: NOW,
    updated_at: NOW,
    created_by: "test",
    evidence_kind: "external_reference",
    semantic_anchor: {
      topic: "regression",
      keywords: ["regression"],
      summary: "source chunk"
    },
    event_anchor: null,
    physical_anchor: {
      file_path: null,
      line_range: null,
      symbol_name: null,
      artifact_ref: artifactRef
    },
    evidence_health_state: "verified",
    gist: "source chunk",
    excerpt: "source chunk",
    source_hash: null,
    run_id: "run-regression",
    workspace_id: WS,
    surface_id: null
  };
}

export function activeConstraint(entry: MemoryEntry): SoulActiveConstraint {
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

export function pathRelation(sourceId: string, targetId: string): PathRelation {
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

export function task(display_name = "recall regression"): TaskObjectSurface {
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
