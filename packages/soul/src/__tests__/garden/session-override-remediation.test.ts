import { describe, expect, it, vi } from "vitest";
import { MemoryDimension, GreenGovernanceEventType } from "@do-soul/alaya-protocol";
import { SessionOverrideRemediation } from "../../garden/session-override-remediation.js";
import {
  createDeps, createOverride,
  type RemediationCountDistinctAppliedSessionOverrideRuns, type RemediationHasSessionOverridePromotion,
  type RemediationResolveDimension
} from "./session-override-remediation-fixtures.js";

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
        event_type: GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_PROMOTED,
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
    expect(deps.claimService.create.mock.calls[0]![0]).toMatchObject({
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
        event_type: GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_PROMOTED,
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
        event_type: GreenGovernanceEventType.SOUL_SESSION_OVERRIDE_PROMOTED,
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
      resolveDimension: vi.fn<RemediationResolveDimension>(async () => MemoryDimension.FACT)
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
      resolveDimension: vi.fn<RemediationResolveDimension>(async () => MemoryDimension.FACT)
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
      hasSessionOverridePromotion: vi.fn<RemediationHasSessionOverridePromotion>(
        async (overrideId) => overrideId === "override-complete"
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
      countDistinctAppliedSessionOverrideRuns:
        vi.fn<RemediationCountDistinctAppliedSessionOverrideRuns>(async () => 2)
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
      countDistinctAppliedSessionOverrideRuns:
        vi.fn<RemediationCountDistinctAppliedSessionOverrideRuns>(async () => 1)
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
      resolveDimension: vi.fn<RemediationResolveDimension>(async () => null)
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
