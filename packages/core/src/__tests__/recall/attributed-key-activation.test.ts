import { describe, expect, it } from "vitest";

import {
  computeAttributedKeyActivationV1
} from "../../recall/flood/attributed-key-activation.js";
import {
  createSelectedSliceKeyV2,
  type SelectedSliceKeyV2
} from "../../recall/flood/slice-key-contract.js";

describe("attributed key activation", () => {
  it("is invariant to correlated alias density", () => {
    const query = [key("query", "entity", "ada", "query-source", 0.9)];
    const candidate = [key("candidate", "entity", "ada", "source-1", 0.8)];
    const aliases = Array.from({ length: 20 }, (_, index) =>
      key("candidate", "entity", "ada", "source-1", 0.8, `alias-${index}`)
    );

    const sparse = computeAttributedKeyActivationV1(query, candidate);
    const dense = computeAttributedKeyActivationV1(query, [...candidate, ...aliases]);

    expect(sparse.proposal_activation).toBeCloseTo(0.72);
    expect(dense.proposal_activation).toBe(sparse.proposal_activation);
    expect(dense.independent_source_count).toBe(1);
    expect(dense.receipts).toHaveLength(1);
  });

  it("keeps independent support separate from proposal activation", () => {
    const query = [key("query", "entity", "ada", "query-source", 1)];
    const candidate = [
      key("candidate", "entity", "ada", "source-1", 0.8),
      key("candidate", "entity", "ada", "source-2", 0.6)
    ];
    const activation = computeAttributedKeyActivationV1(query, candidate);

    expect(activation.proposal_activation).toBe(0.8);
    expect(activation.independent_support).toBeCloseTo(0.92);
    expect(activation.independent_source_count).toBe(2);
  });
});

function key(
  owner: "query" | "candidate",
  dimension: string,
  value: string,
  independenceGroup: string,
  reliability: number,
  suffix = "base"
): SelectedSliceKeyV2 {
  const query = owner === "query";
  return createSelectedSliceKeyV2({
    workspace_id: "workspace-1",
    owner_id: query ? null : "memory-1",
    dimension,
    value,
    authority: query ? "derived_query" : "proposed_routing_only",
    reliability,
    independence_group: independenceGroup,
    provenance: {
      kind: query ? "query_probe" : "signal_entity",
      source_ref: `${owner}:${suffix}`
    },
    source_version: "v1",
    freshness: { state: "fresh", as_of_ms: 1_773_811_200_000 }
  });
}
