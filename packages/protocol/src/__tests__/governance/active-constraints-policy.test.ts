import { describe, expect, it } from "vitest";
import {
  ClaimLifecycleState,
  FormationKind,
  MemoryDimension,
  PathGovernanceClass,
  ScopeClass,
  SourceKind,
  StorageTier,
  canonicalGovernanceSubject,
  selectActiveConstraintRecords,
  type ClaimForm,
  type MemoryEntry,
  type PathRelation
} from "@do-soul/alaya-protocol";

describe("selectActiveConstraintRecords", () => {
  it("returns governance-backed constraints and excludes draft dimension-only memories", () => {
    const dimensionOnlyConstraints = Array.from({ length: 2 }, (_, index) =>
      createMemoryEntry({
        object_id: constraintId(index + 1),
        dimension: MemoryDimension.CONSTRAINT,
        content: `Draft-only hard rule ${index + 1}`,
        created_at: `2026-05-18T00:0${index}:00.000Z`,
        updated_at: `2026-05-18T00:0${index}:00.000Z`
      })
    );
    const claimBackedMemory = createMemoryEntry({
      object_id: CLAIM_BACKED_MEMORY_ID,
      dimension: MemoryDimension.PROCEDURE,
      content: "Procedure backed by active claim.",
      created_at: "2026-05-18T00:10:00.000Z",
      updated_at: "2026-05-18T00:10:00.000Z"
    });
    const claimBackedConstraint = createMemoryEntry({
      object_id: CLAIM_BACKED_CONSTRAINT_ID,
      dimension: MemoryDimension.CONSTRAINT,
      content: "Constraint backed by a winning claim.",
      created_at: "2026-05-18T00:09:00.000Z",
      updated_at: "2026-05-18T00:09:00.000Z"
    });
    const pathBackedMemory = createMemoryEntry({
      object_id: PATH_BACKED_MEMORY_ID,
      dimension: MemoryDimension.FACT,
      content: "Fact backed by a strictly governed path.",
      created_at: "2026-05-18T00:11:00.000Z",
      updated_at: "2026-05-18T00:11:00.000Z"
    });
    const archivedClaimBackedMemory = createMemoryEntry({
      object_id: ARCHIVED_CLAIM_BACKED_MEMORY_ID,
      dimension: MemoryDimension.PROCEDURE,
      content: "Archived procedure backed by active claim.",
      lifecycle_state: "archived",
      created_at: "2026-05-18T00:12:00.000Z",
      updated_at: "2026-05-18T00:12:00.000Z"
    });
    const tombstonedPathBackedMemory = createMemoryEntry({
      object_id: TOMBSTONED_PATH_BACKED_MEMORY_ID,
      dimension: MemoryDimension.FACT,
      content: "Tombstoned fact backed by a strictly governed path.",
      retention_state: "tombstoned",
      created_at: "2026-05-18T00:13:00.000Z",
      updated_at: "2026-05-18T00:13:00.000Z"
    });

    const result = selectActiveConstraintRecords({
      workspaceId: "workspace-1",
      memories: [
        ...dimensionOnlyConstraints,
        claimBackedMemory,
        claimBackedConstraint,
        pathBackedMemory,
        archivedClaimBackedMemory,
        tombstonedPathBackedMemory
      ],
      claims: [
        createClaimForm({
          object_id: "20000000-0000-4000-8000-000000000010",
          source_object_refs: [constraintId(1)],
          claim_status: ClaimLifecycleState.DRAFT
        }),
        createClaimForm({
          object_id: "20000000-0000-4000-8000-000000000001",
          source_object_refs: [CLAIM_BACKED_MEMORY_ID],
          claim_status: ClaimLifecycleState.ACTIVE
        }),
        createClaimForm({
          object_id: "20000000-0000-4000-8000-000000000003",
          source_object_refs: [CLAIM_BACKED_CONSTRAINT_ID],
          claim_status: ClaimLifecycleState.WINNER
        }),
        createClaimForm({
          object_id: "20000000-0000-4000-8000-000000000002",
          source_object_refs: [ARCHIVED_CLAIM_BACKED_MEMORY_ID],
          claim_status: ClaimLifecycleState.ACTIVE
        })
      ],
      paths: [
        createPathRelation({
          path_id: "strict-path-1",
          anchors: {
            source_anchor: { kind: "object", object_id: PATH_BACKED_MEMORY_ID },
            target_anchor: { kind: "object", object_id: "missing-memory" }
          },
          legitimacy: {
            evidence_basis: ["evidence-1"],
            governance_class: PathGovernanceClass.STRICTLY_GOVERNED
          }
        }),
        createPathRelation({
          path_id: "strict-path-2",
          anchors: {
            source_anchor: { kind: "object", object_id: TOMBSTONED_PATH_BACKED_MEMORY_ID },
            target_anchor: { kind: "object", object_id: "missing-memory-2" }
          },
          legitimacy: {
            evidence_basis: ["evidence-1"],
            governance_class: PathGovernanceClass.STRICTLY_GOVERNED
          }
        })
      ]
    });

    expect(result.total_count).toBe(3);
    expect(result.constraints.map((record) => record.memory.object_id)).toEqual([
      CLAIM_BACKED_CONSTRAINT_ID,
      CLAIM_BACKED_MEMORY_ID,
      PATH_BACKED_MEMORY_ID
    ]);
    expect(result.constraints.map((record) => record.source_channels)).toEqual([
      ["claim_status"],
      ["claim_status"],
      ["path_relation"]
    ]);
    expect(result.constraints.find((record) => record.memory.object_id === CLAIM_BACKED_MEMORY_ID)?.claim_status)
      .toBe(ClaimLifecycleState.ACTIVE);
    expect(result.constraints.find((record) => record.memory.object_id === CLAIM_BACKED_CONSTRAINT_ID)?.claim_status)
      .toBe(ClaimLifecycleState.WINNER);
    expect(result.constraints.find((record) => record.memory.object_id === PATH_BACKED_MEMORY_ID)?.governance_class)
      .toBe(PathGovernanceClass.STRICTLY_GOVERNED);
    expect(result.constraints.map((record) => record.memory.object_id)).not.toContain(constraintId(1));
    expect(result.constraints.map((record) => record.memory.object_id)).not.toContain(constraintId(2));

    const capped = selectActiveConstraintRecords({
      workspaceId: "workspace-1",
      memories: result.constraints.map((record) => record.memory),
      claims: [
        createClaimForm({
          source_object_refs: [CLAIM_BACKED_MEMORY_ID],
          claim_status: ClaimLifecycleState.ACTIVE
        }),
        createClaimForm({
          source_object_refs: [CLAIM_BACKED_CONSTRAINT_ID],
          claim_status: ClaimLifecycleState.WINNER
        })
      ],
      paths: [
        createPathRelation({
          anchors: {
            source_anchor: { kind: "object", object_id: PATH_BACKED_MEMORY_ID },
            target_anchor: { kind: "object", object_id: "missing-memory" }
          },
          legitimacy: {
            evidence_basis: ["evidence-1"],
            governance_class: PathGovernanceClass.STRICTLY_GOVERNED
          }
        })
      ],
      cap: 1
    });
    expect(capped.total_count).toBe(3);
    expect(capped.constraints).toHaveLength(1);
  });
});

