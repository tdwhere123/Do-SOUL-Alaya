import { describe, expect, it, vi } from "vitest";
import {
  DISTILLED_FACT_MAX_CHARS,
  InMemoryHandoffGapHandler,
  MaterializationRouter,
  normalizeSchemaGroundedSignal
} from "@do-soul/alaya-soul";
import type { PathCandidateMintOutcome } from "@do-soul/alaya-soul";
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
    source_memory_refs: [],
    supersedes_refs: [],
    exception_to_refs: [],
    contradicts_refs: [],
    incompatible_with_refs: [],
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

  it("enqueues enrichment after memory_and_claim creates a memory entry (no inline enrichment)", async () => {
    const deps = createDeps();
    const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
    const router = new MaterializationRouter({ ...deps, enrichPendingPort });

    await router.materializeSignal(createSignal());

    expect(enrichPendingPort.enqueue).toHaveBeenCalledTimes(1);
    expect(enrichPendingPort.enqueue).toHaveBeenCalledWith({
      memoryId: "memory-1",
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });
  });

  it("passes the enrichment intent on the create input so the marker commits atomically", async () => {
    const deps = createDeps();
    const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
    const router = new MaterializationRouter({ ...deps, enrichPendingPort });

    await router.materializeSignal(createSignal());

    const memoryInput = deps.memoryService.create.mock.calls[0][0] as {
      readonly enqueueEnrichment?: { readonly runId: string | null; readonly sourceSignalId: string | null };
    };
    expect(memoryInput.enqueueEnrichment).toEqual({ runId: "run-1", sourceSignalId: "signal-1" });
  });

  it("skips the loud fallback enqueue when the create reported it enqueued atomically", async () => {
    const deps = createDeps();
    // The atomic-capable create commits the row + marker in one transaction and
    // reports enrichmentEnqueued: true, so the router must NOT enqueue again.
    deps.memoryService.create = vi.fn<(input: Record<string, unknown>) => Promise<MockCreatedObjectWithEnrich>>(
      async () => ({ object_kind: "memory_entry", object_id: "memory-1", enrichmentEnqueued: true })
    );
    const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
    const router = new MaterializationRouter({ ...deps, enrichPendingPort });

    const result = await router.materializeSignal(createSignal());

    expect(result.success).toBe(true);
    expect(enrichPendingPort.enqueue).not.toHaveBeenCalled();
  });

  it("fails the branch loudly when the marker enqueue throws and the create did not enqueue atomically", async () => {
    // invariant pinned: the enrich_pending marker is the mandatory no-drop
    // handoff. When the create did NOT commit it atomically and the fallback
    // enqueue write itself throws, the branch must NOT return success: true with
    // a memory stranded marker-less — it surfaces so SignalService marks the
    // signal FAILED (a swallow here is the B6 regression this fix closes).
    const deps = createDeps();
    const enrichPendingPort = {
      enqueue: vi.fn<EnqueueFn>(() => {
        throw new Error("SQLITE_BUSY: enrich_pending insert failed");
      })
    };
    const router = new MaterializationRouter({ ...deps, enrichPendingPort });

    const result = await router.materializeSignal(createSignal());

    expect(result.success).toBe(false);
    expect(result.error).toContain("SQLITE_BUSY");
    expect(enrichPendingPort.enqueue).toHaveBeenCalledTimes(1);
  });

  it("fails the memory_entry_only append branch loudly when the marker enqueue throws", async () => {
    const deps = createDeps();
    const enrichPendingPort = {
      enqueue: vi.fn<EnqueueFn>(() => {
        throw new Error("disk full");
      })
    };
    const router = new MaterializationRouter({ ...deps, enrichPendingPort });

    const result = await router.materializeSignal(
      createSignal({ object_kind: "fact", raw_payload: { distilled_fact: "The user lives in Berlin." } })
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain("disk full");
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

  it("keeps the memory enriched when the time_concern proposal throws on memory_and_claim", async () => {
    // invariant (codex spine-review B6): the optional time_concern proposal is
    // a best-effort side effect on top of an already-durable memory. A throw
    // must NOT strand the memory — enrich_pending is enqueued BEFORE the
    // proposal, and the branch still returns success so SignalService does not
    // mark the signal terminally FAILED.
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
    expect(enrichPendingPort.enqueue.mock.calls[0][0].memoryId).toBe("memory-1");
    expect(pathRelationProposalPort.createPathRelationProposal).toHaveBeenCalledTimes(1);
    // The failed optional proposal contributes no created object.
    expect(result.created_objects).not.toContainEqual(
      expect.objectContaining({ object_kind: "proposal" })
    );
  });

  it("keeps the memory enriched when the time_concern proposal throws on memory_entry_only append", async () => {
    // invariant (codex spine-review B6): same no-drop guarantee on the
    // memory_entry_only append branch.
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
    expect(enrichPendingPort.enqueue.mock.calls[0][0].memoryId).toBe("memory-1");
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

  it("submits supersedes / exception_to / contradicts / incompatible_with path candidates from first-class refs", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

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

    // Signal refs submit governed path candidates with family-correct
    // recall_bias signs.
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
    // invariant (governance): an agent-asserted negative ref is a weak
    // claim, not a system conflict ruling. One injected contradicts_ref
    // yields exactly one attention_only / strength-0.5 path that must earn
    // recall eligibility through plasticity — it never mints a
    // recall_allowed/0.9 negative path. Defeats the prompt-injection
    // amplification surface: a single ref = a single decaying weak path.
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

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
    // one ref -> at most one path
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
    // invariant: source_memory_refs honored on memory_and_claim branch.
    // see also: createAllMemoryRefEdges
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

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
    // invariant: detectAndLinkConflicts moved to the BULK_ENRICH worker. The
    // write-path must stay synchronous-ack: it enqueues an enrich_pending
    // marker and never calls the conflict scan inline.
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
    expect(enrichPendingPort.enqueue.mock.calls[0][0].memoryId).toBe("memory-1");
  });

  it("does not enqueue enrichment when enrichPendingPort is absent", async () => {
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
type EnqueueFn = NonNullable<
  ConstructorParameters<typeof MaterializationRouter>[0]["enrichPendingPort"]
>["enqueue"];

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

  it("memory_entry_only append branch enqueues enrichment after creating a memory", async () => {
    const deps = createDeps();
    const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
    const router = new MaterializationRouter({ ...deps, enrichPendingPort });

    await router.materializeSignal(factSignal());

    expect(enrichPendingPort.enqueue).toHaveBeenCalledTimes(1);
    expect(enrichPendingPort.enqueue).toHaveBeenCalledWith({
      memoryId: "memory-1",
      workspaceId: "workspace-1",
      runId: "run-1",
      sourceSignalId: "signal-1"
    });
  });

  it("memory_entry_only append branch honors first-class source_memory_refs", async () => {
    // invariant: source_memory_refs are consumed on every memory-creating
    // materialization branch. memory_entry_only (fact / outcome / reference
    // / task_state) must emit derives_from edges with the same semantics
    // as memory_and_claim — otherwise D-1 KPI attribution silently drops
    // the ~40% of bench-seed object kinds that flow through this branch.
    // see also: createAllMemoryRefEdges
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    await router.materializeSignal(
      factSignal({
        source_memory_refs: ["mem-prior-1", "mem-prior-2"],
        raw_payload: {
          excerpt: "Derived fact for D-1 attribution.",
          distilled_fact: "Derived fact for D-1 attribution."
        }
      })
    );

    const calls = deps.pathCandidateSinkPort.submitCandidate.mock.calls.map((args) => args[0]);
    const derivesFrom = calls.filter((candidate) => candidate.relationKind === "derives_from");
    expect(derivesFrom).toHaveLength(2);
    expect(derivesFrom.map((candidate) => candidate.targetAnchor.object_id).sort()).toEqual([
      "mem-prior-1",
      "mem-prior-2"
    ]);
    expect(
      derivesFrom.every((candidate) => candidate.sourceAnchor.object_id === "memory-1")
    ).toBe(true);
  });

  it("defers every first-class memory ref to the gating sink, which refuses refs that fail existence/ownership", async () => {
    // invariant (codex spine-review B3): first-class *_refs are agent/Garden
    // PROPOSALS, not durable truth. The router forwards each ref to the path
    // candidate sink, but the sink — PathRelationProposalService — DECIDES:
    // a ref whose object does not exist in (or is owned by another workspace
    // than) this workspace is REFUSED and never becomes durable topology.
    // The router must not silently mint paths from arbitrary agent refs; it
    // hands the decision to the gate and tolerates a refusal (false) per ref.
    // see also: packages/core path-relation-proposal-service.anchor-gate.test.ts
    const deps = createDeps();
    // Model the durable gate: only "mem-prior-1" is a real object in this
    // workspace; the other refs are missing or foreign and are permanently
    // rejected (a decided B3 refusal, not a transient failure).
    const validRefs = new Set(["mem-prior-1"]);
    deps.pathCandidateSinkPort.submitCandidate.mockImplementation(async (input) =>
      validRefs.has(input.targetAnchor.object_id) ? "applied" : "rejected"
    );
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(
      factSignal({
        source_memory_refs: ["mem-prior-1"],
        supersedes_refs: ["mem-old-1"],
        exception_to_refs: ["mem-rule-2"],
        contradicts_refs: ["mem-conflict-3"],
        incompatible_with_refs: ["mem-incompat-4"],
        raw_payload: {
          excerpt: "Fact with stray claim-bearing refs.",
          distilled_fact: "Fact with stray claim-bearing refs."
        }
      })
    );

    // The memory itself is still materialized; ref gating never blocks it.
    expect(result.success).toBe(true);

    const calls = deps.pathCandidateSinkPort.submitCandidate.mock.calls.map((args) => args[0]);
    const results = deps.pathCandidateSinkPort.submitCandidate.mock.results.map(
      (entry) => entry.value
    );
    // The router forwards each ref to the gate (its job), but only the valid
    // ref is accepted; the four missing/foreign refs are refused by the sink.
    const accepted = await Promise.all(results);
    const decisions = calls.map((candidate, idx) => [
      candidate.targetAnchor.object_id,
      accepted[idx]
    ]);
    expect(decisions).toEqual([
      ["mem-prior-1", "applied"],
      ["mem-old-1", "rejected"],
      ["mem-rule-2", "rejected"],
      ["mem-conflict-3", "rejected"],
      ["mem-incompat-4", "rejected"]
    ]);
  });

  it("emits a LOUD signal when a signal-ref path candidate fails transiently so the dropped edge is not silently lost", async () => {
    // invariant (codex spine-review B5): a TRANSIENT "failed" signal-ref mint
    // must NOT be silently settled. BULK_ENRICH does not re-derive a signal's
    // *_memory_refs (its produceForNewMemory derives neighbors from memory
    // content via searchByKeyword, never from the original signal refs), so
    // the inline mint is the ONLY producer for this edge — a swallowed "failed"
    // permanently drops it with no retry and no audit. The router therefore
    // makes "failed" observable (loud warn naming the dropped ref) instead of
    // collapsing it into the same silent path as a decided "rejected".
    // see also: apps/core-daemon/src/garden-runtime.ts runBulkEnrichTask.
    const deps = createDeps();
    deps.pathCandidateSinkPort.submitCandidate.mockImplementation(async (input) =>
      input.targetAnchor.object_id === "mem-transient" ? "failed" : "applied"
    );
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const router = new MaterializationRouter(deps);

    try {
      const result = await router.materializeSignal(
        factSignal({
          source_memory_refs: ["mem-transient"],
          raw_payload: {
            excerpt: "Fact whose derives_from edge mint fails transiently.",
            distilled_fact: "Fact whose derives_from edge mint fails transiently."
          }
        })
      );

      // The memory itself still materializes — a best-effort edge never blocks it.
      expect(result.success).toBe(true);

      const loud = warnSpy.mock.calls.filter(
        (args) =>
          typeof args[0] === "string" &&
          args[0].includes("signal-ref path candidate failed transiently")
      );
      expect(loud).toHaveLength(1);
      expect(loud[0]?.[1]).toMatchObject({
        sourceMemoryId: "memory-1",
        targetMemoryId: "mem-transient",
        relationKind: "derives_from",
        signalRefsKey: "source_memory_refs"
      });
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("keeps a permanently-rejected signal-ref a CLEAN silent drop (no loud failure noise)", async () => {
    // invariant (codex spine-review B5): only "failed" gets the non-silent
    // treatment. A "rejected" is a DECIDED B3 anchor refusal — already audited
    // by the path service, and retry cannot help — so the router must drop it
    // quietly. It must NOT emit the transient-failure loud warn (that is
    // reserved for "failed"); doing so would turn every legitimate stray-ref
    // refusal into false alarm noise.
    const deps = createDeps();
    deps.pathCandidateSinkPort.submitCandidate.mockResolvedValue("rejected");
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const router = new MaterializationRouter(deps);

    try {
      const result = await router.materializeSignal(
        factSignal({
          source_memory_refs: ["mem-foreign"],
          raw_payload: {
            excerpt: "Fact referencing a foreign/missing memory.",
            distilled_fact: "Fact referencing a foreign/missing memory."
          }
        })
      );

      expect(result.success).toBe(true);
      // The sink was consulted (the gate decides), but the rejection produces
      // no transient-failure loud warn.
      expect(deps.pathCandidateSinkPort.submitCandidate).toHaveBeenCalledTimes(1);
      const loud = warnSpy.mock.calls.filter(
        (args) =>
          typeof args[0] === "string" &&
          args[0].includes("signal-ref path candidate failed transiently")
      );
      expect(loud).toHaveLength(0);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("ADD verdict (reconciled path) also creates derives_from edges from source_memory_refs", async () => {
    // invariant: parity with the append branch. The reconciled-ADD path
    // mints a fresh memory_entry and must honor source_memory_refs so D-1
    // attribution covers both append and reconciled-add flows. UPDATE /
    // NOOP do not mint a new memory_entry and intentionally skip edges.
    const deps = createDeps();
    const { reconciliationPort } = fakeReconciliationPort({ kind: "add" });
    const router = new MaterializationRouter({ ...deps, reconciliationPort });

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

  it("ADD verdict keeps the memory enriched when the time_concern proposal throws", async () => {
    // invariant (codex spine-review B6): on the reconciled-ADD branch the
    // enrich_pending marker is enqueued for the appended memory BEFORE the
    // optional time_concern proposal, so a proposal throw cannot strand the
    // memory or flip the branch to terminally-FAILED success: false.
    const deps = createDeps();
    const { reconciliationPort } = fakeReconciliationPort({ kind: "add" });
    const pathRelationProposalPort = {
      createPathRelationProposal: vi.fn(async () => {
        throw new Error("path relation proposal port unavailable");
      })
    };
    const enrichPendingPort = { enqueue: vi.fn<EnqueueFn>(() => undefined) };
    const router = new MaterializationRouter({
      ...deps,
      reconciliationPort,
      pathRelationProposalPort,
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
      })
    );

    expect(result.success).toBe(true);
    expect(enrichPendingPort.enqueue).toHaveBeenCalledTimes(1);
    expect(enrichPendingPort.enqueue.mock.calls[0][0].memoryId).toBe("memory-1");
    expect(pathRelationProposalPort.createPathRelationProposal).toHaveBeenCalledTimes(1);
  });

  it("UPDATE verdict (reconciled path) does not create derives_from edges", async () => {
    // invariant: UPDATE rewrites an existing memory in place and does not
    // mint a new memory_entry endpoint. Creating a derives_from edge from
    // the surviving id would invent provenance the producer did not assert.
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
    // invariant: NOOP mints no fresh memory_entry and no fresh evidence;
    // there is no edge endpoint to anchor a derives_from on.
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

  it("ADD verdict enqueues enrichment and never runs conflict detection inline (regardless of the old runConflictScan flag)", async () => {
    // invariant: the reconciliation runConflictScan flag no longer gates inline
    // work — every ADD-minted memory is enqueued and the BULK_ENRICH worker
    // runs both governed services. The write-path must not call
    // detectAndLinkConflicts inline for either flag value.
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
      expect(enrichPendingPort.enqueue.mock.calls[0][0].memoryId).toBe("memory-1");
    }
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
// invariant: mirrors MemoryMaterializationCreatedObject — the memory-create port
// optionally reports whether the enrich_pending marker committed atomically.
interface MockCreatedObjectWithEnrich extends MockCreatedObject {
  readonly enrichmentEnqueued?: boolean;
}
type MockServiceInput = Record<string, unknown>;
type MockPathCandidateInput = {
  readonly workspaceId: string;
  readonly sourceAnchor: { readonly kind: "object"; readonly object_id: string };
  readonly targetAnchor: { readonly kind: "object"; readonly object_id: string };
  readonly relationKind: string;
  readonly recallBiasSign: 1 | 0 | -1;
  readonly governanceClass: string;
  readonly initialStrength: number;
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
    pathCandidateSinkPort: {
      submitCandidate: vi.fn<(input: MockPathCandidateInput) => Promise<PathCandidateMintOutcome>>(
        async () => "applied"
      )
    },
    handoffGapHandler: new InMemoryHandoffGapHandler()
  };
}
