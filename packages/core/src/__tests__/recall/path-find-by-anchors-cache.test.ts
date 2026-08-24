import { describe, expect, it, vi } from "vitest";
import { memoizePathFindByAnchors } from
  "../../recall/expansion/path-find-by-anchors-cache.js";
import type { RecallServicePathExpansionPort } from
  "../../recall/runtime/recall-service-ports.js";
import { createPathRelation } from "./recall-service-test-fixtures.js";

describe("path findByAnchors request cache", () => {
  it("reuses the first result for the same workspace, as-of, and anchor sequence", async () => {
    const path = createPathRelation({ sourceId: "seed-a", targetId: "neighbor-a" });
    const findByAnchors = vi.fn<RecallServicePathExpansionPort["findByAnchors"]>(
      async () => [path]
    );
    const port = memoizePathFindByAnchors({ findByAnchors });
    const anchors = [
      { kind: "object" as const, object_id: "seed-a" },
      { kind: "object" as const, object_id: "seed-b" }
    ];

    const first = await port?.findByAnchors("workspace-1", anchors, { asOf: "t0" });
    const second = await port?.findByAnchors("workspace-1", anchors, { asOf: "t0" });

    expect(first).toEqual([path]);
    expect(second).toBe(first);
    expect(findByAnchors).toHaveBeenCalledTimes(1);
  });

  it("does not reuse a lookup when the anchor sequence differs", async () => {
    const findByAnchors = vi.fn<RecallServicePathExpansionPort["findByAnchors"]>(
      async () => []
    );
    const port = memoizePathFindByAnchors({ findByAnchors });

    await port?.findByAnchors("workspace-1", [{ kind: "object", object_id: "a" }]);
    await port?.findByAnchors("workspace-1", [{ kind: "object", object_id: "b" }]);

    expect(findByAnchors).toHaveBeenCalledTimes(2);
  });
});
