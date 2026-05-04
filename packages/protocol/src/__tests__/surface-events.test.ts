import { describe, expect, it } from "vitest";
import {
  BindingState,
  CrossCuttingState,
  EventTypeSchema,
  SurfaceEventType,
  SurfaceEventTypeSchema,
  SurfaceAnchorKind,
  SurfaceStatus,
  TransitionCausedBy,
  parseSurfaceEventPayload
} from "../index.js";

const validTimestamp = "2026-03-21T00:00:00.000Z";

describe("Phase 2B event schemas", () => {
  it("keeps SurfaceEventType enum complete and closed", () => {
    const expected = [
      "soul.surface.created",
      "soul.surface.status_changed",
      "soul.surface_anchor.created",
      "soul.surface_anchor.deleted",
      "soul.surface_binding.created",
      "soul.surface_binding.state_changed",
      "soul.cross_cutting.state_changed"
    ];

    expect(Object.values(SurfaceEventType)).toEqual(expected);
    expect(SurfaceEventTypeSchema.options).toEqual(expected);
  });

  it("parses soul.surface.created payload", () => {
    const payload = {
      object_id: "surface-object-1",
      object_kind: "surface_identity",
      workspace_id: "workspace-1",
      run_id: null,
      surface_id: "surface://main",
      surface_kind: "conversation",
      surface_status: SurfaceStatus.ACTIVE
    } as const;

    expect(parseSurfaceEventPayload(SurfaceEventType.SOUL_SURFACE_CREATED, payload)).toEqual(payload);
  });

  it("parses soul.surface.status_changed payload", () => {
    const payload = {
      object_id: "surface-object-1",
      object_kind: "surface_identity",
      workspace_id: "workspace-1",
      run_id: null,
      surface_id: "surface://main",
      from_status: SurfaceStatus.ACTIVE,
      to_status: SurfaceStatus.WEAKLY_BOUND,
      reason_code: "anchor_degradation",
      caused_by: TransitionCausedBy.SYSTEM,
      occurred_at: validTimestamp
    } as const;

    expect(parseSurfaceEventPayload(SurfaceEventType.SOUL_SURFACE_STATUS_CHANGED, payload)).toEqual(payload);
  });

  it("parses soul.surface_anchor.created payload", () => {
    const payload = {
      object_id: "anchor-object-1",
      object_kind: "surface_anchor",
      workspace_id: "workspace-1",
      run_id: null,
      surface_id: "surface://main",
      anchor_kind: SurfaceAnchorKind.PATH_FRAGMENT,
      anchor_value: "apps/core-daemon/src"
    } as const;

    expect(parseSurfaceEventPayload(SurfaceEventType.SOUL_SURFACE_ANCHOR_CREATED, payload)).toEqual(payload);
  });

  it("parses soul.surface_anchor.deleted payload", () => {
    const payload = {
      anchor_id: "anchor-object-1",
      surface_id: "surface://main",
      workspace_id: "workspace-1"
    } as const;

    expect(parseSurfaceEventPayload(SurfaceEventType.SOUL_SURFACE_ANCHOR_DELETED, payload)).toEqual(payload);
  });

  it("parses soul.surface_binding.created payload", () => {
    const payload = {
      binding_id: "binding-object-1",
      object_id: "claim://object-1",
      object_kind: "surface_binding",
      workspace_id: "workspace-1",
      run_id: null,
      surface_id: "surface://main",
      is_primary: true,
      binding_state: BindingState.ACTIVE
    } as const;

    expect(parseSurfaceEventPayload(SurfaceEventType.SOUL_SURFACE_BINDING_CREATED, payload)).toEqual(
      payload
    );
  });

  it("parses soul.surface_binding.state_changed payload", () => {
    const payload = {
      binding_id: "binding-object-1",
      object_id: "claim://object-1",
      surface_id: "surface://main",
      from_state: BindingState.ACTIVE,
      to_state: BindingState.STALE,
      reason: "anchor_degradation",
      occurred_at: validTimestamp,
      workspace_id: "workspace-1"
    } as const;

    expect(
      parseSurfaceEventPayload(SurfaceEventType.SOUL_SURFACE_BINDING_STATE_CHANGED, payload)
    ).toEqual(payload);
  });

  it("parses soul.cross_cutting.state_changed payload with null from_state", () => {
    const payload = {
      permission_id: "permission-object-1",
      object_id: "claim://object-1",
      from_state: null,
      to_state: CrossCuttingState.NONE,
      allowed_surfaces: [],
      reason: "initialized",
      occurred_at: validTimestamp,
      workspace_id: "workspace-1"
    } as const;

    expect(
      parseSurfaceEventPayload(SurfaceEventType.SOUL_CROSS_CUTTING_STATE_CHANGED, payload)
    ).toEqual(payload);
  });

  it("parses soul.cross_cutting.state_changed payload", () => {
    const payload = {
      permission_id: "permission-object-1",
      object_id: "claim://object-1",
      from_state: CrossCuttingState.CANDIDATE,
      to_state: CrossCuttingState.ACTIVE,
      allowed_surfaces: ["surface://main", "surface://secondary"],
      reason: "review_accepted",
      occurred_at: validTimestamp,
      workspace_id: "workspace-1"
    } as const;

    expect(
      parseSurfaceEventPayload(SurfaceEventType.SOUL_CROSS_CUTTING_STATE_CHANGED, payload)
    ).toEqual(payload);
  });

  it("accepts surface event types in EventType union", () => {
    expect(EventTypeSchema.parse(SurfaceEventType.SOUL_SURFACE_CREATED)).toBe(
      SurfaceEventType.SOUL_SURFACE_CREATED
    );
    expect(EventTypeSchema.parse(SurfaceEventType.SOUL_SURFACE_ANCHOR_DELETED)).toBe(
      SurfaceEventType.SOUL_SURFACE_ANCHOR_DELETED
    );
    expect(EventTypeSchema.parse(SurfaceEventType.SOUL_SURFACE_BINDING_STATE_CHANGED)).toBe(
      SurfaceEventType.SOUL_SURFACE_BINDING_STATE_CHANGED
    );
    expect(EventTypeSchema.parse(SurfaceEventType.SOUL_CROSS_CUTTING_STATE_CHANGED)).toBe(
      SurfaceEventType.SOUL_CROSS_CUTTING_STATE_CHANGED
    );
  });
});