const CLAIM_BACKED_MEMORY_ID = "10000000-0000-4000-8000-000000000010";
const CLAIM_BACKED_CONSTRAINT_ID = "10000000-0000-4000-8000-000000000015";
const PATH_BACKED_MEMORY_ID = "10000000-0000-4000-8000-000000000011";
const ARCHIVED_CLAIM_BACKED_MEMORY_ID = "10000000-0000-4000-8000-000000000012";
const TOMBSTONED_PATH_BACKED_MEMORY_ID = "10000000-0000-4000-8000-000000000013";

function constraintId(index: number): string {
  return `10000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "10000000-0000-4000-8000-000000000001",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-18T00:00:00.000Z",
    updated_at: "2026-05-18T00:00:00.000Z",
    created_by: "user_action",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for workspace commands.",
    domain_tags: ["workflow"],
    evidence_refs: ["evidence-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    storage_tier: StorageTier.HOT,
    activation_score: null,
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

function createClaimForm(overrides: Partial<ClaimForm> = {}): ClaimForm {
  return {
    object_id: "20000000-0000-4000-8000-000000000000",
    object_kind: "claim_form",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-05-18T00:00:00.000Z",
    updated_at: "2026-05-18T00:00:00.000Z",
    created_by: "user",
    governance_subject: canonicalGovernanceSubject("workflow", { area: "repo" }),
    claim_kind: "constraint",
    scope_class: "project",
    enforcement_level: "strict",
    origin_tier: "user_explicit",
    precedence_basis: "authority",
    proposition_digest: "Procedure is active.",
    evidence_refs: ["evidence-1"],
    source_object_refs: ["10000000-0000-4000-8000-000000000001"],
    workspace_id: "workspace-1",
    claim_status: ClaimLifecycleState.ACTIVE,
    ...overrides
  };
}

function createPathRelation(overrides: Partial<PathRelation> = {}): PathRelation {
  return {
    path_id: "path-1",
    workspace_id: "workspace-1",
    anchors: {
      source_anchor: { kind: "object", object_id: "10000000-0000-4000-8000-000000000001" },
      target_anchor: { kind: "object", object_id: "10000000-0000-4000-8000-000000000002" }
    },
    constitution: {
      relation_kind: "supports",
      why_this_relation_exists: ["evidence_alignment"]
    },
    effect_vector: {
      salience: 0.4,
      recall_bias: 0.5,
      verification_bias: 0.2,
      unfinishedness_bias: 0.1,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 0.5,
      direction_bias: "source_to_target",
      stability_class: "volatile",
      support_events_count: 2,
      contradiction_events_count: 0,
      last_reinforced_at: "2026-05-18T00:00:00.000Z"
    },
    lifecycle: {
      status: "active",
      retirement_rule: "retire_after_cooldown",
      cooldown_rule: "7d_without_support"
    },
    legitimacy: {
      evidence_basis: ["evidence-1"],
      governance_class: PathGovernanceClass.HINT_ONLY
    },
    created_at: "2026-05-18T00:00:00.000Z",
    updated_at: "2026-05-18T00:00:00.000Z",
    ...overrides
  };
}
