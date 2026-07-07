import { describe, expect, it, vi } from "vitest";
import { DISTILLED_FACT_MAX_CHARS, MaterializationRouter } from "@do-soul/alaya-soul";
import {
  type DetectFn,
  type EnqueueFn,
  createDeps,
  createPathRelationProposalPort,
  createSignal
} from "./materialization-router-fixture.js";

describe("MaterializationRouter path relations and distillation", () => {
  it("creates a time_concern path relation proposal after memory_entry_only materialization", async () => {
    const pathRelationProposalPort = {
      createPathRelationProposal: vi.fn(async () => ({
        object_kind: "proposal",
        object_id: "proposal-1"
      }))
    };
    const deps = {
      ...createDeps(),
      pathRelationProposalPort
    };
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(
      createSignal({
        object_kind: "fact",
        domain_tags: ["time_concern"],
        raw_payload: {
          excerpt: "We reviewed the issue yesterday.",
          distilled_fact: "We reviewed the issue yesterday.",
          time_concern: {
            window_digest: "yesterday",
            matched_text: "yesterday"
          }
        }
      })
    );

    expect(result).toMatchObject({
      target_kind: "evidence_only",
      route_target: "memory_entry_only",
      success: true,
      created_objects: [
        { object_kind: "evidence_capsule", object_id: "evidence-1" },
        { object_kind: "memory_entry", object_id: "memory-1" },
        { object_kind: "proposal", object_id: "proposal-1" }
      ]
    });
    expect(pathRelationProposalPort.createPathRelationProposal).toHaveBeenCalledWith({
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1",
      targetObjectId: "memory-1",
      reason: "Create time_concern PathRelation for yesterday.",
      proposedPathRelation: expect.objectContaining({
        target_anchor: {
          kind: "time_concern",
          source_object_id: "memory-1",
          window_digest: "yesterday"
        },
        constitution: expect.objectContaining({
          relation_kind: "time_concern"
        })
      })
    });
  });

  it("keeps the memory enriched when the time_concern proposal throws on memory_and_claim", async () => {
    const pathRelationProposalPort = {
      createPathRelationProposal: vi.fn(async () => {
        throw new Error("path relation proposal port unavailable");
      })
    };
    const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
    const deps = { ...createDeps(), pathRelationProposalPort, enrichPendingPort };
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(
      createSignal({
        domain_tags: ["time_concern"],
        raw_payload: {
          excerpt: "Never print secrets.",
          time_concern: { window_digest: "yesterday", matched_text: "yesterday" }
        }
      })
    );

    expect(result.success).toBe(true);
    expect(enrichPendingPort.enqueue).toHaveBeenCalledTimes(1);
    expect(enrichPendingPort.enqueue.mock.calls[0]![0].memoryId).toBe("memory-1");
    expect(pathRelationProposalPort.createPathRelationProposal).toHaveBeenCalledTimes(1);
    expect(result.created_objects).not.toContainEqual(
      expect.objectContaining({ object_kind: "proposal" })
    );
  });

  it("keeps the memory enriched when the time_concern proposal throws on memory_entry_only append", async () => {
    const pathRelationProposalPort = {
      createPathRelationProposal: vi.fn(async () => {
        throw new Error("path relation proposal port unavailable");
      })
    };
    const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
    const deps = { ...createDeps(), pathRelationProposalPort, enrichPendingPort };
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(
      createSignal({
        object_kind: "fact",
        domain_tags: ["time_concern"],
        raw_payload: {
          excerpt: "We reviewed the issue yesterday.",
          distilled_fact: "We reviewed the issue yesterday.",
          time_concern: { window_digest: "yesterday", matched_text: "yesterday" }
        }
      })
    );

    expect(result.success).toBe(true);
    expect(enrichPendingPort.enqueue).toHaveBeenCalledTimes(1);
    expect(enrichPendingPort.enqueue.mock.calls[0]![0].memoryId).toBe("memory-1");
    expect(pathRelationProposalPort.createPathRelationProposal).toHaveBeenCalledTimes(1);
  });

  it("routes direct path_relation signals to a path relation proposal sink", async () => {
    const pathRelationProposalPort = {
      createPathRelationProposal: vi.fn(async () => ({
        object_kind: "proposal",
        object_id: "proposal-1"
      }))
    };
    const deps = {
      ...createDeps(),
      pathRelationProposalPort
    };
    const router = new MaterializationRouter(deps);
    const signal = createSignal({
      object_kind: "path_relation",
      raw_payload: {
        target_object_id: "memory-target-1",
        time_concern: {
          window_digest: "2026-05",
          matched_text: "2026-05"
        }
      }
    });

    expect(router.route(signal)).toEqual({
      kind: "deferred",
      route_target: "path_relation_proposal",
      routing_reason: "object_kind=path_relation -> path_relation_proposal"
    });

    const result = await router.materializeSignal(signal);

    expect(result).toMatchObject({
      target_kind: "deferred",
      route_target: "path_relation_proposal",
      success: true,
      created_objects: [{ object_kind: "proposal", object_id: "proposal-1" }]
    });
    expect(pathRelationProposalPort.createPathRelationProposal).toHaveBeenCalledWith(
      expect.objectContaining({
        targetObjectId: "memory-target-1",
        proposedPathRelation: expect.objectContaining({
          target_anchor: {
            kind: "time_concern",
            source_object_id: "memory-target-1",
            window_digest: "2026-05"
          }
        })
      })
    );
  });

  it("keeps failure isolated and returns unsuccessful result", async () => {
    const deps = createDeps();
    deps.memoryService.create.mockRejectedValueOnce(new Error("memory repo down"));
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(createSignal());

    expect(result).toMatchObject({
      signal_id: "signal-1",
      target_kind: "memory_and_claim",
      success: false,
      error: "memory repo down"
    });
  });

  it("uses caller-supplied distilled_fact verbatim when present", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    await router.materializeSignal(
      createSignal({
        raw_payload: {
          excerpt: "Long raw turn that mentions many things across multiple paragraphs.",
          distilled_fact: "User prefers concise replies."
        }
      })
    );

    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
    const memoryInput = deps.memoryService.create.mock.calls[0]![0];
    expect(memoryInput.content).toBe("User prefers concise replies.");
  });

  it("falls back to rule-based distillation when distilled_fact missing", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const longRaw =
      "First sentence states the fact. Second sentence adds context. Third sentence is decoration that should be dropped from the distilled memory because the rule keeps only the first two sentences.";
    await router.materializeSignal(
      createSignal({
        raw_payload: { excerpt: longRaw }
      })
    );

    const memoryInput = deps.memoryService.create.mock.calls[0]![0];
    expect(memoryInput.content).toContain("First sentence states the fact.");
    expect(memoryInput.content).toContain("Second sentence adds context.");
    expect(memoryInput.content).not.toContain("Third sentence");
  });

  it("handles CJK sentence terminators in rule-based distillation", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const cjkRaw =
      "用户偏好简洁的回复。同时希望保留中文表达。第三句应当被去掉因为它超出前两句的边界。剩余内容也不应进入。";
    await router.materializeSignal(
      createSignal({
        raw_payload: { excerpt: cjkRaw }
      })
    );

    const memoryInput = deps.memoryService.create.mock.calls[0]![0];
    expect(memoryInput.content).toContain("用户偏好简洁的回复");
    expect(memoryInput.content).toContain("同时希望保留中文表达");
    expect(memoryInput.content).not.toContain("第三句");
  });

  it("hard-clamps an over-cap caller distilled_fact without appending an ellipsis", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const longDistilled = "a".repeat(DISTILLED_FACT_MAX_CHARS + 200);
    await router.materializeSignal(
      createSignal({
        raw_payload: { excerpt: "raw", distilled_fact: longDistilled }
      })
    );

    const memoryInput = deps.memoryService.create.mock.calls[0]![0] as {
      readonly content: string;
    };
    expect(memoryInput.content.length).toBe(DISTILLED_FACT_MAX_CHARS);
    expect(memoryInput.content.endsWith("...")).toBe(false);
  });

  it("uses a within-cap caller distilled_fact verbatim", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const fact = "The operator prefers concise replies in English.";
    await router.materializeSignal(
      createSignal({
        raw_payload: { excerpt: "raw turn text", distilled_fact: fact }
      })
    );

    const memoryInput = deps.memoryService.create.mock.calls[0]![0] as {
      readonly content: string;
    };
    expect(memoryInput.content).toBe(fact);
  });

  it("submits supersedes / exception_to / contradicts / incompatible_with path candidates from first-class refs", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter({
      ...deps,
      pathRelationProposalPort: createPathRelationProposalPort()
    });

    await router.materializeSignal(
      createSignal({
        supersedes_refs: ["mem-old-1"],
        exception_to_refs: ["mem-rule-2"],
        contradicts_refs: ["mem-conflict-3"],
        incompatible_with_refs: ["mem-incompat-4"],
        raw_payload: {
          excerpt: "Replaces older preference."
        }
      })
    );

    const calls = deps.pathCandidateSinkPort.submitCandidate.mock.calls.map((args) => args[0]);
    const relationKinds = calls.map((candidate) => candidate.relationKind);
    expect(relationKinds).toEqual(
      expect.arrayContaining(["supersedes", "exception_to", "contradicts", "incompatible_with"])
    );
    const supersedes = calls.find((candidate) => candidate.relationKind === "supersedes");
    expect(supersedes).toMatchObject({
      sourceAnchor: { kind: "object", object_id: "memory-1" },
      targetAnchor: { kind: "object", object_id: "mem-old-1" },
      recallBiasSign: -1
    });
    const exception = calls.find((candidate) => candidate.relationKind === "exception_to");
    expect(exception?.recallBiasSign).toBe(0);
  });

  it("seeds agent-asserted negative refs WEAK (attention_only), never recall_allowed", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter({
      ...deps,
      pathRelationProposalPort: createPathRelationProposalPort()
    });

    await router.materializeSignal(
      createSignal({
        supersedes_refs: ["mem-old-1"],
        contradicts_refs: ["victim-mem"],
        incompatible_with_refs: ["mem-incompat-4"],
        raw_payload: {
          excerpt: "Agent claims this contradicts the victim memory."
        }
      })
    );

    const calls = deps.pathCandidateSinkPort.submitCandidate.mock.calls.map((args) => args[0]);
    const contradicts = calls.filter((candidate) => candidate.relationKind === "contradicts");
    expect(contradicts).toHaveLength(1);
    expect(contradicts[0]).toMatchObject({
      targetAnchor: { kind: "object", object_id: "victim-mem" },
      recallBiasSign: -1,
      governanceClass: "attention_only",
      initialStrength: 0.5
    });

    for (const relationKind of ["supersedes", "contradicts", "incompatible_with"]) {
      const negative = calls.filter((candidate) => candidate.relationKind === relationKind);
      expect(negative).toHaveLength(1);
      for (const candidate of negative) {
        expect(candidate.recallBiasSign).toBe(-1);
        expect(candidate.governanceClass).toBe("attention_only");
        expect(candidate.governanceClass).not.toBe("recall_allowed");
        expect(candidate.initialStrength).toBe(0.5);
      }
    }
  });

  it("submits derives_from path candidates from first-class source_memory_refs on the memory_and_claim branch", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter({
      ...deps,
      pathRelationProposalPort: createPathRelationProposalPort()
    });

    await router.materializeSignal(
      createSignal({
        source_memory_refs: ["mem-prior-a", "mem-prior-b"],
        raw_payload: {
          excerpt: "Derives from prior facts."
        }
      })
    );

    const calls = deps.pathCandidateSinkPort.submitCandidate.mock.calls.map((args) => args[0]);
    const derivesFrom = calls.filter((candidate) => candidate.relationKind === "derives_from");
    expect(derivesFrom).toHaveLength(2);
    expect(derivesFrom.map((candidate) => candidate.targetAnchor.object_id).sort()).toEqual([
      "mem-prior-a",
      "mem-prior-b"
    ]);
    expect(derivesFrom.every((candidate) => candidate.recallBiasSign === 1)).toBe(true);
    expect(
      derivesFrom.every((candidate) => candidate.sourceAnchor.object_id === "memory-1")
    ).toBe(true);
  });

  it("does NOT run conflict detection inline on the write-path (enqueues instead)", async () => {
    const deps = createDeps();
    const detectAndLinkConflicts = vi.fn<DetectFn>(async () => undefined);
    const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
    const router = new MaterializationRouter({
      ...deps,
      conflictDetectionPort: { detectAndLinkConflicts },
      enrichPendingPort
    });

    await router.materializeSignal(createSignal());

    expect(detectAndLinkConflicts).not.toHaveBeenCalled();
    expect(enrichPendingPort.enqueue).toHaveBeenCalledTimes(1);
    expect(enrichPendingPort.enqueue.mock.calls[0]![0].memoryId).toBe("memory-1");
  });

  it("does not enqueue enrichment when enrichPendingPort is absent", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(createSignal());

    expect(result.success).toBe(true);
  });
});
