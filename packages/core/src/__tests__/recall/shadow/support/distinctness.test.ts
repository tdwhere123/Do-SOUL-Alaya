import { describe, expect, it } from "vitest";
import {
  createSupportHypergraph,
  provedDistinctBindingCount
} from "../../../../recall/shadow/support/index.js";
import { alias, QUERY, SNAPSHOT } from "./fixtures.js";

describe("support binding distinctness", () => {
  it("refuses to count may_equal aliases as proved distinct", () => {
    const receipt = createSupportHypergraph({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      nodes: [
        { kind: "answer_binding", id: "bind.alice" },
        { kind: "answer_binding", id: "bind.alice-aka" }
      ],
      aliases: [alias("bind.alice", "bind.alice-aka", "may_equal")]
    });
    expect(() => provedDistinctBindingCount(receipt)).toThrow(/may_equal/u);
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

  it("counts equal aliases as one binding after an equivalence receipt", () => {
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
      status: "proved_distinct",
      count: 2
    });
  });
});
