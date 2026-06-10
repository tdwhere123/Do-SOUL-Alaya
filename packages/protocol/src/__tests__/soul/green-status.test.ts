import { describe, expect, it } from "vitest";
import {
  GreenState,
  GreenStateSchema,
  GreenStatusSchema,
  ObjectKindSchema,
  RevokeReasonSchema,
  VerificationBasisSchema,
  VerifiedBySchema,
  VERIFICATION_VALID_UNTIL_BY_DIMENSION
} from "../../index.js";

const baseGreenStatus = {
  object_id: "9bc1a292-e9c2-47f9-9c6f-bf6b67c810f3",
  object_kind: "green_status",
  schema_version: 1,
  lifecycle_state: "active",
  created_at: "2026-03-24T00:00:00.000Z",
  updated_at: "2026-03-24T00:00:00.000Z",
  created_by: "system",
  target_object_id: "d52ab1f4-bcb3-414e-a0d0-7099e491a652",
  target_object_kind: "memory_entry",
  green_state: "eligible",
  verification_basis: "active_verification",
  verified_by: "review",
  verified_at: "2026-03-24T00:00:00.000Z",
  valid_until: "2026-04-23T00:00:00.000Z",
  bound_surfaces: ["surface://repo/path.ts"],
  bound_scope_class: "project",
  revoke_reason: "none",
  last_transition_at: "2026-03-24T00:00:00.000Z",
  workspace_id: "workspace-1"
} as const;

describe("GreenStatusSchema", () => {
  it("round-trips all green_state values", () => {
    for (const greenState of [GreenState.ELIGIBLE, GreenState.GRACE, GreenState.REVOKED]) {
      expect(GreenStatusSchema.parse({ ...baseGreenStatus, green_state: greenState })).toMatchObject({
        green_state: greenState
      });
    }
  });

  it("rejects missing required fields", () => {
    expect(() => GreenStatusSchema.parse({ ...baseGreenStatus, target_object_id: undefined })).toThrow();
  });

  it("exposes stable enum sizes and values", () => {
    expect(GreenStateSchema.options).toEqual(["eligible", "grace", "revoked"]);
    expect(VerificationBasisSchema.options).toEqual([
      "passive_stable",
      "active_verification",
      "deterministic_check",
      "user_reconfirm"
    ]);
    expect(RevokeReasonSchema.options).toEqual([
      "correction_open",
      "contested",
      "verification_fail",
      "external_invalidation",
      "security_hit",
      "surface_detached",
      "mapping_revoked",
      "review_overdue",
      "none"
    ]);
    expect(VerifiedBySchema.options).toEqual([
      "auditor",
      "deterministic_checker",
      "user",
      "review"
    ]);
  });

  it("adds green_status to object kinds", () => {
    expect(ObjectKindSchema.parse("green_status")).toBe("green_status");
  });

  it("keeps the valid-until defaults aligned with the brief", () => {
    expect(VERIFICATION_VALID_UNTIL_BY_DIMENSION.preference).toBeNull();
    expect(VERIFICATION_VALID_UNTIL_BY_DIMENSION.episode).toBeNull();
    expect(VERIFICATION_VALID_UNTIL_BY_DIMENSION.fact).toBe(30);
    expect(VERIFICATION_VALID_UNTIL_BY_DIMENSION.glossary).toBe(30);
    expect(VERIFICATION_VALID_UNTIL_BY_DIMENSION.constraint).toBe(14);
    expect(VERIFICATION_VALID_UNTIL_BY_DIMENSION.procedure).toBe(14);
    expect(VERIFICATION_VALID_UNTIL_BY_DIMENSION.hazard).toBe(7);
    expect(VERIFICATION_VALID_UNTIL_BY_DIMENSION.decision).toBeNull();
  });
});