import { vi } from "vitest";
import {
  ClaimKind,
  ControlPlaneObjectKind,
  EnforcementLevel,
  MemoryDimension,
  ObjectKind,
  OriginTier,
  PrecedenceBasis,
  RetentionPolicy,
  ScopeClass,
  canonicalGovernanceSubject,
  type ClaimForm,
  type EventLogEntry,
  type MemoryEntry,
  type RecallPolicy,
  type Slot,
  type TaskObjectSurface
} from "@do-soul/alaya-protocol";
import type { RecallCandidate } from "../../recall/recall-service.js";
import type { LensAssemblerDependencies } from "../../conversation/context-lens-assembler.js";

export const NOW = "2026-03-23T10:00:00.000Z";
export const EXPIRY = "2026-03-23T10:30:00.000Z";
export const TASK_SURFACE_ID = "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca";
export const PROJECT_MEMORY_ID = "9d599a9a-4940-4f23-a88e-0149f82ab021";
export const GLOBAL_MEMORY_ID = "044e4071-26af-4d75-9141-416bf414b6ac";
export const CLAIM_ID = "dd7441d2-c7e6-45e7-98f0-b77e0e4bf460";
export const SLOT_ID = "b1c61b13-69a1-49d1-9ca9-98c11e5723d0";
export const RECALL_POLICY_ID = "cb48e1ff-4c8b-4dad-87fd-6ceb30f3a2fb";

export function createDependencies(
  overrides: Partial<LensAssemblerDependencies> = {}
): LensAssemblerDependencies & {
  claimRepo: {
    findByIds: ReturnType<typeof vi.fn>;
  };
  eventLogRepo: {
    append: ReturnType<typeof vi.fn>;
    queryByEntity: ReturnType<typeof vi.fn>;
  };
  recallService: {
    recall: ReturnType<typeof vi.fn>;
    buildDefaultPolicy: ReturnType<typeof vi.fn>;
  };
} {
  const projectMemory = createMemoryEntry({
    object_id: PROJECT_MEMORY_ID,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for workspace commands.",
    evidence_refs: ["evidence-1"],
    activation_score: 0.92,
    manifestation_state: "full_eligible"
  });
  const globalMemory = createMemoryEntry({
    object_id: GLOBAL_MEMORY_ID,
    scope_class: ScopeClass.GLOBAL_DOMAIN,
    content: "Prefer deterministic tests.",
    evidence_refs: [],
    activation_score: 0.51,
    manifestation_state: "excerpt"
  });
  const memories = new Map<string, MemoryEntry>([
    [projectMemory.object_id, projectMemory],
    [globalMemory.object_id, globalMemory]
  ]);
  const claim = createClaimForm();
  const claimById = new Map<string, ClaimForm>([[claim.object_id, claim]]);
  const eventLogRepo = {
    append: vi.fn(async (entry: Omit<EventLogEntry, "event_id" | "created_at" | "revision">) => ({
      event_id: "evt-context-lens-1",
      created_at: NOW,
      revision: 0,
      ...entry
    })),
    queryByEntity: vi.fn(async () => [])
  };
  const recallService = {
    recall: vi.fn(async () => createRecallResult([createProjectCandidate(), createGlobalCandidate()])),
    buildDefaultPolicy: vi.fn((strategy: "chat" | "analyze" | "build" | "govern", taskSurfaceRef: string) =>
      createRecallPolicy(taskSurfaceRef, strategy)
    )
  };

  const defaultDependencies = {
    recallService,
    taskSurfaceBuilder: {
      build: vi.fn(async ({ displayName }) => createTaskSurface(displayName ?? "Implement ContextLens")),
      resolveStrategy: vi.fn((surfaceKind: string) => (surfaceKind === "build" ? "build" : "analyze"))
    },
    slotRepo: {
      findByWorkspace: vi.fn(async () => [createSlot()])
    },
    claimRepo: {
      findByIds: vi.fn(async (objectIds: readonly string[]) =>
        objectIds.flatMap((objectId) => {
          const loaded = claimById.get(objectId);
          return loaded === undefined ? [] : [loaded];
        })
      )
    },
    memoryRepo: {
      findByIds: vi.fn(async (objectIds: readonly string[]) =>
        objectIds.flatMap((objectId) => {
          const loaded = memories.get(objectId);
          return loaded === undefined ? [] : [loaded];
        })
      ),
      findById: vi.fn(async (objectId: string) => memories.get(objectId) ?? null)
    },
    eventLogRepo,
    warn: vi.fn(),
    generateRuntimeId: createRuntimeIdGenerator(),
    now: () => NOW
  } satisfies LensAssemblerDependencies;

  return {
    ...defaultDependencies,
    ...overrides
  } as LensAssemblerDependencies & {
    claimRepo: {
      findByIds: ReturnType<typeof vi.fn>;
    };
    eventLogRepo: {
      append: ReturnType<typeof vi.fn>;
      queryByEntity: ReturnType<typeof vi.fn>;
    };
    warn: ReturnType<typeof vi.fn>;
    recallService: {
      recall: ReturnType<typeof vi.fn>;
      buildDefaultPolicy: ReturnType<typeof vi.fn>;
    };
    memoryRepo: {
      findByIds: ReturnType<typeof vi.fn>;
      findById: ReturnType<typeof vi.fn>;
    };
  };
}

