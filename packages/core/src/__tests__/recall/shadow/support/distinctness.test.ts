import { describe, expect, it } from "vitest";
import {
  createSupportHypergraph,
  digestSupportHypergraph,
  provedDistinctBindingCount
} from "../../../../recall/shadow/support/index.js";
import { alias, QUERY, SNAPSHOT } from "./fixtures.js";

describe("support binding distinctness", () => {
  it("leaves may_equal aliases unknown and non-certifying", () => {
    const receipt = createSupportHypergraph({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      nodes: [
        { kind: "answer_binding", id: "bind.alice" },
        { kind: "answer_binding", id: "bind.alice-aka" }
      ],
      aliases: [alias("bind.alice", "bind.alice-aka", "may_equal")]
    });
    expect(provedDistinctBindingCount(receipt)).toEqual({
      status: "unknown",
      reason: "incomplete_pairwise_distinctness"
    });
  });

  it("leaves an unreceipted distinct claim unknown and non-certifying", () => {
    const receipt = digestSupportHypergraph({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      nodes: [
        { kind: "answer_binding", id: "bind.alice" },
        { kind: "answer_binding", id: "bind.carol" }
      ],
      edges: [],
      aliases: [{
        left_id: "bind.alice",
        right_id: "bind.carol",
        state: "distinct"
      }],
      correlations: []
    });
    expect(provedDistinctBindingCount(receipt)).toEqual({
      status: "unknown",
      reason: "incomplete_pairwise_distinctness"
    });
  });

  it("refuses to count conflict aliases as proved distinct", () => {
    const receipt = createSupportHypergraph({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      nodes: [
        { kind: "answer_binding", id: "bind.alice" },
        { kind: "answer_binding", id: "bind.alice-aka" }
      ],
      aliases: [
        alias("bind.alice", "bind.alice-aka", "equal"),
        alias("bind.alice", "bind.alice-aka", "distinct")
      ]
    });
    expect(receipt.aliases[0]?.state).toBe("conflict");
    expect(() => provedDistinctBindingCount(receipt)).toThrow(/conflict/u);
  });

  it("does not mint distinctness from an incomplete pairwise graph", () => {
    const receipt = createSupportHypergraph({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      nodes: [
        { kind: "answer_binding", id: "bind.alice" },
        { kind: "answer_binding", id: "bind.alice-aka" },
        { kind: "answer_binding", id: "bind.carol" }
      ],
      aliases: [alias("bind.alice", "bind.alice-aka", "equal")]
    });
    expect(provedDistinctBindingCount(receipt)).toEqual({
      status: "unknown",
      reason: "incomplete_pairwise_distinctness"
    });
  });

  it("counts equality groups only when every group pair has distinctness evidence", () => {
    const receipt = createSupportHypergraph({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      nodes: [
        { kind: "answer_binding", id: "bind.alice" },
        { kind: "answer_binding", id: "bind.alice-aka" },
        { kind: "answer_binding", id: "bind.carol" }
      ],
      aliases: [
        alias("bind.alice", "bind.alice-aka", "equal"),
        alias("bind.alice", "bind.carol", "distinct")
      ]
    });
    expect(provedDistinctBindingCount(receipt)).toEqual({
      status: "proved_distinct",
      count: 2
    });
  });
});
