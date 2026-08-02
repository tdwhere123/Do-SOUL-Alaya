import { describe, expect, it } from "vitest";

import {
  createSelectedSliceKeyV2,
  normalizeSelectedSliceKeysV2
} from "../../recall/flood/slice-key-contract.js";
import { selectSliceCompatibilityV2 } from "../../recall/flood/slice-key-selector.js";

describe("slice-key selector freshness", () => {
  it("does not turn a tied fresh/stale endpoint duplicate into pass-through", () => {
    const sourceKeys = normalizeSelectedSliceKeysV2([
      endpointInput("fresh"),
      endpointInput("stale")
    ]);

    expect(selectSliceCompatibilityV2({
      queryKeys: [key("query_probe")],
      sourceKeys,
      targetKeys: [key("object_anchor")]
    }).reason).toBe("slice_match");
  });
});

function endpointInput(state: "fresh" | "stale") {
  return {
    workspace_id: "workspace-a",
    owner_id: "memory-1",
    dimension: "entity",
    value: "ada lovelace",
    authority: "grounded" as const,
    reliability: 1,
    independence_group: "memory:memory-1",
    provenance: { kind: "canonical_entity" as const, source_ref: "canonical_entity:ada" },
    source_version: "v1",
    freshness: { state, as_of_ms: 1_720_000_000_000 }
  };
}

function key(provenance: "query_probe" | "object_anchor") {
  const query = provenance === "query_probe";
  return createSelectedSliceKeyV2({
    workspace_id: "workspace-a",
    owner_id: query ? null : "memory-2",
    dimension: "entity",
    value: "ada lovelace",
    authority: query ? "derived_query" : "grounded",
    reliability: 1,
    independence_group: query ? "query:workspace-a" : "memory:memory-2",
    provenance: { kind: provenance, source_ref: `${provenance}:ada` },
    source_version: "v1",
    freshness: { state: "fresh", as_of_ms: 1_720_000_000_000 }
  });
}
