import { describe, expect, it, vi } from "vitest";
import {
  DISTILLED_FACT_MAX_CHARS,
  InMemoryHandoffGapHandler,
  MaterializationRouter,
  normalizeSchemaGroundedSignal
} from "@do-soul/alaya-soul";
import type { CandidateMemorySignal } from "@do-soul/alaya-protocol";

function createSignal(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
  return {
    signal_id: "signal-1",
    workspace_id: "workspace-1",
    run_id: "run-1",
    surface_id: null,
    source: "garden_compile",
    signal_kind: "potential_claim",
    signal_state: "triaged",
    object_kind: "constraint",
    scope_hint: null,
    domain_tags: ["security"],
    confidence: 0.8,
    evidence_refs: ["msg-1"],
    raw_payload: {
      excerpt: "Never print secrets."
    },
    created_at: "2026-03-21T00:00:00.000Z",
    ...overrides
  };
}

describe("MaterializationRouter", () => {
  it("routes potential_claim to memory_and_claim when confidence and evidence thresholds pass", () => {
    const router = createRouter();

    const target = router.route(createSignal());

    expect(target).toEqual({
      kind: "memory_and_claim",
      route_target: "memory_and_claim_draft",
      routing_reason:
        "object_kind=constraint -> memory_and_claim_draft (claim_status defaulted to draft by ClaimService)"
    });
  });

  it("routes potential_preference with empty evidence_refs to memory_and_claim when confidence >= 0.5", () => {
    const router = createRouter();

    const target = router.route(
      createSignal({
        signal_kind: "potential_preference",
        confidence: 0.7,
        evidence_refs: []
      })
    );

    expect(target).toEqual({
      kind: "memory_and_claim",
      route_target: "memory_and_claim_draft",
      routing_reason:
        "object_kind=constraint -> memory_and_claim_draft (claim_status defaulted to draft by ClaimService)"
    });
  });

  it("routes potential_claim with empty evidence_refs to memory_and_claim at confidence boundary 0.5", () => {
    const router = createRouter();

    const target = router.route(
      createSignal({
        signal_kind: "potential_claim",
        confidence: 0.5,
        evidence_refs: []
      })
    );

    expect(target.kind).toBe("memory_and_claim");
  });

  it("defers invalid schema-grounded field candidates before memory_and_claim", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const signal = createSignal({
      confidence: 0.9,
      raw_payload: {
        schema_grounding: { version: 1 },
        detected_object: { object_kind: "constraint" },
        field_candidates: [],
        validation_result: { status: "deferred", reasons: ["field_candidates missing"] }
      }
    });

    expect(router.route(signal)).toMatchObject({
      kind: "deferred",
      routing_reason: expect.stringContaining("schema-grounded signal failed validation")
    });

    const result = await router.materializeSignal(signal);

    expect(result).toMatchObject({
      target_kind: "deferred",
      success: true,
      created_objects: []
    });
    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.claimService.create).not.toHaveBeenCalled();
  });

  it("does not materialize malformed schema-grounded host input after normalization", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);
    const signal = normalizeSchemaGroundedSignal(
      createSignal({
        confidence: 0.9,
        raw_payload: {
          schema_grounding: { version: 1, status: "valid" },
          detected_object: { object_kind: "constraint" },
          field_candidates: [
            {
              field_name: "constraint",
              evidence: "Never print secrets."
            }
          ],
          matched_text: "Never print secrets.",
          validation_result: { status: "valid", reasons: [] }
        }
      })
    );

    expect(router.route(signal)).toMatchObject({
      kind: "deferred",
      routing_reason: expect.stringContaining("schema-grounded signal failed validation")
    });

    const result = await router.materializeSignal(signal);

    expect(result).toMatchObject({
      target_kind: "deferred",
      success: true,
      created_objects: []
    });
    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.claimService.create).not.toHaveBeenCalled();
  });

  it("does NOT route potential_claim with confidence 0.49 to memory_and_claim (just below boundary)", () => {
    const router = createRouter();

    const target = router.route(
      createSignal({
        signal_kind: "potential_claim",
        confidence: 0.49,
        evidence_refs: []
      })
    );

    // 0.49 < 0.5 threshold → misses memory_and_claim, 0.49 >= 0.3 → evidence_only (not deferred)
    expect(target.kind).toBe("evidence_only");
  });

  it("routes potential_preference with confidence < 0.5 to evidence_only (not memory_and_claim)", () => {
    const router = createRouter();

    const target = router.route(
      createSignal({
        signal_kind: "potential_preference",
        confidence: 0.3,
        evidence_refs: []
      })
    );

    // 0.3 is below the 0.5 threshold for memory_and_claim but meets the 0.3 evidence_only floor
    expect(target.kind).toBe("evidence_only");
  });

  it("routes potential_synthesis with 2+ evidence refs to synthesis", () => {
    const router = createRouter();

    const target = router.route(
      createSignal({
        signal_kind: "potential_synthesis",
        evidence_refs: ["msg-1", "msg-2"]
      })
    );

    expect(target).toEqual({
      kind: "synthesis",
      route_target: "synthesis",
      routing_reason: "multi-evidence synthesis candidate"
    });
  });

  it("routes potential_handoff to handoff_gap", () => {
    const router = createRouter();

    const target = router.route(
      createSignal({
        signal_kind: "potential_handoff",
        evidence_refs: []
      })
    );

    expect(target).toEqual({
      kind: "handoff_gap",
      route_target: "handoff_gap",
      routing_reason: "run-bound handoff/gap detection"
    });
  });

  it("routes potential_evidence_anchor to evidence_only and low-confidence fallback to deferred", () => {
    const router = createRouter();

    const explicit = router.route(
      createSignal({
        signal_kind: "potential_evidence_anchor",
        evidence_refs: []
      })
    );
    // confidence < 0.3 → deferred: uncertain signal must not persist as evidence noise
    const deferred = router.route(
      createSignal({
        signal_kind: "potential_preference",
        confidence: 0.1,
        evidence_refs: []
      })
    );
    // confidence >= 0.3 but unroutable → still evidence_only
    const evidenceOnly = router.route(
      createSignal({
        signal_kind: "potential_preference",
        confidence: 0.35,
        evidence_refs: []
      })
    );

    expect(explicit).toEqual({
      kind: "evidence_only",
      route_target: "evidence_only",
      routing_reason: "evidence archival"
    });
    expect(deferred).toEqual({
      kind: "deferred",
      route_target: "deferred",
      routing_reason: "uncertain signal — deferred pending higher-confidence reconfirmation"
    });
    expect(evidenceOnly).toEqual({
      kind: "evidence_only",
      route_target: "evidence_only",
      routing_reason: "unroutable signal -> evidence archive (questionable evidence only)"
    });
  });

  it("materializes memory_and_claim by creating evidence, memory, and claim objects", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(createSignal());

    expect(result).toMatchObject({
      signal_id: "signal-1",
      target_kind: "memory_and_claim",
      success: true
    });
    expect(result.created_objects).toEqual([
      { object_kind: "evidence_capsule", object_id: "evidence-1" },
      { object_kind: "memory_entry", object_id: "memory-1" },
      { object_kind: "claim_form", object_id: "claim-1" }
    ]);
    expect(deps.evidenceService.create).toHaveBeenCalledTimes(1);
    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
    expect(deps.claimService.create).toHaveBeenCalledTimes(1);

    const evidenceInput = deps.evidenceService.create.mock.calls[0][0] as {
      readonly gist: string;
      readonly semantic_anchor: { readonly summary: string };
      readonly physical_anchor: { readonly artifact_ref: string } | null;
    };
    const memoryInput = deps.memoryService.create.mock.calls[0][0] as {
      readonly content: string;
    };
    const claimInput = deps.claimService.create.mock.calls[0][0] as {
      readonly proposition_digest: string;
    };

    expect(evidenceInput.gist).toBe("Never print secrets.");
    expect(evidenceInput.semantic_anchor.summary).toBe("Never print secrets.");
    expect(evidenceInput.physical_anchor?.artifact_ref).toBe("msg-1");
    expect(memoryInput.content).toBe("Never print secrets.");
    expect(claimInput.proposition_digest).toBe("Never print secrets.");
  });

  it("uses validated schema-grounded field values as memory content", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(
      createSignal({
        raw_payload: {
          schema_grounding: { version: 1, status: "valid" },
          detected_object: { object_kind: "constraint", confidence: 0.8 },
          field_candidates: [
            {
              field_name: "constraint",
              value: "Always use rtk for repo commands.",
              evidence: "Always use rtk for repo commands.",
              confidence: 0.8
            }
          ],
          validation_result: { status: "valid", reasons: [] }
        }
      })
    );

    expect(result.success).toBe(true);
    const memoryInput = deps.memoryService.create.mock.calls[0][0] as {
      readonly content: string;
    };
    expect(memoryInput.content).toBe("Always use rtk for repo commands.");
  });

  it("materializes synthesis by creating evidence objects and one synthesis capsule", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(
      createSignal({
        signal_kind: "potential_synthesis",
        evidence_refs: ["msg-1", "msg-2", "msg-3"]
      })
    );

    expect(result).toMatchObject({
      signal_id: "signal-1",
      target_kind: "synthesis",
      success: true
    });
    expect(result.created_objects).toEqual([
      { object_kind: "evidence_capsule", object_id: "evidence-1" },
      { object_kind: "evidence_capsule", object_id: "evidence-2" },
      { object_kind: "evidence_capsule", object_id: "evidence-3" },
      { object_kind: "synthesis_capsule", object_id: "synthesis-1" }
    ]);
    expect(deps.evidenceService.create).toHaveBeenCalledTimes(3);
    expect(deps.synthesisService.create).toHaveBeenCalledTimes(1);

    const evidenceInputs = deps.evidenceService.create.mock.calls.map((call) =>
      call[0] as {
        readonly gist: string;
        readonly semantic_anchor: { readonly summary: string };
      }
    );

    expect(evidenceInputs[0].gist).toBe("Never print secrets. signal_ref_1");
    expect(evidenceInputs[1].gist).toBe("Never print secrets. signal_ref_2");
    expect(evidenceInputs[2].gist).toBe("Never print secrets. signal_ref_3");
    for (const evidenceInput of evidenceInputs) {
      expect(evidenceInput.gist).not.toContain("[routing:");
      expect(evidenceInput.semantic_anchor.summary).not.toContain("[routing:");
    }
  });

  it("keeps routing reason in metadata and does not embed it into content fields", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(createSignal());

    expect(result.routing_reason).toBe(
      "object_kind=constraint -> memory_and_claim_draft (claim_status defaulted to draft by ClaimService)"
    );

    const evidenceInput = deps.evidenceService.create.mock.calls[0][0] as {
      readonly gist: string;
      readonly semantic_anchor: { readonly summary: string };
    };
    const memoryInput = deps.memoryService.create.mock.calls[0][0] as {
      readonly content: string;
    };
    const claimInput = deps.claimService.create.mock.calls[0][0] as {
      readonly proposition_digest: string;
    };

    expect(evidenceInput.gist).not.toContain("[routing:");
    expect(evidenceInput.semantic_anchor.summary).not.toContain("[routing:");
    expect(memoryInput.content).not.toContain("[routing:");
    expect(claimInput.proposition_digest).not.toContain("[routing:");
  });

  it("materializes handoff_gap into in-memory handoff records with ttl", async () => {
    const deps = createDeps();
    const handoffHandler = new InMemoryHandoffGapHandler({
      now: () => "2026-03-21T00:00:00.000Z",
      ttlMs: 60_000
    });
    const router = new MaterializationRouter({
      ...deps,
      handoffGapHandler: handoffHandler
    });

    const result = await router.materializeSignal(
      createSignal({
        signal_kind: "potential_handoff",
        evidence_refs: []
      })
    );

    expect(result).toMatchObject({
      signal_id: "signal-1",
      target_kind: "handoff_gap",
      success: true,
      created_objects: [{ object_kind: "handoff_record" }]
    });

    const records = handoffHandler.listHandoffs();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      object_kind: "handoff_record",
      handoff_kind: "run_handoff",
      source_run_id: "run-1",
      ttl_ms: 60_000,
      recurrence_runs: null,
      recurrence_surfaces: null,
      governance_impact: null,
      unresolved_age_ms: null,
      upgrade_candidate: null
    });
  });

  it("materializes handoff_gap into gap_record when signal explicitly marks a gap", async () => {
    const deps = createDeps();
    const handoffHandler = new InMemoryHandoffGapHandler({
      now: () => "2026-03-21T00:00:00.000Z",
      ttlMs: 60_000
    });
    const router = new MaterializationRouter({
      ...deps,
      handoffGapHandler: handoffHandler
    });

    const result = await router.materializeSignal(
      createSignal({
        signal_kind: "potential_handoff",
        object_kind: "context_gap",
        evidence_refs: [],
        raw_payload: {
          gap_detected: true,
          excerpt: "Missing deployment checklist."
        }
      })
    );

    expect(result).toMatchObject({
      target_kind: "handoff_gap",
      success: true,
      created_objects: [{ object_kind: "gap_record" }]
    });

    const records = handoffHandler.listHandoffs();
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      object_kind: "gap_record",
      gap_kind: "context_gap",
      description: "Missing deployment checklist.",
      ttl_ms: 60_000
    });
  });

  it("materializes evidence_only by creating only an evidence capsule", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(
      createSignal({
        signal_kind: "potential_evidence_anchor",
        evidence_refs: []
      })
    );

    expect(result).toMatchObject({
      signal_id: "signal-1",
      target_kind: "evidence_only",
      success: true,
      created_objects: [{ object_kind: "evidence_capsule", object_id: "evidence-1" }]
    });
    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.claimService.create).not.toHaveBeenCalled();
  });

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
    const memoryInput = deps.memoryService.create.mock.calls[0][0];
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

    const memoryInput = deps.memoryService.create.mock.calls[0][0];
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

    const memoryInput = deps.memoryService.create.mock.calls[0][0];
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

    const memoryInput = deps.memoryService.create.mock.calls[0][0] as {
      readonly content: string;
    };
    // A supplied distilled_fact is already a resolved one-assertion fact;
    // it is clamped to the cap but never "..."-truncated. The ellipsis
    // belongs only to ruleDistillFromRaw (raw text -> distilled).
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

    const memoryInput = deps.memoryService.create.mock.calls[0][0] as {
      readonly content: string;
    };
    expect(memoryInput.content).toBe(fact);
  });

  it("creates supersedes / exception_to / contradicts / incompatible_with edges from raw_payload refs", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    await router.materializeSignal(
      createSignal({
        raw_payload: {
          excerpt: "Replaces older preference.",
          supersedes_refs: ["mem-old-1"],
          exception_to_refs: ["mem-rule-2"],
          contradicts_refs: ["mem-conflict-3"],
          incompatible_with_refs: ["mem-incompat-4"]
        }
      })
    );

    const calls = deps.graphEdgePort.createEdge.mock.calls.map((args) => args[0]);
    const edgeTypes = calls.map((edge) => edge.edgeType);
    expect(edgeTypes).toEqual(
      expect.arrayContaining(["supersedes", "exception_to", "contradicts", "incompatible_with"])
    );
    const supersedesEdge = calls.find((edge) => edge.edgeType === "supersedes");
    expect(supersedesEdge).toMatchObject({
      sourceMemoryId: "memory-1",
      targetMemoryId: "mem-old-1"
    });
  });

  it("invokes conflictDetectionPort with the new memory facts when wired", async () => {
    const deps = createDeps();
    const detectAndLinkConflicts = vi.fn<DetectFn>(async () => undefined);
    const router = new MaterializationRouter({
      ...deps,
      conflictDetectionPort: { detectAndLinkConflicts }
    });

    await router.materializeSignal(createSignal());

    expect(detectAndLinkConflicts).toHaveBeenCalledTimes(1);
    const call = detectAndLinkConflicts.mock.calls[0][0];
    expect(call.newMemoryId).toBe("memory-1");
    expect(call.workspaceId).toBe("workspace-1");
  });

  it("does not call conflictDetectionPort when port is absent", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(createSignal());

    expect(result.success).toBe(true);
  });
});

