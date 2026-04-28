import { describe, expect, it, vi } from "vitest";
import {
  FormationKind,
  MemoryDimension,
  Phase3BEventType,
  RevokeReason,
  ScopeClass,
  SourceKind,
  StorageTier,
  VerificationBasis,
  VerificationVerdict,
  type EventLogEntry,
  type GreenStatus,
  type MemoryEntry
} from "@do-soul/alaya-protocol";
import { GreenService, type GreenServiceDependencies } from "../green-service.js";

function createMemoryEntry(overrides: Partial<MemoryEntry> = {}): MemoryEntry {
  return {
    object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
    object_kind: "memory_entry",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-24T00:00:00.000Z",
    updated_at: "2026-03-24T00:00:00.000Z",
    created_by: "user_action",
    dimension: MemoryDimension.PREFERENCE,
    source_kind: SourceKind.USER,
    formation_kind: FormationKind.EXPLICIT,
    scope_class: ScopeClass.PROJECT,
    content: "Use pnpm for workspace commands.",
    domain_tags: ["tooling"],
    evidence_refs: ["evidence-1"],
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: "surface://repo/path.ts",
    storage_tier: StorageTier.HOT,
    activation_score: 0.6,
    retention_score: 0.7,
    manifestation_state: "full_eligible",
    retention_state: "working",
    decay_profile: "stable",
    confidence: 0.9,
    last_used_at: null,
    last_hit_at: null,
    reinforcement_count: 0,
    contradiction_count: 0,
    superseded_by: null,
    ...overrides
  };
}

function createGreenStatus(overrides: Partial<GreenStatus> = {}): GreenStatus {
  return {
    object_id: "9bc1a292-e9c2-47f9-9c6f-bf6b67c810f3",
    object_kind: "green_status",
    schema_version: 1,
    lifecycle_state: "active",
    created_at: "2026-03-24T00:00:00.000Z",
    updated_at: "2026-03-24T00:00:00.000Z",
    created_by: "system",
    target_object_id: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
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
    workspace_id: "workspace-1",
    ...overrides
  };
}

