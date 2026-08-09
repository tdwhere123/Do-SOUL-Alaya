import { describe, expect, it } from "vitest";
import { MaterializationRouter } from "@do-soul/alaya-soul";
import { createDeps, createSignal } from "./materialization-router-fixture.js";

describe("MaterializationRouter activity recallability", () => {
  it("keeps a high-confidence activity recallable without drafting a claim", async () => {
    const dependencies = createDeps();
    const router = new MaterializationRouter(dependencies);
    const signal = createSignal({
      signal_kind: "potential_preference",
      object_kind: "activity",
      confidence: 0.9,
      raw_payload: { distilled_fact: "The operator practices piano daily." }
    });

    const target = router.route(signal);
    const result = await router.materialize(signal, target);

    expect(target.route_target).toBe("memory_entry_only");
    expect(result.created_objects.map((object) => object.object_kind)).toEqual([
      "evidence_capsule",
      "memory_entry"
    ]);
    expect(dependencies.memoryService.create).toHaveBeenCalledTimes(1);
    expect(dependencies.claimService.create).not.toHaveBeenCalled();
  });

  it("does not make a low-confidence activity durable", () => {
    const router = new MaterializationRouter(createDeps());

    const target = router.route(createSignal({
      signal_kind: "potential_preference",
      object_kind: "activity",
      confidence: 0.2
    }));

    expect(target.route_target).not.toBe("memory_entry_only");
  });

  it("forwards a grounded FactFrame proposal without changing Memory truth", async () => {
    const dependencies = createDeps();
    const router = new MaterializationRouter(dependencies);
    const assertion = "I use Atlas for research.";
    const signal = createSignal({
      source: "garden_compile",
      object_kind: "activity",
      confidence: 0.9,
      raw_payload: {
        distilled_fact: assertion,
        matched_text: assertion,
        proposed_matched_text: assertion,
        full_turn_content: assertion,
        source_assertion: assertion,
        source_grounding: {
          version: 1,
          status: "grounded",
          content_basis: "source_assertion",
          source_assertion: assertion,
          proposed_matched_text: assertion,
          reasons: []
        },
        fact_frame: {
          schema_version: 1,
          slots: [
            { role: "subject", text: "I" },
            { role: "relation", text: "use" },
            { role: "value", text: "Atlas" },
            { role: "qualifier", text: "for research" }
          ]
        }
      }
    });

    await router.materialize(signal, router.route(signal));

    expect(dependencies.evidenceService.create).toHaveBeenCalledWith(
      expect.any(Object),
      [],
      expect.objectContaining({
        producer_operator_id: "garden_source_bound_fact_frame_proposal_v1",
        source_assertion: assertion,
        fact_frame: signal.raw_payload.fact_frame
      }),
      undefined
    );
    expect(dependencies.memoryService.create).toHaveBeenCalledWith(
      expect.objectContaining({ content: assertion })
    );
  });

  it("forwards an ungrounded upstream frame for canonical rejection", async () => {
    const dependencies = createDeps();
    const router = new MaterializationRouter(dependencies);
    const assertion = "I use Atlas for research.";
    const proposedFactFrame = {
      schema_version: 1 as const,
      slots: [
        { role: "subject" as const, text: "I" },
        { role: "relation" as const, text: "use" },
        { role: "value" as const, text: "Nova" }
      ]
    };
    const signal = createSignal({
      source: "garden_compile",
      object_kind: "activity",
      confidence: 0.9,
      raw_payload: {
        distilled_fact: assertion,
        matched_text: assertion,
        full_turn_content: assertion,
        source_assertion: assertion,
        source_grounding: {
          version: 1,
          status: "grounded",
          content_basis: "source_assertion",
          source_assertion: assertion,
          proposed_matched_text: assertion,
          proposed_fact_frame: proposedFactFrame,
          reasons: ["proposed_fact_frame_not_source_grounded"]
        }
      }
    });

    await router.materialize(signal, router.route(signal));

    expect(dependencies.evidenceService.create).toHaveBeenCalledWith(
      expect.any(Object),
      [],
      expect.objectContaining({
        producer_operator_id: "garden_source_bound_fact_frame_proposal_v1",
        source_assertion: assertion,
        fact_frame: proposedFactFrame
      }),
      undefined
    );
  });
});