// invariant: ingest reconciliation gate on the memory_entry_only path.
// With no reconciliationPort the router appends every fact (the unchanged
// default). With the port wired the core service decides FIRST and then
// drives the router's applyVerdict callback per verdict: ADD creates the
// evidence_capsule + memory_entry, UPDATE creates the evidence_capsule
// only (the core service relinks it), NOOP creates nothing — keeping a
// re-seed of the same fact idempotent. A runConflictScan flag drives the
// existing ConflictDetectionService.
// see also: packages/core/src/reconciliation-service.ts
type RunWithDecisionFn = NonNullable<
  ConstructorParameters<typeof MaterializationRouter>[0]["reconciliationPort"]
>["runWithDecision"];
type DetectFn = NonNullable<
  ConstructorParameters<typeof MaterializationRouter>[0]["conflictDetectionPort"]
>["detectAndLinkConflicts"];

// invariant: a fake reconciliation port that runs the router's
// applyVerdict callback exactly as the core service would — emit the
// verdict, invoke the callback, and on an UPDATE-apply failure re-drive
// the callback with a degraded ADD. The `verdict` describes the decision
// and an optional `updateFails` flag exercises the degrade path.
function fakeReconciliationPort(
  verdict: {
    readonly kind: "add" | "update" | "noop";
    readonly survivingObjectId?: string;
    readonly runConflictScan?: boolean;
    readonly reason?: string;
  },
  options: { readonly updateFails?: boolean } = {}
): {
  readonly reconciliationPort: { runWithDecision: ReturnType<typeof vi.fn<RunWithDecisionFn>> };
  readonly appliedVerdicts: string[];
} {
  const appliedVerdicts: string[] = [];
  const runWithDecision = vi.fn<RunWithDecisionFn>(async (_input, applyVerdict) => {
    const decisionView = {
      kind: verdict.kind,
      ...(verdict.survivingObjectId === undefined
        ? {}
        : { survivingObjectId: verdict.survivingObjectId }),
      runConflictScan: verdict.runConflictScan ?? false,
      reason: verdict.reason ?? "verdict"
    } as const;
    appliedVerdicts.push(decisionView.kind);
    await applyVerdict(decisionView);
    if (verdict.kind === "update" && options.updateFails) {
      const degraded = {
        kind: "add" as const,
        runConflictScan: true,
        reason: "LLM UPDATE could not be applied — added with conflict scan"
      };
      appliedVerdicts.push(degraded.kind);
      await applyVerdict(degraded);
      return degraded;
    }
    return decisionView;
  });
  return { reconciliationPort: { runWithDecision }, appliedVerdicts };
}

