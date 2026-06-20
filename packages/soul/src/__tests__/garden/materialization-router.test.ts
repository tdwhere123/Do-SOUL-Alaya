import { describe, expect, it, vi } from "vitest";
import {
  InMemoryHandoffGapHandler,
  MaterializationRouter,
  normalizeSchemaGroundedSignal
} from "@do-soul/alaya-soul";
import {
  type EnqueueFn,
  type MockCreatedObjectWithEnrich,
  createDeps,
  createRouter,
  createSignal
} from "./materialization-router-fixture.js";

describe("MaterializationRouter", () => {  it("routes potential_claim to memory_and_claim when confidence and evidence thresholds pass", () => {
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

});
