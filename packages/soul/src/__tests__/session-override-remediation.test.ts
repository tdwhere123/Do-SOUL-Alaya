import { describe, expect, it, vi } from "vitest";
import { MemoryDimension, Phase3BEventType, RetentionPolicy, type EventLogEntry, type SessionOverride } from "@do-soul/alaya-protocol";
import { SessionOverrideRemediation } from "../garden/session-override-remediation.js";

describe("SessionOverrideRemediation", () => {
  it("promotes preference overrides to durable memory when base and trigger conditions pass", async () => {
    const deps = createDeps();
    const remediation = new SessionOverrideRemediation({
      ...deps,
      now: () => "2026-03-24T00:00:00.000Z"
    });

    const outcome = await remediation.evaluate({
      override: createOverride(),
      workspaceId: "workspace-1",
      runId: "run-1",
      dimension: MemoryDimension.PREFERENCE,
      triggerConditions: ["explicit_long_term_intent"]
    });

    expect(outcome).toBe("durable");
    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
    expect(deps.claimService.create).not.toHaveBeenCalled();
    expect(deps.eventLogRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: Phase3BEventType.SOUL_SESSION_OVERRIDE_PROMOTED,
        payload_json: expect.objectContaining({
          promotion_outcome: "durable",
          dimension: MemoryDimension.PREFERENCE
        })
      })
    );
  });

  it("routes fact overrides to claim candidates when gate conditions pass", async () => {
    const deps = createDeps();
    const remediation = new SessionOverrideRemediation(deps);

    const outcome = await remediation.evaluate({
      override: createOverride(),
      workspaceId: "workspace-1",
      runId: "run-1",
      dimension: MemoryDimension.FACT,
      triggerConditions: ["verified_once"]
    });

    expect(outcome).toBe("candidate");
    expect(deps.claimService.create).toHaveBeenCalledTimes(1);
    expect(deps.claimService.create.mock.calls[0][0]).toMatchObject({
      claim_kind: "factual_policy",
      proposition_digest: "Use pnpm instead of npm.",
      source_object_refs: ["memory:build-style"]
    });
    expect(deps.memoryService.create).not.toHaveBeenCalled();
  });

  it("keeps hazard overrides in pending_review even when gate conditions pass", async () => {
    const deps = createDeps();
    const remediation = new SessionOverrideRemediation(deps);

    const outcome = await remediation.evaluate({
      override: createOverride(),
      workspaceId: "workspace-1",
      runId: "run-1",
      dimension: MemoryDimension.HAZARD,
      triggerConditions: ["verified_once"]
    });

    expect(outcome).toBe("pending_review");
    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.claimService.create).not.toHaveBeenCalled();
  });

  it("returns not_promoted when target is not locatable", async () => {
    const deps = createDeps();
    const remediation = new SessionOverrideRemediation(deps);

    const outcome = await remediation.evaluate({
      override: createOverride({ target_object: "   " as never }),
      workspaceId: "workspace-1",
      runId: "run-1",
      dimension: MemoryDimension.PREFERENCE,
      triggerConditions: ["explicit_long_term_intent"]
    });

    expect(outcome).toBe("not_promoted");
    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.claimService.create).not.toHaveBeenCalled();
  });

  it("returns not_promoted when correction evidence is missing", async () => {
    const deps = createDeps();
    const remediation = new SessionOverrideRemediation(deps);

    const outcome = await remediation.evaluate({
      override: createOverride({ derived_from: null }),
      workspaceId: "workspace-1",
      runId: "run-1",
      dimension: MemoryDimension.PREFERENCE,
      triggerConditions: ["explicit_long_term_intent"]
    });

    expect(outcome).toBe("not_promoted");
    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.eventLogRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: Phase3BEventType.SOUL_SESSION_OVERRIDE_PROMOTED,
        payload_json: expect.objectContaining({
          promotion_outcome: "not_promoted"
        })
      })
    );
  });

  it("returns not_promoted when no trigger condition is met", async () => {
    const deps = createDeps();
    const remediation = new SessionOverrideRemediation(deps);

    const outcome = await remediation.evaluate({
      override: createOverride(),
      workspaceId: "workspace-1",
      runId: "run-1",
      dimension: MemoryDimension.PREFERENCE,
      triggerConditions: []
    });

    expect(outcome).toBe("not_promoted");
    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.eventLogRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: Phase3BEventType.SOUL_SESSION_OVERRIDE_PROMOTED,
        payload_json: expect.objectContaining({
          promotion_outcome: "not_promoted"
        })
      })
    );
  });

  it("accepts a single explicit intent trigger as sufficient", async () => {
    const deps = createDeps();
    const remediation = new SessionOverrideRemediation(deps);

    const outcome = await remediation.evaluate({
      override: createOverride(),
      workspaceId: "workspace-1",
      runId: "run-1",
      dimension: MemoryDimension.PREFERENCE,
      triggerConditions: ["explicit_long_term_intent"]
    });

    expect(outcome).toBe("durable");
    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
  });

  it("prefers the resolved target-object dimension over text heuristics", async () => {
    const deps = createDeps({
      resolveDimension: vi.fn(async () => MemoryDimension.FACT)
    });
    const remediation = new SessionOverrideRemediation(deps);

    const outcome = await remediation.evaluate({
      override: createOverride({
        target_object: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca"
      }),
      workspaceId: "workspace-1",
      runId: "run-1",
      triggerConditions: ["explicit_long_term_intent"]
    });

    expect(outcome).toBe("candidate");
    expect(deps.targetObjectResolver?.resolveDimension).toHaveBeenCalledWith(
      "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca"
    );
    expect(deps.claimService.create).toHaveBeenCalledTimes(1);
    expect(deps.memoryService.create).not.toHaveBeenCalled();
  });

  it("falls back to text heuristics when the resolver cannot classify the target object", async () => {
    const deps = createDeps();
    const remediation = new SessionOverrideRemediation(deps);

    const outcome = await remediation.evaluate({
      override: createOverride({
        target_object: "fact:canonical-package-manager",
        correction: "Always use pnpm instead of npm."
      }),
      workspaceId: "workspace-1",
      runId: "run-1",
      triggerConditions: ["explicit_long_term_intent"]
    });

    expect(outcome).toBe("candidate");
    expect(deps.targetObjectResolver?.resolveDimension).toHaveBeenCalledWith("fact:canonical-package-manager");
    expect(deps.claimService.create).toHaveBeenCalledTimes(1);
    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.warn).toHaveBeenCalledWith(
      "[SessionOverrideRemediation] targetObjectResolver returned no dimension; using heuristic fallback.",
      { targetObject: "fact:canonical-package-manager" }
    );
  });

  it("still prefers an explicit dimension over the resolved target-object dimension", async () => {
    const deps = createDeps({
      resolveDimension: vi.fn(async () => MemoryDimension.FACT)
    });
    const remediation = new SessionOverrideRemediation(deps);

    const outcome = await remediation.evaluate({
      override: createOverride({
        target_object: "70a0b18b-5f8b-4fd2-a1b0-97ce48113fca"
      }),
      workspaceId: "workspace-1",
      runId: "run-1",
      dimension: MemoryDimension.PREFERENCE,
      triggerConditions: ["explicit_long_term_intent"]
    });

    expect(outcome).toBe("durable");
    expect(deps.targetObjectResolver?.resolveDimension).not.toHaveBeenCalled();
    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
    expect(deps.claimService.create).not.toHaveBeenCalled();
  });

  it("evaluates only pending overrides during run-level promotion", async () => {
    const deps = createDeps({
      queryByEntity: vi
        .fn(async (entityType: string, entityId: string) =>
          entityType === "session_override" && entityId === "override-complete"
            ? [
                {
                  event_id: "event-existing",
                  created_at: "2026-03-24T00:00:00.000Z",
                  event_type: Phase3BEventType.SOUL_SESSION_OVERRIDE_PROMOTED,
                  entity_type: "session_override",
                  entity_id: "override-complete",
                  workspace_id: "workspace-1",
                  run_id: "run-1",
                  caused_by: "system",
                  revision: 0,
                  payload_json: {
                    override_id: "override-complete",
                    target_object: "memory:build-style",
                    dimension: "preference",
                    promotion_outcome: "durable",
                    occurred_at: "2026-03-24T00:00:00.000Z"
                  }
                }
              ]
            : []
        )
    });
    const remediation = new SessionOverrideRemediation(deps);

    await remediation.evaluatePending({
      runId: "run-1",
      workspaceId: "workspace-1",
      overrides: [
        createOverride({ runtime_id: "override-complete" }),
        createOverride({
          runtime_id: "override-pending",
          correction: "Always use pnpm instead of npm."
        })
      ]
    });

    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
    expect(deps.eventLogRepo.append).toHaveBeenCalledTimes(1);
    expect(deps.eventLogRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        entity_id: "override-pending"
      })
    );
  });

  it("treats repeated overrides across runs as a conservative trigger during pending evaluation", async () => {
    const deps = createDeps();
    const remediation = new SessionOverrideRemediation(deps);

    await remediation.evaluatePending({
      runId: "run-1",
      workspaceId: "workspace-1",
      overrides: [
        createOverride({
          target_object: "memory:build-style",
          correction: "Use pnpm instead of npm."
        })
      ]
    });

    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.eventLogRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_json: expect.objectContaining({
          promotion_outcome: "not_promoted"
        })
      })
    );
  });

  it("promotes repeated overrides across distinct runs", async () => {
    const deps = createDeps({
      queryByWorkspace: vi.fn(async () => [
        {
          event_id: "event-repeat-1",
          created_at: "2026-03-24T00:00:00.000Z",
          event_type: Phase3BEventType.SOUL_SESSION_OVERRIDE_APPLIED,
          entity_type: "session_override",
          entity_id: "override-repeat-1",
          workspace_id: "workspace-1",
          run_id: "run-1",
          caused_by: "user_action",
          revision: 0,
          payload_json: {
            override_id: "override-repeat-1",
            target_object: "memory:build-style",
            correction: "Use pnpm instead of npm.",
            priority: 2,
            run_id: "run-1",
            expires_at: "2026-03-24T01:00:00.000Z",
            derived_from: null,
            occurred_at: "2026-03-24T00:00:00.000Z"
          }
        },
        {
          event_id: "event-repeat-2",
          created_at: "2026-03-24T00:05:00.000Z",
          event_type: Phase3BEventType.SOUL_SESSION_OVERRIDE_APPLIED,
          entity_type: "session_override",
          entity_id: "override-repeat-2",
          workspace_id: "workspace-1",
          run_id: "run-2",
          caused_by: "user_action",
          revision: 0,
          payload_json: {
            override_id: "override-repeat-2",
            target_object: "memory:build-style",
            correction: "Use pnpm instead of npm.",
            priority: 2,
            run_id: "run-2",
            expires_at: "2026-03-24T01:05:00.000Z",
            derived_from: null,
            occurred_at: "2026-03-24T00:05:00.000Z"
          }
        }
      ])
    });
    const remediation = new SessionOverrideRemediation(deps);

    await remediation.evaluatePending({
      runId: "run-2",
      workspaceId: "workspace-1",
      overrides: [
        createOverride({
          target_object: "memory:build-style",
          correction: "Use pnpm instead of npm."
        })
      ]
    });

    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
    expect(deps.eventLogRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_json: expect.objectContaining({
          promotion_outcome: "durable"
        })
      })
    );
  });

  it("ignores malformed applied-event payloads when checking recurring overrides", async () => {
    const deps = createDeps({
      queryByWorkspace: vi.fn(async () => [
        {
          event_id: "event-repeat-1",
          created_at: "2026-03-24T00:00:00.000Z",
          event_type: Phase3BEventType.SOUL_SESSION_OVERRIDE_APPLIED,
          entity_type: "session_override",
          entity_id: "override-repeat-1",
          workspace_id: "workspace-1",
          run_id: "run-1",
          caused_by: "user_action",
          revision: 0,
          payload_json: {
            override_id: "override-repeat-1",
            target_object: "memory:build-style",
            correction: "Use pnpm instead of npm.",
            priority: 2,
            run_id: "run-1",
            expires_at: "2026-03-24T01:00:00.000Z",
            derived_from: null,
            occurred_at: "2026-03-24T00:00:00.000Z"
          }
        },
        {
          event_id: "event-repeat-malformed",
          created_at: "2026-03-24T00:05:00.000Z",
          event_type: Phase3BEventType.SOUL_SESSION_OVERRIDE_APPLIED,
          entity_type: "session_override",
          entity_id: "override-repeat-malformed",
          workspace_id: "workspace-1",
          run_id: "run-2",
          caused_by: "user_action",
          revision: 0,
          payload_json: {
            override_id: "override-repeat-malformed",
            target_object: "memory:build-style",
            correction: 42,
            priority: 2,
            run_id: "run-2",
            expires_at: "2026-03-24T01:05:00.000Z",
            derived_from: null,
            occurred_at: "2026-03-24T00:05:00.000Z"
          }
        }
      ])
    });
    const remediation = new SessionOverrideRemediation(deps);

    await remediation.evaluatePending({
      runId: "run-2",
      workspaceId: "workspace-1",
      overrides: [
        createOverride({
          target_object: "memory:build-style",
          correction: "Use pnpm instead of npm."
        })
      ]
    });

    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.eventLogRepo.append).toHaveBeenCalledWith(
      expect.objectContaining({
        payload_json: expect.objectContaining({
          promotion_outcome: "not_promoted"
        })
      })
    );
  });

  it("warns when the target object resolver is absent", async () => {
    const deps = createDeps({
      includeResolver: false
    });
    const remediation = new SessionOverrideRemediation(deps);

    const outcome = await remediation.evaluate({
      override: createOverride({
        target_object: "fact:canonical-package-manager",
        correction: "Always use pnpm instead of npm."
      }),
      workspaceId: "workspace-1",
      runId: "run-1",
      triggerConditions: ["explicit_long_term_intent"]
    });

    expect(outcome).toBe("candidate");
    expect(deps.warn).toHaveBeenCalledWith(
      "[SessionOverrideRemediation] targetObjectResolver missing; falling back to target-object heuristics.",
      { targetObject: "fact:canonical-package-manager" }
    );
  });

  it("warns once when the resolver returns no dimension and heuristics are used", async () => {
    const deps = createDeps({
      resolveDimension: vi.fn(async () => null)
    });
    const remediation = new SessionOverrideRemediation(deps);

    await remediation.evaluate({
      override: createOverride({
        target_object: "fact:canonical-package-manager",
        correction: "Always use pnpm instead of npm."
      }),
      workspaceId: "workspace-1",
      runId: "run-1",
      triggerConditions: ["explicit_long_term_intent"]
    });
    await remediation.evaluate({
      override: createOverride({
        runtime_id: "22222222-2222-4222-8222-222222222222",
        target_object: "fact:canonical-package-manager",
        correction: "Always use pnpm instead of npm."
      }),
      workspaceId: "workspace-1",
      runId: "run-1",
      triggerConditions: ["explicit_long_term_intent"]
    });

    expect(deps.warn).toHaveBeenCalledTimes(1);
    expect(deps.warn).toHaveBeenCalledWith(
      "[SessionOverrideRemediation] targetObjectResolver returned no dimension; using heuristic fallback.",
      { targetObject: "fact:canonical-package-manager" }
    );
  });
});

