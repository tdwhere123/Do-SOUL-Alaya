import { describe, expect, it, vi } from "vitest";
import { withRecallReadSnapshot } from "@do-soul/alaya-core";
import { WORKSPACE_ID } from "./source-field-harness.js";
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
    const find = vi.spyOn(runtime.recallPathReadPorts, "findActiveByWorkspace")
      .mockRejectedValueOnce(new Error("query-only path load failure"));
    const read = () => dispatchQueryOnly(runtime, "constraints.findActive", {
      workspaceId: WORKSPACE_ID
    });
    await expect(withRecallReadSnapshot(snapshot, read)).rejects.toThrow("query-only path load failure");
    expect(fixture.queryOnly.connection.inTransaction).toBe(false);
    const recovered = await withRecallReadSnapshot(snapshot, read) as Readonly<{
      readonly constraints: readonly unknown[];
      readonly total_count: number;
    }>;
    expect(recovered.total_count).toBeGreaterThanOrEqual(0);
    expect(Array.isArray(recovered.constraints)).toBe(true);
    expect(find).toHaveBeenCalledTimes(2);
    expect(fixture.queryOnly.connection.inTransaction).toBe(false);
    expect(fixture.writer.connection.pragma("integrity_check", { simple: true })).toBe("ok");
  });
});