export function createRuntimeIdGenerator(nextIndex: () => number = createIncrementor()): () => string {
  return () => formatUuid(nextIndex());
}

export function createIncrementor(): () => number {
  let index = 0;
  return () => index++;
}

export function formatUuid(index: number): string {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

export function createTaskSurface(displayName: string, surfaceKind = "analyze"): TaskObjectSurface {
  return {
    runtime_id: TASK_SURFACE_ID,
    object_kind: ControlPlaneObjectKind.TASK_OBJECT_SURFACE,
    task_surface_ref: null,
    expires_at: EXPIRY,
    derived_from: "surface://chat/main",
    retention_policy: RetentionPolicy.SESSION_ONLY,
    surface_kind: surfaceKind,
    display_name: displayName,
    context_refs: []
  };
}

export function createRecallPolicy(
  taskSurfaceRef: string,
  strategy: "chat" | "analyze" | "build" | "govern"
): RecallPolicy {
  return {
    runtime_id: RECALL_POLICY_ID,
    object_kind: ControlPlaneObjectKind.RECALL_POLICY,
    task_surface_ref: taskSurfaceRef,
    expires_at: EXPIRY,
    derived_from: taskSurfaceRef,
    retention_policy: RetentionPolicy.SESSION_ONLY,
    coarse_filter: {
      deterministic_match: {
        scope_filter: strategy === "build" ? [ScopeClass.PROJECT] : null,
        dimension_filter: null,
        domain_tag_filter: null
      },
      precomputed_rank: {
        max_candidates: strategy === "analyze" ? 50 : 20,
        min_activation_score: 0.1
      },
      semantic_supplement: {
        enabled: false,
        max_supplement: 0
      }
    },
    fine_assessment: {
      budgets: {
        max_total_tokens: 2000,
        max_entries: 10,
        per_dimension_limits: null
      },
      conflict_awareness: strategy !== "chat"
    }
  };
}

export function createRecallResult(candidates: readonly Readonly<RecallCandidate>[]) {
  return Object.freeze({
    candidates: Object.freeze([...candidates]),
    active_constraints: Object.freeze([]),
    active_constraints_count: 0,
    total_scanned: candidates.length,
    coarse_filter_count: candidates.length,
    fine_assessment_count: candidates.length,
    degradation_reason: null,
    working_projection: null
  });
}

export function createProjectCandidate() {
  return Object.freeze({
    object_id: PROJECT_MEMORY_ID,
    object_kind: "memory_entry" as const,
    activation_score: 0.92,
    relevance_score: 0.92,
    content_preview: "Use pnpm for workspace commands.",
    token_estimate: 8,
    manifestation: "full_eligible" as const,
    dimension: MemoryDimension.PROCEDURE,
    scope_class: ScopeClass.PROJECT,
    origin_plane: "workspace_local" as const
  });
}

export function createGlobalCandidate() {
  return Object.freeze({
    object_id: GLOBAL_MEMORY_ID,
    object_kind: "memory_entry" as const,
    activation_score: 0.51,
    relevance_score: 0.51,
    content_preview: "Prefer deterministic tests.",
    token_estimate: 6,
    manifestation: "excerpt" as const,
    dimension: MemoryDimension.PREFERENCE,
    scope_class: ScopeClass.GLOBAL_DOMAIN,
    origin_plane: "workspace_local" as const
  });
}

export function createMemoryEntry(
  overrides: Partial<MemoryEntry> & Pick<MemoryEntry, "object_id" | "scope_class" | "content">
): MemoryEntry {
  return {
    object_id: overrides.object_id,
    object_kind: ObjectKind.MEMORY_ENTRY,
    schema_version: 1,
    created_at: NOW,
    updated_at: NOW,
    created_by: "test",
    lifecycle_state: "active",
    dimension: overrides.dimension ?? MemoryDimension.PROCEDURE,
    source_kind: overrides.source_kind ?? "user",
    formation_kind: overrides.formation_kind ?? "explicit",
    scope_class: overrides.scope_class,
    content: overrides.content,
    domain_tags: overrides.domain_tags ?? [],
    evidence_refs: overrides.evidence_refs ?? [],
    workspace_id: overrides.workspace_id ?? "workspace-1",
    run_id: overrides.run_id ?? "run-1",
    surface_id: overrides.surface_id ?? null,
    storage_tier: overrides.storage_tier ?? "hot",
    activation_score: overrides.activation_score ?? 0.8,
    retention_score: overrides.retention_score ?? 0.8,
    manifestation_state: overrides.manifestation_state ?? "full_eligible",
    retention_state: overrides.retention_state ?? "working",
    decay_profile: overrides.decay_profile ?? "normal",
    confidence: overrides.confidence ?? 0.9,
    last_used_at: overrides.last_used_at ?? NOW,
    last_hit_at: overrides.last_hit_at ?? NOW,
    reinforcement_count: overrides.reinforcement_count ?? 1,
    contradiction_count: overrides.contradiction_count ?? 0,
    superseded_by: overrides.superseded_by ?? null
  };
}

export function createClaimForm(): ClaimForm {
  return {
    object_id: CLAIM_ID,
    object_kind: ObjectKind.CLAIM_FORM,
    schema_version: 1,
    created_at: NOW,
    updated_at: NOW,
    created_by: "test",
    lifecycle_state: "active",
    governance_subject: canonicalGovernanceSubject("workflow", { area: "build" }),
    claim_kind: ClaimKind.CONSTRAINT,
    scope_class: ScopeClass.PROJECT,
    enforcement_level: EnforcementLevel.STRICT,
    origin_tier: OriginTier.USER_EXPLICIT,
    precedence_basis: PrecedenceBasis.USER_OVERRIDE,
    proposition_digest: "Always run pnpm commands from the workspace root.",
    evidence_refs: ["evidence-claim"],
    source_object_refs: [PROJECT_MEMORY_ID],
    workspace_id: "workspace-1",
    claim_status: "winner"
  };
}

export function createSlot(): Slot {
  return {
    object_id: SLOT_ID,
    object_kind: ObjectKind.SLOT,
    schema_version: 1,
    created_at: NOW,
    updated_at: NOW,
    created_by: "test",
    lifecycle_state: "active",
    governance_subject: canonicalGovernanceSubject("workflow", { area: "build" }),
    claim_kind: ClaimKind.CONSTRAINT,
    scope_class: ScopeClass.PROJECT,
    winner_claim_id: CLAIM_ID,
    incumbent_since: NOW,
    flip_conditions: [],
    workspace_id: "workspace-1"
  };
}
