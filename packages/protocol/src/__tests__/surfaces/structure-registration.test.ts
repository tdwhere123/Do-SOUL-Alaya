import { describe, expect, it } from "vitest";
import {
  BindingState,
  ClaimKind,
  ConflictEdgeType,
  ConflictMatrixEdgeSchema,
  CrossCuttingPermissionSchema,
  CrossCuttingState,
  FlipConditionKind,
  ObjectKind,
  ProjectMappingAnchorSchema,
  ProjectMappingState,
  ScopeClass,
  SlotSchema,
  SurfaceAnchorKind,
  SurfaceAnchorSchema,
  SurfaceBindingSchema,
  SurfaceIdentitySchema,
  SurfaceStatus,
  canonicalGovernanceSubject
} from "../../index.js";

function without<T extends Record<string, unknown>, K extends keyof T>(value: T, key: K): Omit<T, K> {
  const clone = { ...value };
  delete clone[key];
  return clone;
}

const validTimestamp = "2026-03-20T00:00:00.000Z";

const persistentEnvelopeBase = {
  object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
  schema_version: 1,
  created_at: validTimestamp,
  updated_at: validTimestamp,
  created_by: "user",
  lifecycle_state: "active"
} as const;

const slotBase = {
  ...persistentEnvelopeBase,
  object_kind: ObjectKind.SLOT,
  governance_subject: canonicalGovernanceSubject("code_style", { language: "typescript" }),
  claim_kind: ClaimKind.CONSTRAINT,
  scope_class: ScopeClass.PROJECT,
  winner_claim_id: null,
  incumbent_since: null,
  flip_conditions: [
    {
      condition_kind: FlipConditionKind.STRONGER_EVIDENCE,
      description: "Incoming claim has stronger evidence.",
      threshold: null
    }
  ],
  workspace_id: "workspace-1"
} as const;

const surfaceIdentityBase = {
  ...persistentEnvelopeBase,
  object_id: "d5a1f2a8-9ea1-4521-9f5c-5aaf573d01f6",
  object_kind: ObjectKind.SURFACE_IDENTITY,
  surface_id: "surface://main",
  surface_kind: "chat",
  surface_status: SurfaceStatus.ACTIVE,
  workspace_id: "workspace-1"
} as const;

const surfaceAnchorBase = {
  ...persistentEnvelopeBase,
  object_id: "64cabaa9-7e2f-4131-b4c3-e8dc0dc6ad3f",
  object_kind: ObjectKind.SURFACE_ANCHOR,
  surface_id: "surface://main",
  anchor_kind: SurfaceAnchorKind.PATH_FRAGMENT,
  anchor_value: "packages/protocol/src",
  workspace_id: "workspace-1"
} as const;

const surfaceBindingBase = {
  ...persistentEnvelopeBase,
  object_id: "58f6f3e9-88a2-48d4-b6fd-f32a0cfb63f8",
  object_kind: ObjectKind.SURFACE_BINDING,
  surface_id: "surface://main",
  is_primary: true,
  binding_state: BindingState.ACTIVE,
  workspace_id: "workspace-1"
} as const;

const conflictMatrixEdgeBase = {
  ...persistentEnvelopeBase,
  object_id: "73595f53-6cd3-42ec-97ed-cf7e1a8a7fae",
  object_kind: ObjectKind.CONFLICT_MATRIX_EDGE,
  source_claim_id: "claim-1",
  target_claim_id: "claim-2",
  edge_type: ConflictEdgeType.INCOMPATIBLE_WITH,
  created_at: validTimestamp,
  workspace_id: "workspace-1"
} as const;

const crossCuttingPermissionBase = {
  ...persistentEnvelopeBase,
  object_id: "object-1",
  object_kind: ObjectKind.CROSS_CUTTING_PERMISSION,
  cross_cutting_state: CrossCuttingState.CANDIDATE,
  allowed_surfaces: ["surface://main", "surface://review"],
  workspace_id: "workspace-1"
} as const;

const projectMappingAnchorBase = {
  ...persistentEnvelopeBase,
  object_id: "d82e1cb2-534f-4953-aecf-b3f8d6d44150",
  object_kind: ObjectKind.PROJECT_MAPPING_ANCHOR,
  global_object_id: "global-1",
  project_id: "project-1",
  mapping_state: ProjectMappingState.SUGGESTED,
  workspace_id: "workspace-1",
  accepted_by: null,
  last_transition_at: validTimestamp
} as const;

