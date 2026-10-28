import { describe, expect, it } from "vitest";
import { MaterializationRouter } from "@do-soul/alaya-soul";
import { CommittedObjectError } from "@do-soul/alaya-protocol";
import { createDeps, createSignal } from "./materialization-router-fixture.js";

describe("MaterializationRouter partial-failure contract", () => {
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

  it("waits for sibling evidence and reports committed objects when one create fails", async () => {
    const deps = createDeps();
    let completeSibling!: () => void;
    const sibling = new Promise<{ object_kind: string; object_id: string }>((resolve) => {
      completeSibling = () => resolve({ object_kind: "evidence_capsule", object_id: "committed-evidence" });
    });
    deps.evidenceService.create.mockRejectedValueOnce(new Error("first failed"))
      .mockImplementationOnce(async () => await sibling);
    const resultPromise = new MaterializationRouter(deps).materializeSignal(createSignal({
      signal_kind: "potential_synthesis", evidence_refs: ["msg-1", "msg-2"]
    }));
    completeSibling();
    const result = await resultPromise;
    expect(result).toMatchObject({ success: false, error: "first failed",
      created_objects: [{ object_kind: "evidence_capsule", object_id: "committed-evidence" }] });
    expect(deps.synthesisService.create).not.toHaveBeenCalled();
  });

  it("reports an evidence commit even when its notification failed", async () => {
    const deps = createDeps();
    deps.evidenceService.create.mockRejectedValueOnce(new CommittedObjectError("notification failed", {
      object_kind: "evidence_capsule", object_id: "committed-before-notify"
    }));
    const result = await new MaterializationRouter(deps).materializeSignal(createSignal({
      signal_kind: "potential_synthesis", evidence_refs: ["msg-1", "msg-2"]
    }));
    expect(result).toMatchObject({ success: false, error: "notification failed", created_objects: [
      { object_kind: "evidence_capsule", object_id: "committed-before-notify" },
      { object_kind: "evidence_capsule", object_id: "evidence-1" }
    ] });
  });
});
