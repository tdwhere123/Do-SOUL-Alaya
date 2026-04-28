import { describe, expect, it } from "vitest";
import {
  listPathAnchorRefContextRefs,
  serializePathAnchorRef
} from "../index.js";

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
