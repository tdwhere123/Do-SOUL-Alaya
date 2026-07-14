import { describe, expect, it } from "vitest";
import { MaterializationRouter } from "../../garden/materialization-router/router.js";
import { createDeps, createSignal } from "./materialization-router-fixture.js";

describe("MaterializationRouter source grounding defer metadata", () => {
  it("includes structured defer_reason and defer_class when grounding fails", () => {
    const router = new MaterializationRouter(createDeps());
    const signal = createSignal({
      source: "garden_compile",
      confidence: 0.9,
      raw_payload: {
        proposed_matched_text: "这个更好。",
        full_turn_content: "方案 A 和方案 B。这个更好。"
      }
    });

    expect(router.route(signal)).toMatchObject({
      kind: "deferred",
      defer_class: "source_grounding",
      defer_reason: "source_assertion_not_self_contained"
    });
  });

  it("propagates defer metadata through materializeDeferred", async () => {
    const deps = createDeps();
    const router = new MaterializationRouter(deps);
    const signal = createSignal({
      source: "garden_compile",
      confidence: 0.9,
      raw_payload: {
        proposed_matched_text: "那个方案。",
        full_turn_content: "先看方案 A。那个方案。"
      }
    });

    const result = await router.materializeSignal(signal);
    expect(result).toMatchObject({
      target_kind: "deferred",
      defer_class: "source_grounding",
      defer_reason: "source_assertion_not_self_contained",
      created_objects: []
    });
    expect(deps.memoryService.create).not.toHaveBeenCalled();
  });
});
