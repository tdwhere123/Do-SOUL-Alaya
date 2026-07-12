import { describe, expect, it, vi } from "vitest";
import {
  InMemoryHandoffGapHandler,
  MaterializationRouter} from "@do-soul/alaya-soul";
import {
  type EnqueueFn,
  createDeps,
  createSignal
} from "./materialization-router-fixture.js";

describe("MaterializationRouter", () => {  it("fails the branch loudly when the marker enqueue throws and the create did not enqueue atomically", async () => {
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
    const memoryInput = deps.memoryService.create.mock.calls[0]![0] as {
      readonly content: string;
    };
    expect(memoryInput.content).toBe("Always use rtk for repo commands.");
  });

  it("rebuilds official durable content from the complete source assertion", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);
    const source = "I never moved to Berlin.";

    const result = await router.materializeSignal(createSignal({
      source: "garden_compile",
      raw_payload: {
        provider_kind: "official_api",
        matched_text: source,
        proposed_matched_text: "moved to Berlin",
        full_turn_content: source,
        distilled_fact: "Alice lives in Berlin.",
        source_assertion: source,
        source_grounding: {
          version: 1,
          status: "grounded",
          content_basis: "source_assertion",
          source_assertion: source,
          proposed_matched_text: "moved to Berlin",
          reasons: ["matched_text_expanded_to_source_assertion"]
        }
      }
    }));

    expect(result.success).toBe(true);
    const memoryInput = deps.memoryService.create.mock.calls[0]![0] as {
      readonly content: string;
    };
    expect(memoryInput.content).toBe(source);
  });


  it("materializes synthesis by creating evidence objects and one synthesis capsule", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(
      createSignal({
        signal_kind: "potential_synthesis",
        evidence_refs: ["msg-1", "msg-2", "msg-3"],
        source_memory_refs: ["memory-source-1", "memory-source-2"]
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
    expect(deps.synthesisService.create.mock.calls[0]![0]).toMatchObject({
      source_memory_refs: ["memory-source-1", "memory-source-2"]
    });

    const evidenceInputs = deps.evidenceService.create.mock.calls.map((call) =>
      call[0] as {
        readonly gist: string;
        readonly physical_anchor: { readonly artifact_ref: string } | null;
        readonly semantic_anchor: { readonly summary: string };
      }
    );

    expect(evidenceInputs[0]!.gist).toBe("Never print secrets. msg-1");
    expect(evidenceInputs[0]!.physical_anchor?.artifact_ref).toBe("msg-1");
    expect(evidenceInputs[1]!.gist).toBe("Never print secrets. msg-2");
    expect(evidenceInputs[1]!.physical_anchor?.artifact_ref).toBe("msg-2");
    expect(evidenceInputs[2]!.gist).toBe("Never print secrets. msg-3");
    expect(evidenceInputs[2]!.physical_anchor?.artifact_ref).toBe("msg-3");
    for (const evidenceInput of evidenceInputs) {
      expect(evidenceInput.gist).not.toContain("[routing:");
      expect(evidenceInput.semantic_anchor.summary).not.toContain("[routing:");
    }
  });

  it("does not fabricate evidence when synthesis materialization lacks two real evidence refs", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materialize(
      createSignal({
        signal_kind: "potential_synthesis",
        evidence_refs: ["msg-1"],
        source_memory_refs: ["memory-source-1", "memory-source-2"]
      }),
      {
        kind: "synthesis",
        route_target: "synthesis",
        routing_reason: "forced synthesis test target"
      }
    );

    expect(result).toMatchObject({
      signal_id: "signal-1",
      target_kind: "synthesis",
      success: false,
      error: "Synthesis materialization requires at least two evidence_refs"
    });
    expect(result.created_objects).toEqual([]);
    expect(deps.evidenceService.create).not.toHaveBeenCalled();
    expect(deps.synthesisService.create).not.toHaveBeenCalled();
  });


  it("keeps routing reason in metadata and does not embed it into content fields", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(createSignal());

    expect(result.routing_reason).toBe(
      "object_kind=constraint -> memory_and_claim_draft (claim_status defaulted to draft by ClaimService)"
    );

    const evidenceInput = deps.evidenceService.create.mock.calls[0]![0] as {
      readonly gist: string;
      readonly semantic_anchor: { readonly summary: string };
    };
    const memoryInput = deps.memoryService.create.mock.calls[0]![0] as {
      readonly content: string;
    };
    const claimInput = deps.claimService.create.mock.calls[0]![0] as {
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
