import { describe, expect, it, vi } from "vitest";
import { withRecallReadSnapshot } from "@do-soul/alaya-core";
import { EVIDENCE_ID, MEMORY_ID, WORKSPACE_ID } from "./p217-planted-harness.js";
import { createQueryOnlyHydrationHarness, dispatchQueryOnly } from "./query-only-hydration-fixture.js";

const hydration = createQueryOnlyHydrationHarness();

describe("query-only dispatch snapshot recovery", () => {
  it("rolls back a rejected native read and permits the next snapshot", async () => {
    const fixture = await hydration.openHydrationFixture();
    const runtime = fixture.queryOnlyRuntime;
    const snapshot = {
      beginDeferred: async () => { await dispatchQueryOnly(runtime, "snapshot.beginDeferred", {}); },
      commit: async () => { await dispatchQueryOnly(runtime, "snapshot.commit", {}); },
      rollback: async () => { await dispatchQueryOnly(runtime, "snapshot.rollback", {}); }
    };
    const find = vi.spyOn(runtime.memoryEntryRepo, "findByEvidenceRefs")
      .mockRejectedValueOnce(new Error("query-only evidence memory load failure"));
    const read = () => dispatchQueryOnly(runtime, "memory.findByEvidenceRefs", {
      workspaceId: WORKSPACE_ID, evidenceObjectIds: [EVIDENCE_ID]
    });
    await expect(withRecallReadSnapshot(snapshot, read)).rejects.toThrow("query-only evidence memory load failure");
    expect(fixture.queryOnly.connection.inTransaction).toBe(false);
    const recovered = await withRecallReadSnapshot(snapshot, read) as readonly { readonly object_id: string }[];
    expect(recovered.map((row) => row.object_id)).toContain(MEMORY_ID);
    expect(find).toHaveBeenCalledTimes(2);
    expect(fixture.queryOnly.connection.inTransaction).toBe(false);
    expect(fixture.writer.connection.pragma("integrity_check", { simple: true })).toBe("ok");
  });
});
