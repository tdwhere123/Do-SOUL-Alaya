import { describe, expect, it } from "vitest";
import type { MaterializationResult } from "@do-soul/alaya-soul";
import { MaterializationRouter } from "@do-soul/alaya-soul";
import { createDeps, createSignal } from "./materialization-router-fixture.js";

function readFailureError(result: MaterializationResult): string {
  if (result.success) {
    throw new Error("expected materialization failure");
  }
  return result.error;
}

describe("MaterializationRouter partial-failure contract", () => {
  it("narrows failures to a required error string", async () => {
    const deps = createDeps();
    deps.memoryService.create.mockRejectedValueOnce(new Error("memory create failed"));
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(createSignal());
    expect(readFailureError(result)).toBe("memory create failed");
  });

  it("returns success:false with partial created_objects when claim creation fails after memory", async () => {
    const deps = createDeps();
    deps.claimService.create.mockRejectedValueOnce(new Error("claim create failed"));
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(createSignal());

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected materialization failure");
    }
    expect(result.error).toBe("claim create failed");
    expect(result.created_objects).toEqual([
      { object_kind: "evidence_capsule", object_id: "evidence-1" },
      { object_kind: "memory_entry", object_id: "memory-1" }
    ]);
    expect(deps.claimService.create).toHaveBeenCalledTimes(1);
  });

  it("returns success:false with partial evidence objects when synthesis creation fails", async () => {
    const deps = createDeps();
    deps.synthesisService.create.mockRejectedValueOnce(new Error("synthesis create failed"));
    const router = new MaterializationRouter(deps);

    const result = await router.materializeSignal(
      createSignal({
        signal_kind: "potential_synthesis",
        evidence_refs: ["msg-1", "msg-2"]
      })
    );

    expect(result.success).toBe(false);
    if (result.success) {
      throw new Error("expected materialization failure");
    }
    expect(result.error).toBe("synthesis create failed");
    expect(result.created_objects).toEqual([
      { object_kind: "evidence_capsule", object_id: "evidence-1" },
      { object_kind: "evidence_capsule", object_id: "evidence-2" }
    ]);
    expect(deps.synthesisService.create).toHaveBeenCalledTimes(1);
  });
});
