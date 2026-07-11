import { describe, expect, it } from "vitest";
import {
  getPathAnchorBackingObjectId,
  listPathAnchorRefContextRefs,
  pathRelationMatchesIdentity,
  serializePathAnchorRef
} from "../../index.js";

describe("serializePathAnchorRef", () => {
  it("serializes anchors into stable ordered tuples", () => {
    expect(
      serializePathAnchorRef({
        kind: "object_facet",
        object_id: "object-1",
        facet_key: "status"
      })
    ).toBe(JSON.stringify(["object_facet", "object-1", "status"]));

    expect(
      serializePathAnchorRef({
        kind: "obligation",
        source_object_id: "object-2",
        obligation_digest: "must_run_tests"
      })
    ).toBe(JSON.stringify(["obligation", "object-2", "must_run_tests"]));
  });
});

describe("listPathAnchorRefContextRefs", () => {
  it("includes the canonical serialized anchor key alongside overlap-friendly refs", () => {
    expect(
      listPathAnchorRefContextRefs({
        kind: "risk_concern",
        source_object_id: "object-3",
        concern_digest: "credential_leak"
      })
    ).toEqual([
      JSON.stringify(["risk_concern", "object-3", "credential_leak"]),
      "object-3",
      "credential_leak",
      "object-3:credential_leak",
      "risk_concern:object-3:credential_leak"
    ]);
  });
});

describe("getPathAnchorBackingObjectId", () => {
  it("extracts the memory object id from object-bearing anchor variants", () => {
    expect(
      getPathAnchorBackingObjectId({
        kind: "object_facet",
        object_id: "object-1",
        facet_key: "status"
      })
    ).toBe("object-1");

    expect(
      getPathAnchorBackingObjectId({
        kind: "time_concern",
        source_object_id: "object-2",
        window_digest: "next_week"
      })
    ).toBe("object-2");
  });
});

describe("pathRelationMatchesIdentity", () => {
  function relation(relationKind: string, recallBias: number) {
    return {
      anchors: {
        source_anchor: { kind: "object" as const, object_id: "object-1" },
        target_anchor: { kind: "object" as const, object_id: "object-2" }
      },
      constitution: {
        relation_kind: relationKind
      },
      effect_vector: {
        recall_bias: recallBias
      }
    };
  }

  it("does not collapse different positive recalls-tier relation kinds", () => {
    expect(
      pathRelationMatchesIdentity(relation("shares_entity", 0.5), {
        sourceAnchor: { kind: "object" as const, object_id: "object-2" },
        targetAnchor: { kind: "object" as const, object_id: "object-1" },
        relationKind: "co_recalled",
        recallBias: 0.5
      })
    ).toBe(false);
  });

  it("deduplicates reversed anchors for exact bidirectional relation kinds", () => {
    for (const relationKind of ["answers_with", "coheres_with", "co_recalled"]) {
      expect(
        pathRelationMatchesIdentity(relation(relationKind, 0.5), {
          sourceAnchor: { kind: "object" as const, object_id: "object-2" },
          targetAnchor: { kind: "object" as const, object_id: "object-1" },
          relationKind,
          recallBias: 0.5
        })
      ).toBe(true);
    }
  });

  it("keeps directional relation identities ordered", () => {
    expect(
      pathRelationMatchesIdentity(relation("supports", 0.5), {
        sourceAnchor: { kind: "object" as const, object_id: "object-2" },
        targetAnchor: { kind: "object" as const, object_id: "object-1" },
        relationKind: "supports",
        recallBias: 0.5
      })
    ).toBe(false);
  });

  it("keeps distinct typed conditions on the same backing object separate", () => {
    const existing = {
      anchors: {
        source_anchor: {
          kind: "object_facet" as const,
          object_id: "object-1",
          facet_key: "status"
        },
        target_anchor: {
          kind: "time_concern" as const,
          source_object_id: "object-2",
          window_digest: "next_week"
        }
      },
      constitution: { relation_kind: "supports" },
      effect_vector: { recall_bias: 0.5 }
    };

    expect(
      pathRelationMatchesIdentity(existing, {
        sourceAnchor: {
          kind: "object_facet",
          object_id: "object-1",
          facet_key: "priority"
        },
        targetAnchor: {
          kind: "time_concern",
          source_object_id: "object-2",
          window_digest: "next_week"
        },
        relationKind: "supports",
        recallBias: 0.5
      })
    ).toBe(false);
    expect(
      pathRelationMatchesIdentity(existing, {
        sourceAnchor: existing.anchors.source_anchor,
        targetAnchor: {
          kind: "time_concern",
          source_object_id: "object-2",
          window_digest: "next_month"
        },
        relationKind: "supports",
        recallBias: 0.5
      })
    ).toBe(false);
  });

  it("reverse-deduplicates unordered relations only for exact full anchors", () => {
    const existing = {
      anchors: {
        source_anchor: {
          kind: "object_facet" as const,
          object_id: "object-1",
          facet_key: "status"
        },
        target_anchor: {
          kind: "time_concern" as const,
          source_object_id: "object-2",
          window_digest: "next_week"
        }
      },
      constitution: { relation_kind: "coheres_with" },
      effect_vector: { recall_bias: 0.5 }
    };

    expect(
      pathRelationMatchesIdentity(existing, {
        sourceAnchor: existing.anchors.target_anchor,
        targetAnchor: existing.anchors.source_anchor,
        relationKind: "coheres_with",
        recallBias: 0.5
      })
    ).toBe(true);
    expect(
      pathRelationMatchesIdentity(existing, {
        sourceAnchor: {
          kind: "time_concern",
          source_object_id: "object-2",
          window_digest: "next_month"
        },
        targetAnchor: existing.anchors.source_anchor,
        relationKind: "coheres_with",
        recallBias: 0.5
      })
    ).toBe(false);
  });

  it("does not let positive recalls-tier paths satisfy negative or different-kind identities", () => {
    const existing = relation("co_recalled", 0.5);

    expect(
      pathRelationMatchesIdentity(existing, {
        sourceAnchor: { kind: "object" as const, object_id: "object-1" },
        targetAnchor: { kind: "object" as const, object_id: "object-2" },
        relationKind: "contradicts",
        recallBias: -0.5
      })
    ).toBe(false);

    expect(
      pathRelationMatchesIdentity(existing, {
        sourceAnchor: { kind: "object" as const, object_id: "object-1" },
        targetAnchor: { kind: "object" as const, object_id: "object-2" },
        relationKind: "supports",
        recallBias: 0.5
      })
    ).toBe(false);
  });
});
