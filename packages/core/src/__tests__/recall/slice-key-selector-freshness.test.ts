import { describe, expect, it } from "vitest";

import {
  createSelectedSliceKeyV1,
  normalizeSelectedSliceKeysV1
} from "../../recall/flood/slice-key-contract.js";
import { selectSliceCompatibilityV1 } from "../../recall/flood/slice-key-selector.js";

describe("slice-key selector freshness", () => {
  it("does not turn a tied fresh/stale endpoint duplicate into pass-through", () => {
    const sourceKeys = normalizeSelectedSliceKeysV1([
      endpointInput("fresh"),
      endpointInput("stale")
    ]);

    expect(selectSliceCompatibilityV1({
      queryKeys: [key("query_probe")],
      sourceKeys,
      targetKeys: [key("object_anchor")]
    }).reason).toBe("slice_match");
  });
});

function endpointInput(state: "fresh" | "stale") {
  return {
    workspace_id: "workspace-a",
    dimension: "entity",
    value: "ada lovelace",
    provenance: { kind: "canonical_entity" as const, source_ref: "canonical_entity:ada" },
    source_version: "v1",
    freshness: { state, as_of_ms: 1_720_000_000_000 }
  };
}

function key(provenance: "query_probe" | "object_anchor") {
  return createSelectedSliceKeyV1({
    workspace_id: "workspace-a",
    dimension: "entity",
    value: "ada lovelace",
    provenance: { kind: provenance, source_ref: `${provenance}:ada` },
    source_version: "v1",
    freshness: { state: "fresh", as_of_ms: 1_720_000_000_000 }
  });
}
