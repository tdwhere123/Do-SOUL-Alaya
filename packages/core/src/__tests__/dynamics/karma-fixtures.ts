import {
  FormationKind,
  MemoryDimension,
  ScopeClass,
  SourceKind,
  StorageTier,
  type KarmaEvent,
  type MemoryEntry
} from "@do-soul/alaya-protocol";

export function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "memory-1",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-20T00:00:00.000Z",
    updated_at: "2026-03-20T00:00:00.000Z",
    created_by: "user",
    dimension: MemoryDimension.FACT,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "content",
    domain_tags: ["workflow"],
    evidence_refs: ["evidence-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.2,
    retention_score: 0.2,
    manifestation_state: "hint",
    retention_state: "working",
    decay_profile: "normal",
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

export function createKarmaEvent(overrides: Partial<KarmaEvent> = {}): KarmaEvent {
  return {
    event_id: "event-1",
    kind: "accept_gain",
    object_id: "memory-1",
    amount: 0.15,
    created_at: "2026-03-23T00:00:00.000Z",
    workspace_id: "workspace-1",
    ...overrides
  };
}