describe("MaterializationRouter ingest reconciliation", () => {
  function factSignal(overrides: Partial<CandidateMemorySignal> = {}): CandidateMemorySignal {
    return createSignal({
      object_kind: "fact",
      signal_kind: "potential_claim",
      confidence: 0.8,
      raw_payload: { excerpt: "The user lives in Berlin.", distilled_fact: "The user lives in Berlin." },
      ...overrides
    });
  }

  it("appends every fact when no reconciliationPort is wired (unchanged default)", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(factSignal());

    expect(result.success).toBe(true);
    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
    expect(result.created_objects).toContainEqual({
      object_kind: "memory_entry",
      object_id: "memory-1"
    });
  });

  it("ADD verdict creates the evidence capsule then the memory entry", async () => {
    const deps = createDeps();
    const { reconciliationPort } = fakeReconciliationPort({ kind: "add" });
    const router = new MaterializationRouter({ ...deps, reconciliationPort });

    const result = await router.materializeSignal(factSignal());

    expect(result.success).toBe(true);
    expect(deps.evidenceService.create).toHaveBeenCalledTimes(1);
    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
    // The router passes the freshly-created evidence ref into memory creation.
    const memoryInput = deps.memoryService.create.mock.calls[0][0] as {
      readonly evidence_refs: readonly string[];
    };
    expect(memoryInput.evidence_refs).toEqual(["evidence-1"]);
    expect(result.created_objects).toEqual([
      { object_kind: "evidence_capsule", object_id: "evidence-1" },
      { object_kind: "memory_entry", object_id: "memory-1" }
    ]);
  });

  it("ADD verdict runs the conflict scan when flagged", async () => {
    const deps = createDeps();
    const { reconciliationPort } = fakeReconciliationPort({ kind: "add", runConflictScan: true });
    const detectAndLinkConflicts = vi.fn<DetectFn>(async () => undefined);
    const router = new MaterializationRouter({
      ...deps,
      reconciliationPort,
      conflictDetectionPort: { detectAndLinkConflicts }
    });

    const result = await router.materializeSignal(factSignal());

    expect(result.success).toBe(true);
    expect(deps.memoryService.create).toHaveBeenCalledTimes(1);
    expect(detectAndLinkConflicts).toHaveBeenCalledTimes(1);
    expect(detectAndLinkConflicts.mock.calls[0][0].newMemoryId).toBe("memory-1");
  });

  it("ADD verdict without the conflict-scan flag does not run the scan", async () => {
    const deps = createDeps();
    const { reconciliationPort } = fakeReconciliationPort({ kind: "add", runConflictScan: false });
    const detectAndLinkConflicts = vi.fn<DetectFn>(async () => undefined);
    const router = new MaterializationRouter({
      ...deps,
      reconciliationPort,
      conflictDetectionPort: { detectAndLinkConflicts }
    });

    await router.materializeSignal(factSignal());

    expect(detectAndLinkConflicts).not.toHaveBeenCalled();
  });

  it("NOOP verdict creates nothing — no evidence capsule, no memory entry", async () => {
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
    // NOOP mints no evidence capsule — a re-seed of the same fact does
    // not accumulate evidence on the surviving row.
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
    // The evidence capsule is created so the core service can relink it;
    // the surviving refined row is reported for the bench sidecar.
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
    // The evidence capsule is created once and reused for the degraded
    // ADD; the memory entry is appended exactly once.
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

function createRouter() {
  return new MaterializationRouter(createDeps());
}

// invariant: the materialization-port mocks carry an explicit one-arg
// signature so `.mock.calls[0][0]` is a typed argument record rather
// than an out-of-range index into an empty params tuple. The arg type
// is the structural shape the assertions read; behavior is unchanged.
interface MockCreatedObject {
  readonly object_kind: string;
  readonly object_id: string;
}
type MockServiceInput = Record<string, unknown>;
type MockEdgeInput = {
  readonly sourceMemoryId: string;
  readonly targetMemoryId: string;
  readonly edgeType: string;
};

function createDeps() {
  let evidenceCounter = 0;

  return {
    evidenceService: {
      create: vi.fn<(input: MockServiceInput) => Promise<MockCreatedObject>>(async () => {
        evidenceCounter += 1;
        return {
          object_kind: "evidence_capsule",
          object_id: `evidence-${evidenceCounter}`
        };
      })
    },
    memoryService: {
      create: vi.fn<(input: MockServiceInput) => Promise<MockCreatedObject>>(async () => ({
        object_kind: "memory_entry",
        object_id: "memory-1"
      }))
    },
    synthesisService: {
      create: vi.fn<(input: MockServiceInput) => Promise<MockCreatedObject>>(async () => ({
        object_kind: "synthesis_capsule",
        object_id: "synthesis-1"
      }))
    },
    claimService: {
      create: vi.fn<(input: MockServiceInput) => Promise<MockCreatedObject>>(async () => ({
        object_kind: "claim_form",
        object_id: "claim-1"
      }))
    },
    graphEdgePort: {
      createEdge: vi.fn<(input: MockEdgeInput) => Promise<void>>(async () => undefined)
    },
    handoffGapHandler: new InMemoryHandoffGapHandler()
  };
}