describe("Structure Registration Schemas", () => {
  it("parses Slot round-trip", () => {
    expect(SlotSchema.parse(slotBase)).toEqual(slotBase);
  });

  it("requires the full Slot triad key fields", () => {
    const keyFields = ["governance_subject", "claim_kind", "scope_class"] as const;

    for (const field of keyFields) {
      expect(SlotSchema.safeParse(without(slotBase, field)).success).toBe(false);
    }
  });

  it("accepts nullable Slot hysteresis fields", () => {
    const parsed = SlotSchema.parse(slotBase);
    expect(parsed.winner_claim_id).toBeNull();
    expect(parsed.incumbent_since).toBeNull();
    expect(parsed.flip_conditions[0]!.threshold).toBeNull();
  });

  it("keeps FlipConditionKind enum complete and closed", () => {
    expect(Object.values(FlipConditionKind)).toEqual([
      "stronger_evidence",
      "higher_authority",
      "user_override",
      "scope_escalation",
      "time_decay"
    ]);
  });

  it("parses SurfaceIdentity round-trip", () => {
    expect(SurfaceIdentitySchema.parse(surfaceIdentityBase)).toEqual(surfaceIdentityBase);
  });

  it("keeps SurfaceStatus enum complete and closed", () => {
    expect(Object.values(SurfaceStatus)).toEqual(["active", "weakly_bound", "orphaned", "revoked"]);
  });

  it("keeps SurfaceAnchorKind enum complete and closed", () => {
    expect(Object.values(SurfaceAnchorKind)).toEqual([
      "semantic_landmark",
      "path_fragment",
      "artifact_ref",
      "symbol_ref"
    ]);
  });

  it("parses SurfaceBinding round-trip", () => {
    expect(SurfaceBindingSchema.parse(surfaceBindingBase)).toEqual(surfaceBindingBase);
  });

  it("keeps BindingState enum complete and closed", () => {
    expect(Object.values(BindingState)).toEqual(["active", "stale", "detached"]);
  });

  it("parses ConflictMatrixEdge round-trip", () => {
    expect(ConflictMatrixEdgeSchema.parse(conflictMatrixEdgeBase)).toEqual(conflictMatrixEdgeBase);
  });

  it("keeps ConflictEdgeType enum complete and closed", () => {
    expect(Object.values(ConflictEdgeType)).toEqual([
      "incompatible_with",
      "exception_to",
      "supersedes",
      "overrides_within_scope",
      "supports",
      "derives_from"
    ]);
  });

  it("parses CrossCuttingPermission round-trip", () => {
    expect(CrossCuttingPermissionSchema.parse(crossCuttingPermissionBase)).toEqual(crossCuttingPermissionBase);
  });

  it("keeps CrossCuttingState enum complete and closed", () => {
    expect(Object.values(CrossCuttingState)).toEqual(["none", "candidate", "active", "revoked"]);
  });

  it("parses ProjectMappingAnchor round-trip", () => {
    expect(ProjectMappingAnchorSchema.parse(projectMappingAnchorBase)).toEqual(projectMappingAnchorBase);
  });

  it("keeps ProjectMappingState enum complete and closed", () => {
    expect(Object.values(ProjectMappingState)).toEqual([
      "suggested",
      "probationary",
      "accepted",
      "adapted",
      "rejected",
      "not_applicable"
    ]);
  });

  it("enforces correct object_kind literals across all structure-registration schemas", () => {
    expect(SlotSchema.safeParse({ ...slotBase, object_kind: ObjectKind.SURFACE_IDENTITY }).success).toBe(false);
    expect(SurfaceIdentitySchema.safeParse({ ...surfaceIdentityBase, object_kind: ObjectKind.SLOT }).success).toBe(false);
    expect(SurfaceAnchorSchema.safeParse({ ...surfaceAnchorBase, object_kind: ObjectKind.SLOT }).success).toBe(false);
    expect(SurfaceBindingSchema.safeParse({ ...surfaceBindingBase, object_kind: ObjectKind.SLOT }).success).toBe(false);
    expect(
      ConflictMatrixEdgeSchema.safeParse({ ...conflictMatrixEdgeBase, object_kind: ObjectKind.SLOT }).success
    ).toBe(false);
    expect(
      CrossCuttingPermissionSchema.safeParse({
        ...crossCuttingPermissionBase,
        object_kind: ObjectKind.SLOT
      }).success
    ).toBe(false);
    expect(
      ProjectMappingAnchorSchema.safeParse({
        ...projectMappingAnchorBase,
        object_kind: ObjectKind.SLOT
      }).success
    ).toBe(false);
  });
});
