import { describe, expect, it, vi } from "vitest";
import type { PathAnchorRef } from "@do-soul/alaya-protocol";
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

  it("keys every anchor variant by canonical identity, order, and as-of", async () => {
    const findByAnchors = vi.fn<RecallServicePathExpansionPort["findByAnchors"]>(
      async () => []
    );
    const port = memoizePathFindByAnchors({ findByAnchors });
    const anchors: readonly PathAnchorRef[] = [
      { kind: "object", object_id: "object-a" },
      { kind: "object_facet", object_id: "object-b", facet_key: "facet-a" },
      { kind: "obligation", source_object_id: "object-c", obligation_digest: "obligation-a" },
      { kind: "risk_concern", source_object_id: "object-d", concern_digest: "risk-a" },
      { kind: "time_concern", source_object_id: "object-e", window_digest: "time-a" }
    ];

    await port?.findByAnchors("workspace-1", anchors, { asOf: "t0" });
    await port?.findByAnchors("workspace-1", anchors, { asOf: "t0" });
    await port?.findByAnchors("workspace-1", [...anchors].reverse(), { asOf: "t0" });
    await port?.findByAnchors("workspace-1", anchors, { asOf: "t1" });
    for (const changed of changedAnchorIdentities(anchors)) {
      await port?.findByAnchors("workspace-1", changed, { asOf: "t0" });
    }

    expect(findByAnchors).toHaveBeenCalledTimes(8);
  });
});

function changedAnchorIdentities(
  anchors: readonly PathAnchorRef[]
): readonly (readonly PathAnchorRef[])[] {
  return [
    anchors.with(0, { kind: "object", object_id: "object-z" }),
    anchors.with(1, { kind: "object_facet", object_id: "object-b", facet_key: "facet-z" }),
    anchors.with(2, {
      kind: "obligation", source_object_id: "object-c", obligation_digest: "obligation-z"
    }),
    anchors.with(3, {
      kind: "risk_concern", source_object_id: "object-d", concern_digest: "risk-z"
    }),
    anchors.with(4, {
      kind: "time_concern", source_object_id: "object-e", window_digest: "time-z"
    })
  ];
}
