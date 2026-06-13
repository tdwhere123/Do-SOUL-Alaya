import {
  FormationKind,
  GreenGovernanceEventType,
  GreenState,
  MemoryDimension,
  MemoryGovernanceEventType,
  RevokeReason,
  RetentionPolicy,
  ScopeClass,
  SourceKind,
  StorageTier,
  VerificationBasis,
  VerifiedBy,
  type GreenStatus,
  type MemoryEntry,
  type Proposal,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import { initDatabase, type StorageDatabase } from "../../../sqlite/db.js";
import { SqliteProposalRepo, type ProposalResolutionEventInput } from "../../../repos/proposal/index.js";

export const trackedDatabases = new Set<ReturnType<typeof initDatabase>>();

export function createProposal(overrides: Partial<Proposal> = {}): Proposal {
  return {
    runtime_id: "24c607da-7544-47a7-a28e-d649071f77f5",
    object_kind: "proposal",
    task_surface_ref: null,
    expires_at: null,
    derived_from: "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
    retention_policy: RetentionPolicy.SESSION_ONLY,
    proposal_id: "24c607da-7544-47a7-a28e-d649071f77f5",
    dossier_ref: null,
    recommended_option_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
    proposal_options: [
      {
        option_id: "590b6f34-7ea5-4f9b-ae74-fe8d4f5af96a",
        option_kind: "request_confirmation",
        preserves_protected_constraints: true,
        dropped_candidates: [],
        unresolved_after_apply: [],
        requires_confirmation: true
      }
    ],
    resolution_state: "pending",
    last_updated_at: "2026-03-21T00:00:00.000Z",
    ...overrides
  };
}

export function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "test",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use npm for workspace commands.",
    domain_tags: ["tooling"],
    evidence_refs: ["evidence-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: 0.9,
    retention_score: 0.9,
    manifestation_state: "excerpt",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 1,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

export function createSynthesisProposal(overrides: Partial<Proposal> = {}): Proposal {
  return createProposal({
    runtime_id: "7c0d1f2e-3a4b-4c5d-8e6f-708192a3b4c5",
    proposal_id: "7c0d1f2e-3a4b-4c5d-8e6f-708192a3b4c5",
    derived_from: "synthesis-subject:tooling/package-manager",
    dossier_ref: "librarian.synthesis",
    retention_policy: RetentionPolicy.RUN_SCOPED,
    ...overrides
  });
}

export function createSynthesisCapsule(overrides: Partial<SynthesisCapsule> = {}): SynthesisCapsule {
  return {
    object_id: "a8b9c0d1-2e3f-4a5b-8c6d-7e8f90a1b2c3",
    object_kind: "synthesis_capsule",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T03:00:00.000Z",
    updated_at: "2026-03-21T03:00:00.000Z",
    created_by: "proposal_accept:7c0d1f2e-3a4b-4c5d-8e6f-708192a3b4c5",
    topic_key: "tooling/package-manager",
    synthesis_type: "cross_evidence",
    summary: "Synthesis of tooling/package-manager: prefer pnpm; npm deprecated",
    evidence_refs: ["evidence-1", "evidence-2"],
    source_memory_refs: [],
    workspace_id: "workspace-1",
    run_id: "synthesis-accept:workspace-1",
    synthesis_status: "working",
    ...overrides
  };
}

export function createGreenStatus(overrides: Partial<GreenStatus> = {}): GreenStatus {
  return {
    object_id: "9a20e051-a559-4e0c-9a9a-09221dd87453",
    object_kind: "green_status",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-21T00:00:00.000Z",
    updated_at: "2026-03-21T00:00:00.000Z",
    created_by: "system",
    target_object_id: "f8b2124d-4954-4ea0-a77e-ad4b137ed8ee",
    target_object_kind: "memory_entry",
    green_state: GreenState.ELIGIBLE,
    verification_basis: VerificationBasis.PASSIVE_STABLE,
    verified_by: VerifiedBy.AUDITOR,
    verified_at: "2026-03-21T00:00:00.000Z",
    valid_until: null,
    bound_surfaces: [],
    bound_scope_class: ScopeClass.PROJECT,
    revoke_reason: RevokeReason.NONE,
    last_transition_at: "2026-03-21T00:00:00.000Z",
    workspace_id: "workspace-1",
    ...overrides
  };
}

export function createRepo(): { readonly repo: SqliteProposalRepo; readonly database: StorageDatabase } {
  const database = initDatabase({ filename: ":memory:" });
  trackedDatabases.add(database);

  return {
    repo: new SqliteProposalRepo(database),
    database
  };
}

export function createCreationEvents(proposal: Proposal): readonly ProposalResolutionEventInput[] {
  return [
    {
      event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_CREATED,
      entity_type: "proposal",
      entity_id: proposal.proposal_id,
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "codex",
      payload_json: {
        object_id: proposal.runtime_id,
        object_kind: proposal.object_kind,
        workspace_id: "workspace-1",
        run_id: "run-1"
      }
    }
  ];
}

export function createReviewEvents(proposal: Proposal): readonly ProposalResolutionEventInput[] {
  return [
    {
      event_type: MemoryGovernanceEventType.SOUL_REVIEW_CREATED,
      entity_type: "proposal",
      entity_id: proposal.proposal_id,
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "codex",
      payload_json: {
        object_id: proposal.runtime_id,
        object_kind: proposal.object_kind,
        workspace_id: "workspace-1",
        run_id: "run-1"
      }
    },
    {
      event_type: MemoryGovernanceEventType.SOUL_REVIEW_COMPLETED,
      entity_type: "proposal",
      entity_id: proposal.proposal_id,
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "codex",
      payload_json: {
        object_id: proposal.runtime_id,
        object_kind: proposal.object_kind,
        from_state: "pending",
        to_state: "accepted"
      }
    },
    {
      event_type: MemoryGovernanceEventType.SOUL_PROPOSAL_RESOLVED,
      entity_type: "proposal",
      entity_id: proposal.proposal_id,
      workspace_id: "workspace-1",
      run_id: "run-1",
      caused_by: "codex",
      payload_json: {
        object_id: proposal.runtime_id,
        object_kind: proposal.object_kind,
        from_state: "pending",
        to_state: "accepted"
      }
    }
  ];
}

export function countProposalEvents(database: StorageDatabase, proposalId: string): number {
  const row = database.connection
    .prepare("SELECT COUNT(*) AS count FROM event_log WHERE entity_type = 'proposal' AND entity_id = ?")
    .get(proposalId) as { readonly count: number };
  return row.count;
}

export function countMemoryUpdatedEvents(database: StorageDatabase, memoryId: string): number {
  const row = database.connection
    .prepare(
      "SELECT COUNT(*) AS count FROM event_log WHERE event_type = ? AND entity_type = 'memory_entry' AND entity_id = ?"
    )
    .get(MemoryGovernanceEventType.SOUL_MEMORY_UPDATED, memoryId) as { readonly count: number };
  return row.count;
}

export function countGreenPiercedEvents(database: StorageDatabase, memoryId: string): number {
  const row = database.connection
    .prepare(
      "SELECT COUNT(*) AS count FROM event_log WHERE event_type = ? AND json_extract(payload_json, '$.target_object_id') = ?"
    )
    .get(GreenGovernanceEventType.SOUL_GREEN_PIERCED, memoryId) as { readonly count: number };
  return row.count;
}

export function countSynthesisCreatedEvents(database: StorageDatabase, synthesisId: string): number {
  const row = database.connection
    .prepare(
      "SELECT COUNT(*) AS count FROM event_log WHERE event_type = ? AND entity_type = 'synthesis_capsule' AND entity_id = ?"
    )
    .get(MemoryGovernanceEventType.SOUL_SYNTHESIS_CREATED, synthesisId) as { readonly count: number };
  return row.count;
}

export function countSynthesisCapsules(database: StorageDatabase, synthesisId: string): number {
  const row = database.connection
    .prepare("SELECT COUNT(*) AS count FROM synthesis_capsules WHERE object_id = ?")
    .get(synthesisId) as { readonly count: number };
  return row.count;
}
