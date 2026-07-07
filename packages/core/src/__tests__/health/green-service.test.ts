import { describe, expect, it, vi } from "vitest";
import { MemoryDimension, GreenGovernanceEventType, RevokeReason, ScopeClass, VerificationBasis, VerificationVerdict, type EventLogEntry } from "@do-soul/alaya-protocol";

import { createEvent, createGreenStatus, createHarness, createMemoryEntry } from "./green-service.test-support.js";
import { expectDefined, requireAt } from "../helpers/defined.js";

describe("GreenService", () => {
it("grant() creates an eligible status and emits soul.green.granted", async () => {
    const { service, statuses, events } = createHarness();

    const status = await service.grant({
      targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      workspaceId: "workspace-1",
      basis: VerificationBasis.PASSIVE_STABLE,
      validUntil: null,
      verifiedBy: "review",
      boundSurfaces: ["surface://repo/path.ts"],
      boundScopeClass: ScopeClass.PROJECT
    });

    expect(status.green_state).toBe("eligible");
    expect(statuses.get(status.target_object_id)?.green_state).toBe("eligible");
    expect(events.at(-1)?.event_type).toBe(GreenGovernanceEventType.SOUL_GREEN_GRANTED);
  });

it("grant() rejects inactive lifecycle entries", async () => {
    const { service } = createHarness({
      memory: createMemoryEntry({ lifecycle_state: "dormant" })
    });

    await expect(
      service.grant({
        targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        workspaceId: "workspace-1",
        basis: VerificationBasis.PASSIVE_STABLE,
        validUntil: null,
        verifiedBy: "review"
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

it("grant() rejects memories without evidence refs", async () => {
    const { service } = createHarness({
      memory: createMemoryEntry({ evidence_refs: [] })
    });

    await expect(
      service.grant({
        targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        workspaceId: "workspace-1",
        basis: VerificationBasis.PASSIVE_STABLE,
        validUntil: null,
        verifiedBy: "review"
      })
    ).rejects.toMatchObject({ code: "VALIDATION" });
  });

it("pierce() revokes an existing status and emits soul.green.pierced", async () => {
    const { service, statuses, events } = createHarness({
      existingStatus: createGreenStatus()
    });

    await service.pierce({
      targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      workspaceId: "workspace-1",
      reason: RevokeReason.VERIFICATION_FAIL
    });

    expect(statuses.get("70a0b18b-5f8b-4fd2-a1b0-97ce48113fca")?.green_state).toBe("revoked");
    expect(events.at(-1)?.event_type).toBe(GreenGovernanceEventType.SOUL_GREEN_PIERCED);
  });

it("reevaluate() auto-grants preference memories with evidence", async () => {
    const { service, statuses } = createHarness();

    await expect(
      service.reevaluate({
        targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        workspaceId: "workspace-1"
      })
    ).resolves.toBe("granted");

    expect(statuses.get("70a0b18b-5f8b-4fd2-a1b0-97ce48113fca")?.verification_basis).toBe("passive_stable");
  });

it("reevaluate() pierces contested entries via the status resolver", async () => {
    const { service, statuses } = createHarness({
      existingStatus: createGreenStatus(),
      governanceRole: "contested"
    });

    await expect(
      service.reevaluate({
        targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        workspaceId: "workspace-1"
      })
    ).resolves.toBe("pierced");

    expect(statuses.get("70a0b18b-5f8b-4fd2-a1b0-97ce48113fca")?.revoke_reason).toBe("contested");
  });

it("reevaluate() leaves entries without evidence unchanged", async () => {
    const { service } = createHarness({
      memory: createMemoryEntry({ evidence_refs: [] })
    });

    await expect(
      service.reevaluate({
        targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        workspaceId: "workspace-1"
      })
    ).resolves.toBe("unchanged");
  });

it("reevaluate() keeps correction_open while an active override is unresolved", async () => {
    const { service, statuses } = createHarness({
      existingStatus: createGreenStatus(),
      initialEvents: [
        createEvent({
          event_type: GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED,
          entity_type: "session_override",
          entity_id: "override-open",
          payload_json: {
            override_id: "override-open",
            target_object: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
            correction: "Use pnpm instead of npm.",
            priority: 2,
            run_id: "run-1",
            expires_at: "2026-03-24T01:00:00.000Z",
            derived_from: null,
            occurred_at: "2026-03-24T00:00:00.000Z"
          }
        })
      ]
    });

    await expect(
      service.reevaluate({
        targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        workspaceId: "workspace-1"
      })
    ).resolves.toBe("pierced");

    expect(statuses.get("70a0b18b-5f8b-4fd2-a1b0-97ce48113fca")?.revoke_reason).toBe("correction_open");
  });

it("ignores expired unresolved overrides when reevaluating correction_open", async () => {
    const { service } = createHarness({
      initialEvents: [
        createEvent({
          event_type: GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED,
          entity_type: "session_override",
          entity_id: "override-expired",
          payload_json: {
            override_id: "override-expired",
            target_object: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
            correction: "Use pnpm instead of npm.",
            priority: 2,
            run_id: "run-1",
            expires_at: "2026-03-23T23:00:00.000Z",
            derived_from: null,
            occurred_at: "2026-03-23T22:00:00.000Z"
          }
        })
      ]
    });

    await expect(
      service.reevaluate({
        targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        workspaceId: "workspace-1"
      })
    ).resolves.toBe("granted");
  });

it("keeps correction_open when the promotion audit outcome is not_promoted", async () => {
    const { service, statuses } = createHarness({
      existingStatus: createGreenStatus(),
      initialEvents: [
        createEvent({
          event_type: GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED,
          entity_type: "session_override",
          entity_id: "override-rejected",
          payload_json: {
            override_id: "override-rejected",
            target_object: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
            correction: "Use pnpm instead of npm.",
            priority: 2,
            run_id: "run-1",
            expires_at: "2026-03-24T01:00:00.000Z",
            derived_from: null,
            occurred_at: "2026-03-24T00:00:00.000Z"
          }
        }),
        createEvent({
          event_type: GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_PROMOTED,
          entity_type: "session_override",
          entity_id: "override-rejected",
          payload_json: {
            override_id: "override-rejected",
            target_object: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
            dimension: MemoryDimension.PREFERENCE,
            promotion_outcome: "not_promoted",
            occurred_at: "2026-03-24T00:10:00.000Z"
          }
        })
      ]
    });

    await expect(
      service.reevaluate({
        targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        workspaceId: "workspace-1"
      })
    ).resolves.toBe("pierced");

    expect(statuses.get("70a0b18b-5f8b-4fd2-a1b0-97ce48113fca")?.revoke_reason).toBe("correction_open");
  });

it("pierces when a structured green security_hit event exists in the same workspace", async () => {
    const { service, statuses } = createHarness({
      existingStatus: createGreenStatus(),
      initialEvents: [
        createEvent({
          event_type: GreenGovernanceEventType.SOUL_GREEN_PIERCED,
          entity_type: "green_status",
          entity_id: "green-security-event",
          payload_json: {
            object_id: "green-security-event",
            target_object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
            revoke_reason: RevokeReason.SECURITY_HIT,
            workspace_id: "workspace-1",
            occurred_at: "2026-03-24T00:00:00.000Z"
          }
        })
      ]
    });

    await expect(
      service.reevaluate({
        targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        workspaceId: "workspace-1"
      })
    ).resolves.toBe("pierced");

    expect(statuses.get("70a0b18b-5f8b-4fd2-a1b0-97ce48113fca")?.revoke_reason).toBe("security_hit");
  });

it("ignores unresolved overrides from other workspaces when reevaluating correction_open", async () => {
    const { service } = createHarness({
      initialEvents: [
        createEvent({
          workspace_id: "workspace-2",
          event_type: GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_APPLIED,
          entity_type: "session_override",
          entity_id: "override-other-workspace",
          payload_json: {
            override_id: "override-other-workspace",
            target_object: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
            correction: "Use pnpm instead of npm.",
            priority: 2,
            run_id: "run-other",
            expires_at: "2026-03-24T01:00:00.000Z",
            derived_from: null,
            occurred_at: "2026-03-24T00:00:00.000Z"
          }
        })
      ]
    });

    await expect(
      service.reevaluate({
        targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        workspaceId: "workspace-1"
      })
    ).resolves.toBe("granted");
  });

it("reevaluate() reapplies surface_detached on non-eligible statuses", async () => {
    const detachedStatus = createGreenStatus({
      green_state: "revoked",
      revoke_reason: "contested",
      bound_surfaces: ["surface://repo/original.ts"]
    });
    const { service, statuses } = createHarness({
      existingStatus: detachedStatus
    });

    await expect(
      service.reevaluate({
        targetObjectId: detachedStatus.target_object_id,
        workspaceId: "workspace-1"
      })
    ).resolves.toBe("pierced");

    expect(statuses.get(detachedStatus.target_object_id)?.revoke_reason).toBe("surface_detached");
  });

it("reevaluate() reapplies external_invalidation on non-eligible statuses", async () => {
    const existingStatus = createGreenStatus({
      green_state: "revoked",
      revoke_reason: "contested"
    });
    const { service, statuses } = createHarness({
      existingStatus,
      memory: createMemoryEntry({ evidence_refs: [] })
    });

    await expect(
      service.reevaluate({
        targetObjectId: existingStatus.target_object_id,
        workspaceId: "workspace-1"
      })
    ).resolves.toBe("pierced");

    expect(statuses.get(existingStatus.target_object_id)?.revoke_reason).toBe("external_invalidation");
  });

it("does not treat arbitrary security-named events as high-risk guard hits", async () => {
    const { service } = createHarness({
      existingStatus: createGreenStatus(),
      initialEvents: [
        createEvent({
          event_type: "soul.security_review.completed" as EventLogEntry["event_type"],
          entity_type: "memory_entry",
          entity_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
          payload_json: {
            reason_code: "security_review",
            occurred_at: "2026-03-24T00:00:00.000Z"
          }
        })
      ]
    });

    await expect(
      service.reevaluate({
        targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        workspaceId: "workspace-1"
      })
    ).resolves.toBe("unchanged");
  });

it("warns once when statusResolver is absent", async () => {
    const { service, warn } = createHarness();

    await service.reevaluate({
      targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      workspaceId: "workspace-1"
    });
    await service.reevaluate({
      targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      workspaceId: "workspace-1"
    });

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(
      "[GreenService] statusResolver missing; contested Green checks are disabled.",
      expect.objectContaining({
        workspaceId: "workspace-1",
        targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca"
      })
    );
  });

it("runVerification() with go resets no-go count and grants", async () => {
    const { service, events } = createHarness({
      existingStatus: createGreenStatus()
    });

    await service.runVerification({
      targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      workspaceId: "workspace-1",
      verdict: VerificationVerdict.NO_GO,
      microCorrectionHint: "fix wording",
      necessaryPatch: null
    });
    const result = await service.runVerification({
      targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      workspaceId: "workspace-1",
      verdict: VerificationVerdict.GO,
      microCorrectionHint: null,
      necessaryPatch: null
    });

    expect(result.verdict).toBe("go");
    const verificationEvent = events.filter((event) => event.event_type === GreenGovernanceEventType.SOUL_VERIFICATION_COMPLETED).at(-1);
    expect((verificationEvent?.payload_json as Record<string, unknown>).consecutive_no_go_count).toBe(0);
  });

it("runVerification() stops retrying after three consecutive no-go verdicts", async () => {
    const { service, events } = createHarness({
      existingStatus: createGreenStatus()
    });

    for (let index = 0; index < 3; index += 1) {
      await service.runVerification({
        targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        workspaceId: "workspace-1",
        verdict: VerificationVerdict.NO_GO,
        microCorrectionHint: "retry",
        necessaryPatch: null
      });
    }

    const result = await service.runVerification({
      targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      workspaceId: "workspace-1",
      verdict: VerificationVerdict.NO_GO,
      microCorrectionHint: null,
      necessaryPatch: null
    });

    expect(result.micro_correction_hint).toBe("max retries reached");
    expect(events.filter((event) => event.event_type === GreenGovernanceEventType.SOUL_GREEN_PIERCED)).toHaveLength(3);
  });

  it("bounds consecutive no-go counts and evicts the least recently used target with a warning", async () => {
    const firstTargetObjectId = "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca";
    const secondTargetObjectId = "80a0b18b-5f8b-4fd2-a1b0-97ce48113fca";
    const { service, warn } = createHarness({
      consecutiveNoGoMaxEntries: 1,
      memories: [
        createMemoryEntry({ object_id: firstTargetObjectId }),
        createMemoryEntry({ object_id: secondTargetObjectId })
      ]
    });

    await service.runVerification({
      targetObjectId: firstTargetObjectId,
      workspaceId: "workspace-1",
      verdict: VerificationVerdict.NO_GO,
      microCorrectionHint: "retry",
      necessaryPatch: null
    });
    await service.runVerification({
      targetObjectId: secondTargetObjectId,
      workspaceId: "workspace-1",
      verdict: VerificationVerdict.NO_GO,
      microCorrectionHint: "retry",
      necessaryPatch: null
    });

    expect([...service.consecutiveNoGo.keys()]).toEqual([secondTargetObjectId]);
    expect(warn).toHaveBeenCalledWith(
      "[GreenService] consecutive No-Go cache entry evicted.",
      {
        targetObjectId: firstTargetObjectId,
        maxEntries: 1
      }
    );
  });

  it("uses process warnings for consecutive no-go eviction when no warn port is injected", async () => {
    const firstTargetObjectId = "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca";
    const secondTargetObjectId = "80a0b18b-5f8b-4fd2-a1b0-97ce48113fca";
    const emitWarning = vi.spyOn(process, "emitWarning").mockImplementation(() => undefined);
    const { service } = createHarness({
      consecutiveNoGoMaxEntries: 1,
      omitWarn: true,
      memories: [
        createMemoryEntry({ object_id: firstTargetObjectId }),
        createMemoryEntry({ object_id: secondTargetObjectId })
      ]
    });

    try {
      await service.runVerification({
        targetObjectId: firstTargetObjectId,
        workspaceId: "workspace-1",
        verdict: VerificationVerdict.NO_GO,
        microCorrectionHint: "retry",
        necessaryPatch: null
      });
      await service.runVerification({
        targetObjectId: secondTargetObjectId,
        workspaceId: "workspace-1",
        verdict: VerificationVerdict.NO_GO,
        microCorrectionHint: "retry",
        necessaryPatch: null
      });

      expect(emitWarning).toHaveBeenCalledWith(
        "[GreenService] consecutive No-Go cache entry evicted.",
        expect.objectContaining({ code: "ALAYA_GREEN_SERVICE_WARNING" })
      );
    } finally {
      emitWarning.mockRestore();
    }
  });

  it("setGrace() audits and notifies an eligible-to-grace transition with dedicated grace event", async () => {
    const { service, statuses, events, notifyEntry, appendEvent, upsertStatus } = createHarness({
      existingStatus: createGreenStatus()
    });

    const result = await service.setGrace({
      targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      workspaceId: "workspace-1",
      until: "2026-03-25T00:00:00.000Z"
    });

    const status = statuses.get("70a0b18b-5f8b-4fd2-a1b0-97ce48113fca");
    const event = events.at(-1);
    expect(result?.green_state).toBe("grace");
    expect(status?.green_state).toBe("grace");
    expect(status?.revoke_reason).toBe(RevokeReason.NONE);
    expect(event).toMatchObject({
      event_type: GreenGovernanceEventType.SOUL_GREEN_GRACE_ENTERED,
      entity_type: "green_status",
      entity_id: "9bc1a292-e9c2-47f9-9c6f-bf6b67c810f3",
      workspace_id: "workspace-1",
      run_id: null,
      caused_by: "system",
      payload_json: {
        object_id: "9bc1a292-e9c2-47f9-9c6f-bf6b67c810f3",
        target_object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        valid_until: "2026-03-25T00:00:00.000Z",
        prior_green_state: "eligible",
        prior_valid_until: "2026-04-23T00:00:00.000Z",
        reason: "manual",
        workspace_id: "workspace-1",
        occurred_at: "2026-03-24T00:00:00.000Z"
      }
    });
    expect(
      events.some(
        (candidate) =>
          candidate.event_type === GreenGovernanceEventType.SOUL_GREEN_PIERCED &&
          (candidate.payload_json as Record<string, unknown>).revoke_reason === RevokeReason.REVIEW_OVERDUE
      )
    ).toBe(false);
    expect(expectDefined(requireAt(appendEvent.mock.invocationCallOrder, 0), "invocationCallOrder")).toBeLessThan(expectDefined(requireAt(upsertStatus.mock.invocationCallOrder, 0), "invocationCallOrder"));
    expect(expectDefined(requireAt(upsertStatus.mock.invocationCallOrder, 0), "invocationCallOrder")).toBeLessThan(expectDefined(requireAt(notifyEntry.mock.invocationCallOrder, 0), "invocationCallOrder"));
    expect(notifyEntry).toHaveBeenCalledWith(event);
  });

it("reevaluate() marks grace entered because valid_until expired", async () => {
    const { service, events } = createHarness({
      memory: createMemoryEntry({ dimension: MemoryDimension.FACT }),
      existingStatus: createGreenStatus({
        green_state: "eligible",
        valid_until: "2026-03-23T00:00:00.000Z"
      })
    });

    await expect(
      service.reevaluate({
        targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        workspaceId: "workspace-1",
        runId: "run-1"
      })
    ).resolves.toBe("grace");

    expect(events.at(-1)).toMatchObject({
      event_type: GreenGovernanceEventType.SOUL_GREEN_GRACE_ENTERED,
      run_id: "run-1",
      payload_json: {
        prior_green_state: "eligible",
        prior_valid_until: "2026-03-23T00:00:00.000Z",
        reason: "valid_until_expired"
      }
    });
  });
});