function createHarness(options: {
  readonly memory?: MemoryEntry;
  readonly existingStatus?: GreenStatus | null;
  readonly governanceRole?: "standalone" | "claimed" | "contested" | "winner" | null;
  readonly leaseHeld?: boolean;
  readonly initialEvents?: readonly EventLogEntry[];
} = {}) {
  const memory = options.memory ?? createMemoryEntry();
  const statuses = new Map<string, GreenStatus>();
  if (options.existingStatus !== undefined && options.existingStatus !== null) {
    statuses.set(options.existingStatus.target_object_id, { ...options.existingStatus });
  }

  const events: EventLogEntry[] = [...(options.initialEvents ?? [])];
  const warn = vi.fn();
  const dependencies: GreenServiceDependencies = {
    now: () => "2026-03-24T00:00:00.000Z",
    generateObjectId: createObjectIdGenerator(),
    warn,
    runtimeNotifier: {
      notifyEntry: vi.fn(async () => undefined)
    },
    greenStatusRepo: {
      findByTargetObjectId: vi.fn(async (targetObjectId: string) => {
        const found = statuses.get(targetObjectId);
        return found === undefined ? null : Object.freeze({ ...found });
      }),
      findEligible: vi.fn(async (workspaceId: string) =>
        [...statuses.values()]
          .filter((status) => status.workspace_id === workspaceId && status.green_state === "eligible")
          .map((status) => Object.freeze({ ...status }))
      ),
      findGrace: vi.fn(async (workspaceId: string) =>
        [...statuses.values()]
          .filter((status) => status.workspace_id === workspaceId && status.green_state === "grace")
          .map((status) => Object.freeze({ ...status }))
      ),
      findByWorkspaceId: vi.fn(async (workspaceId: string) =>
        [...statuses.values()]
          .filter((status) => status.workspace_id === workspaceId)
          .map((status) => Object.freeze({ ...status }))
      ),
      upsert: vi.fn(async (status: Readonly<GreenStatus>) => {
        const copy = { ...status };
        statuses.set(copy.target_object_id, copy);
        return Object.freeze(copy);
      })
    },
    memoryRepo: {
      findById: vi.fn(async (objectId: string) =>
        objectId === memory.object_id ? Object.freeze({ ...memory }) : null
      )
    },
    eventLogRepo: {
      append: vi.fn(async (entry) => {
        const created: EventLogEntry = {
          event_id: `event-${events.length + 1}`,
          created_at: "2026-03-24T00:00:00.000Z",
          ...entry
        };
        events.push(created);
        return created;
      }),
      queryByEntity: vi.fn(async (entityType, entityId) =>
        events.filter((event) => event.entity_type === entityType && event.entity_id === entityId)
      ),
      queryByWorkspace: vi.fn(async (workspaceId) =>
        events.filter((event) => event.workspace_id === workspaceId)
      ),
      queryByType: vi.fn(async (eventType) => events.filter((event) => event.event_type === eventType))
    },
    statusResolver:
      options.governanceRole === undefined
        ? undefined
        : {
            getGovernanceRole: vi.fn(async () => options.governanceRole ?? null)
          },
    leaseService:
      options.leaseHeld === undefined
        ? undefined
        : {
            isHeld: vi.fn(async () => options.leaseHeld ?? false)
          }
  };

  return {
    service: new GreenService(dependencies),
    statuses,
    events,
    warn
  };
}

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
    expect(events.at(-1)?.event_type).toBe(Phase3BEventType.SOUL_GREEN_GRANTED);
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
    expect(events.at(-1)?.event_type).toBe(Phase3BEventType.SOUL_GREEN_PIERCED);
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
          event_type: Phase3BEventType.SOUL_SESSION_OVERRIDE_APPLIED,
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
          event_type: Phase3BEventType.SOUL_SESSION_OVERRIDE_APPLIED,
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
          event_type: Phase3BEventType.SOUL_SESSION_OVERRIDE_APPLIED,
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
          event_type: Phase3BEventType.SOUL_SESSION_OVERRIDE_PROMOTED,
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
          event_type: Phase3BEventType.SOUL_GREEN_PIERCED,
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
          event_type: Phase3BEventType.SOUL_SESSION_OVERRIDE_APPLIED,
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
    const verificationEvent = events.filter((event) => event.event_type === Phase3BEventType.SOUL_VERIFICATION_COMPLETED).at(-1);
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
    expect(events.filter((event) => event.event_type === Phase3BEventType.SOUL_GREEN_PIERCED)).toHaveLength(3);
  });

  it("setGrace() changes state without emitting an event", async () => {
    const { service, statuses, events } = createHarness({
      existingStatus: createGreenStatus()
    });

    await service.setGrace({
      targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      workspaceId: "workspace-1",
      until: "2026-03-25T00:00:00.000Z"
    });

    expect(statuses.get("70a0b18b-5f8b-4fd2-a1b0-97ce48113fca")?.green_state).toBe("grace");
    expect(events).toHaveLength(0);
  });

  it("hazard grants use a 7-day validity window", async () => {
    const { service } = createHarness({
      memory: createMemoryEntry({ dimension: MemoryDimension.HAZARD })
    });

    const status = await service.grant({
      targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      workspaceId: "workspace-1",
      basis: VerificationBasis.USER_RECONFIRM,
      validUntil: "2026-03-31T00:00:00.000Z",
      verifiedBy: "user"
    });

    expect(status.valid_until).toBe("2026-03-31T00:00:00.000Z");
  });

  it("decision grants remain non-expiring to match the protocol contract", async () => {
    const { service } = createHarness({
      memory: createMemoryEntry({ dimension: MemoryDimension.DECISION })
    });

    await expect(
      service.reevaluate({
        targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
        workspaceId: "workspace-1"
      })
    ).resolves.toBe("unchanged");

    const status = await service.grant({
      targetObjectId: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca",
      workspaceId: "workspace-1",
      basis: VerificationBasis.USER_RECONFIRM,
      validUntil: null,
      verifiedBy: "user"
    });

    expect(status.valid_until).toBeNull();
  });

  it("low-signal pierce reasons are suppressed while a governance lease is held", async () => {
    const existingStatus = createGreenStatus({ green_state: "grace" });
    const { service, statuses, events } = createHarness({
      existingStatus,
      leaseHeld: true
    });

    const result = await service.pierce({
      targetObjectId: existingStatus.target_object_id,
      workspaceId: "workspace-1",
      reason: RevokeReason.REVIEW_OVERDUE,
      runId: "run-1"
    });

    expect(result).toEqual(existingStatus);
    expect(statuses.get(existingStatus.target_object_id)?.green_state).toBe("grace");
    expect(events).toHaveLength(0);
  });
});

function createObjectIdGenerator(): () => string {
  let index = 0;

  return () => {
    const value = `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
    index += 1;
    return value;
  };
}

function createEvent(
  overrides: Partial<EventLogEntry> & Pick<EventLogEntry, "event_type" | "entity_type" | "entity_id" | "payload_json">
): EventLogEntry {
  return {
    event_id: overrides.event_id ?? `event-${overrides.event_type}-${overrides.entity_id}`,
    created_at: overrides.created_at ?? "2026-03-24T00:00:00.000Z",
    workspace_id: overrides.workspace_id ?? "workspace-1",
    run_id: overrides.run_id ?? "run-1",
    caused_by: overrides.caused_by ?? "system",
    revision: overrides.revision ?? 0,
    ...overrides
  };
}
