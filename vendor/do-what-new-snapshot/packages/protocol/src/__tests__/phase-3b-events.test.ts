import { describe, expect, it } from "vitest";
import { EventTypeSchema } from "../event-log.js";
import {
  Phase3BEventType,
  Phase3BEventTypeSchema,
  Phase3BEventUnionSchema,
  parsePhase3BEventPayload
} from "../events/phase-3b.js";

const validTimestamp = "2026-03-24T00:00:00.000Z";

describe("Phase 3B event schemas", () => {
  it("keeps Phase3BEventType enum complete and closed", () => {
    const expected = [
      "soul.session_override.applied",
      "soul.session_override.promoted",
      "soul.green.granted",
      "soul.green.pierced",
      "soul.verification.completed",
      "soul.governance_lease.acquired",
      "soul.governance_lease.released",
      "soul.governance_lease.pierced"
    ];

    expect(Object.values(Phase3BEventType)).toEqual(expected);
    expect(Phase3BEventTypeSchema.options).toEqual(expected);
    expect(() => Phase3BEventTypeSchema.parse("soul.unknown.event")).toThrow();
  });

  it("parses all phase-3b payloads", () => {
    const appliedPayload = {
      override_id: "11111111-1111-4111-8111-111111111111",
      target_object: "memory:build-style",
      correction: "Use pnpm instead of npm.",
      priority: 2,
      run_id: "run-1",
      expires_at: "2026-03-24T01:00:00.000Z",
      derived_from: "msg_user_1",
      occurred_at: validTimestamp
    } as const;
    expect(parsePhase3BEventPayload(Phase3BEventType.SOUL_SESSION_OVERRIDE_APPLIED, appliedPayload)).toEqual(
      appliedPayload
    );

    const promotedPayload = {
      override_id: "11111111-1111-4111-8111-111111111111",
      target_object: "memory:build-style",
      dimension: "preference",
      promotion_outcome: "durable",
      occurred_at: validTimestamp
    } as const;
    expect(parsePhase3BEventPayload(Phase3BEventType.SOUL_SESSION_OVERRIDE_PROMOTED, promotedPayload)).toEqual(
      promotedPayload
    );

    const greenGrantedPayload = {
      object_id: "green-1",
      target_object_id: "memory-1",
      verification_basis: "user_reconfirm",
      valid_until: "2026-03-25T00:00:00.000Z",
      bound_scope_class: "project",
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;
    expect(parsePhase3BEventPayload(Phase3BEventType.SOUL_GREEN_GRANTED, greenGrantedPayload)).toEqual(
      greenGrantedPayload
    );

    const greenPiercedPayload = {
      object_id: "green-1",
      target_object_id: "memory-1",
      revoke_reason: "verification_failed",
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;
    expect(parsePhase3BEventPayload(Phase3BEventType.SOUL_GREEN_PIERCED, greenPiercedPayload)).toEqual(
      greenPiercedPayload
    );

    const verificationPayload = {
      target_object_id: "memory-1",
      verdict: "go",
      micro_correction_hint: null,
      consecutive_no_go_count: 0,
      workspace_id: "workspace-1",
      occurred_at: validTimestamp
    } as const;
    expect(
      parsePhase3BEventPayload(Phase3BEventType.SOUL_VERIFICATION_COMPLETED, verificationPayload)
    ).toEqual(verificationPayload);

    const leaseAcquiredPayload = {
      lease_id: "lease-1",
      holder: "conversation_service",
      run_id: "run-1",
      expires_at: "2026-03-24T01:00:00.000Z",
      occurred_at: validTimestamp
    } as const;
    expect(
      parsePhase3BEventPayload(Phase3BEventType.SOUL_GOVERNANCE_LEASE_ACQUIRED, leaseAcquiredPayload)
    ).toEqual(leaseAcquiredPayload);

    const leaseReleasedPayload = {
      lease_id: "lease-1",
      run_id: "run-1",
      occurred_at: validTimestamp
    } as const;
    expect(
      parsePhase3BEventPayload(Phase3BEventType.SOUL_GOVERNANCE_LEASE_RELEASED, leaseReleasedPayload)
    ).toEqual(leaseReleasedPayload);

    const leasePiercedPayload = {
      lease_id: "lease-1",
      piercing_condition_kind: "unsubmitted_changes",
      run_id: "run-1",
      occurred_at: validTimestamp
    } as const;
    expect(
      parsePhase3BEventPayload(Phase3BEventType.SOUL_GOVERNANCE_LEASE_PIERCED, leasePiercedPayload)
    ).toEqual(leasePiercedPayload);
  });

  it("throws for unknown phase-3b event types", () => {
    expect(() =>
      parsePhase3BEventPayload("soul.unknown.event" as never, {
        occurred_at: validTimestamp
      })
    ).toThrow();
  });

  it("accepts legacy session-override payloads without derived_from", () => {
    expect(
      parsePhase3BEventPayload(Phase3BEventType.SOUL_SESSION_OVERRIDE_APPLIED, {
        override_id: "11111111-1111-4111-8111-111111111111",
        target_object: "memory:build-style",
        correction: "Use pnpm instead of npm.",
        priority: 2,
        run_id: "run-1",
        expires_at: "2026-03-24T01:00:00.000Z",
        occurred_at: validTimestamp
      })
    ).toEqual({
      override_id: "11111111-1111-4111-8111-111111111111",
      target_object: "memory:build-style",
      correction: "Use pnpm instead of npm.",
      priority: 2,
      run_id: "run-1",
      expires_at: "2026-03-24T01:00:00.000Z",
      occurred_at: validTimestamp
    });
  });

  it("rejects unsupported governance-lease piercing condition kinds", () => {
    expect(() =>
      parsePhase3BEventPayload(Phase3BEventType.SOUL_GOVERNANCE_LEASE_PIERCED, {
        lease_id: "lease-1",
        piercing_condition_kind: "invalid_condition",
        run_id: "run-1",
        occurred_at: validTimestamp
      })
    ).toThrow();
  });

  it("discriminates correctly on type", () => {
    const event = {
      type: Phase3BEventType.SOUL_GREEN_GRANTED,
      payload: {
        object_id: "green-1",
        target_object_id: "memory-1",
        verification_basis: "user_reconfirm",
        valid_until: null,
        bound_scope_class: null,
        workspace_id: "workspace-1",
        occurred_at: validTimestamp
      }
    } as const;

    expect(Phase3BEventUnionSchema.parse(event)).toEqual(event);
  });

  it("accepts phase-3b event types in EventType union", () => {
    expect(EventTypeSchema.parse(Phase3BEventType.SOUL_SESSION_OVERRIDE_APPLIED)).toBe(
      Phase3BEventType.SOUL_SESSION_OVERRIDE_APPLIED
    );
    expect(EventTypeSchema.parse(Phase3BEventType.SOUL_GREEN_GRANTED)).toBe(
      Phase3BEventType.SOUL_GREEN_GRANTED
    );
  });
});
