import { describe, expect, it, vi } from "vitest";
import {
  InMemoryHandoffGapHandler,
  MaterializationRouter,
  normalizeSchemaGroundedSignal
} from "@do-soul/alaya-soul";
import { type EnqueueFn, createDeps, createRouter, createSignal } from "./materialization-router-fixture.js";

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
});
