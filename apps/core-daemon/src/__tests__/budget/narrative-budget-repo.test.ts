import { describe, expect, it, vi } from "vitest";
import { createNarrativeBudgetRepo } from "../../budget/narrative-budget-repo.js";

function makeNarrativeDigest(overrides?: Partial<{
  readonly digest_id: string;
  readonly run_id: string;
}>): Readonly<Record<string, unknown>> {
  return Object.freeze({
    digest_id: overrides?.digest_id ?? "digest-1",
    derived_from_workers: ["worker-1"],
    source_trust_tags: ["trusted"],
    bound_to: { run_id: overrides?.run_id ?? "run-1" },
    created_at: "2026-04-20T10:00:00.000Z",
    expires_at: "2026-04-21T10:00:00.000Z",
    retention_after_expiry: "audit_only"
  });
}

describe("createNarrativeBudgetRepo", () => {
  it("reuses one queryByRunAll call for concurrent count/bytes checks and aggregates in one pass", async () => {
    const digestA = makeNarrativeDigest({ digest_id: "digest-a" });
    const digestB = makeNarrativeDigest({ digest_id: "digest-b" });
    const queryByRunAll = vi.fn(async () => [
      { payload_json: digestA },
      { payload_json: { unexpected: "shape" } },
      { payload_json: digestB }
    ]);
    const repo = createNarrativeBudgetRepo({
      eventLogRepo: { queryByRunAll }
    });

    const [count, totalBytes] = await Promise.all([
      repo.countDigestsByRun("run-1"),
      repo.totalDigestBytesByRun("run-1")
    ]);

    expect(count).toBe(2);
    expect(totalBytes).toBe(
      Buffer.byteLength(JSON.stringify(digestA), "utf8") +
        Buffer.byteLength(JSON.stringify(digestB), "utf8")
    );
    expect(queryByRunAll).toHaveBeenCalledTimes(1);
    expect(queryByRunAll).toHaveBeenCalledWith("run-1");
  });

  it("reuses the same aggregate for sequential count/bytes reads in one call cycle", async () => {
    const digest = makeNarrativeDigest({ digest_id: "digest-sequential" });
    const queryByRunAll = vi.fn(async () => [{ payload_json: digest }]);
    const repo = createNarrativeBudgetRepo({
      eventLogRepo: { queryByRunAll }
    });

    const count = await repo.countDigestsByRun("run-1");
    const totalBytes = await repo.totalDigestBytesByRun("run-1");

    expect(count).toBe(1);
    expect(totalBytes).toBe(Buffer.byteLength(JSON.stringify(digest), "utf8"));
    expect(queryByRunAll).toHaveBeenCalledTimes(1);
  });
});
