import { describe, expect, it } from "vitest";
import {
  LocalHeuristics,
  MaterializationRouter,
  normalizeSchemaGroundedSignal
} from "@do-soul/alaya-soul";
import {
  createDeps,
  createRouter,
  createSignal
} from "./materialization-router-fixture.js";

describe("MaterializationRouter routing and grounding", () => {
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

  it("defers rejected official source grounding before durable writes", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);
    const signal = createSignal({
      source: "garden_compile",
      raw_payload: {
        provider_kind: "official_api",
        matched_text: "Alice moved to Berlin.",
        full_turn_content: "I never moved to Berlin.",
        source_grounding: {
          version: 1,
          status: "rejected",
          content_basis: "none",
          proposed_matched_text: "Alice moved to Berlin.",
          reasons: ["matched_text_absent"]
        }
      }
    });

    expect(router.route(signal)).toMatchObject({
      kind: "deferred",
      routing_reason: "garden source grounding failed: source_grounding_rejected"
    });
    await router.materializeSignal(signal);
    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.claimService.create).not.toHaveBeenCalled();
  });

  it("rejects a self-asserted fallback that is absent from the available full turn", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);
    const signal = createSignal({
      source: "garden_compile",
      object_kind: "activity",
      confidence: 0.9,
      raw_payload: {
        provider_kind: "official_api",
        full_turn_content: "I stayed in Paris.",
        proposed_matched_text: "moved to Berlin",
        source_assertion: "I moved to Berlin.",
        source_grounding: {
          version: 1,
          status: "grounded",
          content_basis: "source_assertion",
          source_assertion: "I moved to Berlin.",
          proposed_matched_text: "moved to Berlin",
          reasons: []
        }
      }
    });
    expect(router.route(signal)).toMatchObject({
      kind: "deferred",
      routing_reason: expect.stringContaining("source grounding failed")
    });
    await router.materializeSignal(signal);
    expect(deps.memoryService.create).not.toHaveBeenCalled();
  });

  it("fails closed for an ungrounded Garden signal even when provider metadata is absent", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);
    const signal = createSignal({
      source: "garden_compile",
      object_kind: "activity",
      confidence: 0.9,
      raw_payload: { distilled_fact: "The operator practices piano daily." }
    });
    expect(router.route(signal)).toMatchObject({
      kind: "deferred",
      routing_reason: "garden source grounding failed: source_grounding_missing"
    });
    await router.materializeSignal(signal);
    expect(deps.memoryService.create).not.toHaveBeenCalled();
  });

  it("revalidates and defers a discourse-dependent cached Garden assertion", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);
    const signal = createSignal({
      source: "garden_compile",
      object_kind: "activity",
      confidence: 0.9,
      raw_payload: {
        proposed_matched_text: "The former is cheaper.",
        matched_text: "The former is cheaper.",
        distilled_fact: "The former is cheaper.",
        full_turn_content: "Alice chose Berlin over Paris. The former is cheaper."
      }
    });

    expect(router.route(signal)).toMatchObject({
      kind: "deferred",
      routing_reason: expect.stringContaining("source grounding failed")
    });
    await router.materializeSignal(signal);
    expect(deps.memoryService.create).not.toHaveBeenCalled();
    expect(deps.claimService.create).not.toHaveBeenCalled();
  });

  it("keeps source-verifiable local heuristic signals compatible with durable routing", async () => {
    const [signal] = await new LocalHeuristics().compile(
      "I always use TypeScript strict mode.",
      { workspace_id: "workspace-1", run_id: "run-1", surface_id: null, turn_messages: [] }
    );
    expect(signal).toBeDefined();
    expect(new MaterializationRouter(createDeps()).route(signal!)).toMatchObject({
      route_target: "memory_and_claim_draft"
    });
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
});
