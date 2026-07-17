import { describe, expect, it, vi } from "vitest";
import { MaterializationRouter } from "@do-soul/alaya-soul";
import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";
import {
  type DetectFn,
  type EnqueueFn,
  type MockPathRelationProposalFn,
  type RunWithDecisionFn,
  createDeps,
  createPathRelationProposalPort,
  createSignal,
  fakeReconciliationPort
} from "./materialization-router-fixture.js";

describe("MaterializationRouter ingest reconciliation", () => {
  function factSignal(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
    return createSignal({
      object_kind: "fact",
      signal_kind: "potential_claim",
      confidence: 0.8,
      raw_payload: {
        excerpt: "The user lives in Berlin.",
        distilled_fact: "The user lives in Berlin."
      },
      ...overrides
    });
  }
  it("preflights the durable fallback before memory_and_claim side effects when refs are present", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(
      createSignal({
        source_memory_refs: ["mem-transient"],
        raw_payload: {
          excerpt: "Claim whose fallback proposal port is absent."
        }
      })
    );

    expect(result.success).toBe(false);
    expect(result.created_objects).toEqual([]);
    expect(deps.evidenceService.create).not.toHaveBeenCalled();
    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.claimService.create).not.toHaveBeenCalled();
    expect(deps.pathCandidateSinkPort.submitCandidate).not.toHaveBeenCalled();
  });


  it("returns unsuccessful before memory creation when the durable proposal fallback preflight throws", async () => {
    const deps = createDeps();
    deps.pathCandidateSinkPort.submitCandidate.mockResolvedValue("failed");
    const pathRelationProposalPort = {
      assertPathRelationProposalAvailable: vi.fn(async () => {
        throw new Error("proposal repo down");
      }),
      createPathRelationProposal: vi.fn<MockPathRelationProposalFn>(async () => {
        throw new Error("should not create a proposal after failed preflight");
      })
    };
    const router = new MaterializationRouter({ ...deps, pathRelationProposalPort });

    const result = await router.materializeSignal(
      factSignal({
        source_memory_refs: ["mem-transient"],
        raw_payload: {
          excerpt: "Fact whose fallback proposal write fails.",
          distilled_fact: "Fact whose fallback proposal write fails."
        }
      })
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected materialization failure");
    }
    expect(result.error).toBe("proposal repo down");
    expect(result.created_objects).toEqual([]);
    expect(pathRelationProposalPort.assertPathRelationProposalAvailable).toHaveBeenCalledTimes(1);
    expect(pathRelationProposalPort.createPathRelationProposal).not.toHaveBeenCalled();
    expect(deps.evidenceService.create).not.toHaveBeenCalled();
    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.pathCandidateSinkPort.submitCandidate).not.toHaveBeenCalled();
  });


  it("ADD verdict (reconciled path) also creates derives_from edges from source_memory_refs", async () => {
    const deps = createDeps();
    const { reconciliationPort } = fakeReconciliationPort({ kind: "add" });
    const router = new MaterializationRouter({
      ...deps,
      reconciliationPort,
      pathRelationProposalPort: createPathRelationProposalPort()
    });

    await router.materializeSignal(
      factSignal({
        source_memory_refs: ["mem-prior-r1"],
        raw_payload: {
          excerpt: "Derived fact under reconciliation.",
          distilled_fact: "Derived fact under reconciliation."
        }
      })
    );

    const calls = deps.pathCandidateSinkPort.submitCandidate.mock.calls.map((args) => args[0]);
    const derivesFrom = calls.filter((candidate) => candidate.relationKind === "derives_from");
    expect(derivesFrom).toHaveLength(1);
    expect(derivesFrom[0]).toMatchObject({
      sourceAnchor: { kind: "object", object_id: "memory-1" },
      targetAnchor: { kind: "object", object_id: "mem-prior-r1" }
    });
  });


  it("ADD verdict (reconciled path) enqueues enrichment for the appended memory", async () => {
    const deps = createDeps();
    const { reconciliationPort } = fakeReconciliationPort({ kind: "add" });
    const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
    const router = new MaterializationRouter({
      ...deps,
      reconciliationPort,
      enrichPendingPort
    });

    await router.materializeSignal(factSignal());

    expect(enrichPendingPort.enqueue).toHaveBeenCalledTimes(1);
    expect(enrichPendingPort.enqueue).toHaveBeenCalledWith({
      memoryId: "memory-1",
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });
  });


  it("ADD verdict keeps the memory enriched when temporal time_concern assertion admission throws", async () => {
    const deps = createDeps();
    const { reconciliationPort } = fakeReconciliationPort({ kind: "add" });
    const temporalRelationAssertionPort = {
      admit: vi.fn(async () => {
        throw new Error("temporal relation assertion port unavailable");
      })
    };
    const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
    const router = new MaterializationRouter({
      ...deps,
      reconciliationPort,
      temporalRelationAssertionPort,
      enrichPendingPort
    });

    const result = await router.materializeSignal(
      factSignal({
        domain_tags: ["time_concern"],
        raw_payload: {
          excerpt: "We shipped it yesterday.",
          distilled_fact: "We shipped it yesterday.",
          time_concern: { window_digest: "yesterday", matched_text: "yesterday" }
        }
      }),
      {
        source_event_anchor: {
          event_type: "soul.signal.emitted",
          event_id: "event-signal-1",
          occurred_at: "2026-07-16T12:34:56.000Z"
        }
      }
    );

    expect(result.success).toBe(true);
    expect(enrichPendingPort.enqueue).toHaveBeenCalledTimes(1);
    expect(enrichPendingPort.enqueue.mock.calls[0]![0].memoryId).toBe("memory-1");
    expect(temporalRelationAssertionPort.admit).toHaveBeenCalledTimes(1);
    expect(deps.pathCandidateSinkPort.submitCandidate).not.toHaveBeenCalled();
  });


  it("UPDATE verdict (reconciled path) does not create derives_from edges", async () => {
    const deps = createDeps();
    const { reconciliationPort } = fakeReconciliationPort({
      kind: "update",
      survivingObjectId: "memory-existing"
    });
    const router = new MaterializationRouter({ ...deps, reconciliationPort });

    await router.materializeSignal(
      factSignal({
        source_memory_refs: ["mem-prior-u1"],
        raw_payload: {
          excerpt: "Updated fact.",
          distilled_fact: "Updated fact."
        }
      })
    );

    const calls = deps.pathCandidateSinkPort.submitCandidate.mock.calls.map((args) => args[0]);
    expect(calls.filter((candidate) => candidate.relationKind === "derives_from")).toEqual([]);
  });


  it("UPDATE verdict (reconciled path) does not enqueue enrichment", async () => {
    const deps = createDeps();
    const { reconciliationPort } = fakeReconciliationPort({
      kind: "update",
      survivingObjectId: "memory-existing"
    });
    const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
    const router = new MaterializationRouter({
      ...deps,
      reconciliationPort,
      enrichPendingPort
    });

    await router.materializeSignal(factSignal());

    expect(enrichPendingPort.enqueue).not.toHaveBeenCalled();
  });


  it("NOOP verdict (reconciled path) does not create derives_from edges", async () => {
    const deps = createDeps();
    const { reconciliationPort } = fakeReconciliationPort({
      kind: "noop",
      survivingObjectId: "memory-existing"
    });
    const router = new MaterializationRouter({ ...deps, reconciliationPort });

    await router.materializeSignal(
      factSignal({
        source_memory_refs: ["mem-prior-n1"],
        raw_payload: {
          excerpt: "Duplicate fact.",
          distilled_fact: "Duplicate fact."
        }
      })
    );

    const calls = deps.pathCandidateSinkPort.submitCandidate.mock.calls.map((args) => args[0]);
    expect(calls.filter((candidate) => candidate.relationKind === "derives_from")).toEqual([]);
  });


  it("NOOP verdict (reconciled path) does not enqueue enrichment", async () => {
    const deps = createDeps();
    const { reconciliationPort } = fakeReconciliationPort({
      kind: "noop",
      survivingObjectId: "memory-existing"
    });
    const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
    const router = new MaterializationRouter({
      ...deps,
      reconciliationPort,
      enrichPendingPort
    });

    await router.materializeSignal(factSignal());

    expect(enrichPendingPort.enqueue).not.toHaveBeenCalled();
  });


  it("ADD verdict creates the evidence capsule then the memory entry", async () => {
    const deps = createDeps();
    const { reconciliationPort } = fakeReconciliationPort({ kind: "add" });
    const router = new MaterializationRouter({ ...deps, reconciliationPort });

    const result = await router.materializeSignal(factSignal());

    expect(result.success).toBe(true);
    expect(deps.evidenceService.create).toHaveBeenCalledTimes(1);
    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
    const memoryInput = deps.memoryService.create.mock.calls[0]![0] as {
      readonly evidence_refs: readonly string[];
    };
    expect(memoryInput.evidence_refs).toEqual(["evidence-1"]);
    expect(result.created_objects).toEqual([
      { object_kind: "evidence_capsule", object_id: "evidence-1" },
      { object_kind: "memory_entry", object_id: "memory-1" }
    ]);
  });


  it("ADD verdict enqueues enrichment and never runs conflict detection inline (regardless of the old runConflictScan flag)", async () => {
    for (const runConflictScan of [true, false]) {
      const deps = createDeps();
      const { reconciliationPort } = fakeReconciliationPort({ kind: "add", runConflictScan });
      const detectAndLinkConflicts = vi.fn<DetectFn>(async () => undefined);
      const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
      const router = new MaterializationRouter({
        ...deps,
        reconciliationPort,
        conflictDetectionPort: { detectAndLinkConflicts },
        enrichPendingPort
      });

      const result = await router.materializeSignal(factSignal());

      expect(result.success).toBe(true);
      expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
      expect(detectAndLinkConflicts).not.toHaveBeenCalled();
      expect(enrichPendingPort.enqueue).toHaveBeenCalledTimes(1);
      expect(enrichPendingPort.enqueue.mock.calls[0]![0].memoryId).toBe("memory-1");
    }
  });


  it("NOOP verdict creates nothing - no evidence capsule, no memory entry", async () => {
    const deps = createDeps();
    const { reconciliationPort } = fakeReconciliationPort({
      kind: "noop",
      survivingObjectId: "memory-existing",
      reason: "near-exact lexical duplicate of memory-existing"
    });
    const router = new MaterializationRouter({ ...deps, reconciliationPort });

    const result = await router.materializeSignal(factSignal());

    expect(result.success).toBe(true);
    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.evidenceService.create).not.toHaveBeenCalled();
    expect(result.created_objects).toEqual([
      { object_kind: "memory_entry", object_id: "memory-existing" }
    ]);
    expect(result.routing_reason).toContain(
      "reconciled: near-exact lexical duplicate of memory-existing"
    );
  });


  it("UPDATE verdict creates the evidence capsule, skips the append, surfaces the surviving row", async () => {
    const deps = createDeps();
    const { reconciliationPort } = fakeReconciliationPort({
      kind: "update",
      survivingObjectId: "memory-refined",
      reason: "refines memory-refined"
    });
    const router = new MaterializationRouter({ ...deps, reconciliationPort });

    const result = await router.materializeSignal(factSignal());

    expect(result.success).toBe(true);
    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.evidenceService.create).toHaveBeenCalledTimes(1);
    expect(result.created_objects).toEqual([
      { object_kind: "evidence_capsule", object_id: "evidence-1" },
      { object_kind: "memory_entry", object_id: "memory-refined" }
    ]);
  });


  it("UPDATE that cannot be applied re-drives applyVerdict and creates the memory entry once", async () => {
    const deps = createDeps();
    const { reconciliationPort, appliedVerdicts } = fakeReconciliationPort(
      { kind: "update", survivingObjectId: "memory-refined" },
      { updateFails: true }
    );
    const router = new MaterializationRouter({ ...deps, reconciliationPort });

    const result = await router.materializeSignal(factSignal());

    expect(result.success).toBe(true);
    expect(appliedVerdicts).toEqual(["update", "add"]);
    expect(deps.evidenceService.create).toHaveBeenCalledTimes(1);
    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
    expect(result.created_objects).toEqual([
      { object_kind: "evidence_capsule", object_id: "evidence-1" },
      { object_kind: "memory_entry", object_id: "memory-1" }
    ]);
  });


  it("degrades to the blind-append path when the reconciliationPort throws", async () => {
    const deps = createDeps();
    const runWithDecision = vi.fn<RunWithDecisionFn>(async () => {
      throw new Error("reconciliation backend unavailable");
    });
    const router = new MaterializationRouter({
      ...deps,
      reconciliationPort: { runWithDecision }
    });

    const result = await router.materializeSignal(factSignal());

    expect(result.success).toBe(true);
    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
  });
});
