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
});