function createDeps(
  overrides: Partial<{
    queryByEntity: ReturnType<typeof vi.fn>;
    queryByWorkspace: ReturnType<typeof vi.fn>;
    resolveDimension: ReturnType<typeof vi.fn>;
    includeResolver: boolean;
  }> = {}
) {
  const storedEvents: EventLogEntry[] = [];
  const warn = vi.fn();

  const deps = {
    memoryService: {
      create: vi.fn(async () => ({ object_kind: "memory_entry", object_id: "memory-1" }))
    },
    claimService: {
      create: vi.fn(async () => ({ object_kind: "claim_form", object_id: "claim-1" }))
    },
    eventLogRepo: {
      append: vi.fn(async (event: Omit<EventLogEntry, "event_id" | "created_at">) => {
        const stored: EventLogEntry = {
          event_id: `event-${storedEvents.length + 1}`,
          created_at: "2026-03-24T00:00:00.000Z",
          ...event
        };
        storedEvents.push(stored);
        return stored;
      }),
      queryByEntity:
        overrides.queryByEntity ??
        vi.fn(async (entityType: string, entityId: string) =>
          storedEvents.filter((event) => event.entity_type === entityType && event.entity_id === entityId)
        ),
      queryByWorkspace:
        overrides.queryByWorkspace ??
        vi.fn(async (workspaceId: string) =>
          storedEvents.filter((event) => event.workspace_id === workspaceId)
        )
    },
    warn
  };

  return {
    ...deps,
    ...(overrides.includeResolver === false
      ? {}
      : {
          targetObjectResolver: {
            resolveDimension: overrides.resolveDimension ?? vi.fn(async () => null)
          }
        })
  };
}

function createOverride(overrides: Partial<SessionOverride> = {}): SessionOverride {
  return {
    runtime_id: "11111111-1111-4111-8111-111111111111",
    object_kind: "session_override",
    task_surface_ref: null,
    expires_at: "2026-03-24T01:00:00.000Z",
    derived_from: "msg-user-1",
    retention_policy: RetentionPolicy.SESSION_ONLY,
    scope: "session_only",
    target_object: "memory:build-style",
    correction: "Use pnpm instead of npm.",
    priority: 2,
    ...overrides
  };
}
