import { describe, expect, it } from "vitest";
import {
  CORRELATION_CONFLICT_REASON,
  createSupportHypergraph,
  SUPPORT_HYPERGRAPH_OPERATOR_ID
} from "../../../../../recall/decision/query-proof/support/index.js";
import { alias, correlation, QUERY, SNAPSHOT } from "./fixtures.js";

const CAND_A = "workspace_local:memory_entry:cand-a";
const CAND_B = "workspace_local:memory_entry:cand-b";

describe("support hypergraph contract", () => {
  it("allows one candidate with multiple bindings and multiple candidates with one binding", () => {
    const manyBindings = createSupportHypergraph({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      nodes: [
        { kind: "candidate_projection", id: CAND_A },
        { kind: "answer_binding", id: "bind.alice" },
        { kind: "answer_binding", id: "bind.bob" }
      ],
      edges: [
        expresses(CAND_A, "bind.alice"),
        expresses(CAND_A, "bind.bob")
      ]
    });
    expect(edgeKinds(manyBindings, "expresses")).toBe(2);

    const manyCandidates = createSupportHypergraph({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      nodes: [
        { kind: "candidate_projection", id: CAND_A },
        { kind: "candidate_projection", id: CAND_B },
        { kind: "answer_binding", id: "bind.alice" }
      ],
      edges: [
        expresses(CAND_A, "bind.alice"),
        expresses(CAND_B, "bind.alice")
      ]
    });
    expect(edgeKinds(manyCandidates, "expresses")).toBe(2);
    expect(manyCandidates.nodes.filter((node) => node.kind === "answer_binding")).toHaveLength(1);
  });

  it("allows one proposition with multiple evidence groups", () => {
    const receipt = createSupportHypergraph({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      nodes: [
        { kind: "proposition", id: "prop.works-at" },
        { kind: "evidence_unit", id: "eu-1" },
        { kind: "evidence_unit", id: "eu-2" },
        { kind: "source_lineage", id: "lineage-a" },
        { kind: "source_lineage", id: "lineage-b" }
      ],
      edges: [
        { kind: "grounds", from: eu("eu-1"), to: prop("prop.works-at") },
        { kind: "grounds", from: eu("eu-2"), to: prop("prop.works-at") },
        { kind: "supports", from: eu("eu-1"), to: prop("prop.works-at") },
        { kind: "refutes", from: eu("eu-2"), to: prop("prop.works-at") },
        { kind: "sourced_from", from: eu("eu-1"), to: lineage("lineage-a") },
        { kind: "sourced_from", from: eu("eu-2"), to: lineage("lineage-b") }
      ]
    });
    expect(edgeKinds(receipt, "grounds")).toBe(2);
    expect(edgeKinds(receipt, "supports")).toBe(1);
    expect(edgeKinds(receipt, "refutes")).toBe(1);
  });

  it("keeps binding identity stable when candidate keys change without an equivalence receipt", () => {
    const first = graphWithBinding(CAND_A, "bind.alice");
    const second = graphWithBinding(CAND_B, "bind.alice");
    const bindingOf = (receipt: typeof first) =>
      receipt.nodes.filter((node) => node.kind === "answer_binding").map((node) => node.id);
    expect(bindingOf(first)).toEqual(bindingOf(second));
    expect(first.digest).not.toBe(second.digest);
  });

  it("collapses duplicate nodes and edges and yields a stable digest", () => {
    const once = fullGraph();
    const twice = createSupportHypergraph({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      nodes: [...fullNodes(), ...fullNodes()],
      edges: [...fullEdges(), ...fullEdges()],
      aliases: [alias("bind.alice", "bind.alice-aka", "may_equal")],
      correlations: [correlation("eu-1", "eu-2", "possibly_correlated")]
    });
    expect(twice.nodes).toEqual(once.nodes);
    expect(twice.edges).toEqual(once.edges);
    expect(twice.digest).toBe(once.digest);
    expect(twice.operator_id).toBe(SUPPORT_HYPERGRAPH_OPERATOR_ID);
    expect(Object.isFrozen(twice)).toBe(true);
    expect(Object.isFrozen(twice.nodes)).toBe(true);
  });

  it("does not mint independent evidence from content multiplicity", () => {
    const receipt = createSupportHypergraph({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      nodes: [
        { kind: "evidence_unit", id: "eu-same" },
        { kind: "evidence_unit", id: "eu-same" },
        { kind: "proposition", id: "prop.works-at" }
      ],
      edges: [
        { kind: "grounds", from: eu("eu-same"), to: prop("prop.works-at") },
        { kind: "grounds", from: eu("eu-same"), to: prop("prop.works-at") }
      ]
    });
    expect(receipt.nodes.filter((node) => node.kind === "evidence_unit")).toHaveLength(1);
    expect(edgeKinds(receipt, "grounds")).toBe(1);
  });

  it("keeps correlation without a snapshot-lease producer unknown instead of exact", () => {
    const receipt = createSupportHypergraph({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      nodes: [
        { kind: "evidence_unit", id: "eu-1" },
        { kind: "evidence_unit", id: "eu-2" }
      ],
      edges: [{ kind: "correlated", from: eu("eu-2"), to: eu("eu-1") }]
    });
    expect(receipt.correlations).toEqual([]);
    expect(receipt.correlations.some((row) => row.state === "possibly_correlated")).toBe(false);
  });

  it("does not mint exact correlation without a producer witness and rejects independent/same-unit clash", () => {
    const receipt = createSupportHypergraph({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      nodes: [
        { kind: "evidence_unit", id: "eu-1" },
        { kind: "evidence_unit", id: "eu-2" }
      ],
      edges: [{ kind: "correlated", from: eu("eu-2"), to: eu("eu-1") }]
    });
    expect(receipt.correlations).toEqual([]);
    expect(receipt.edges.filter((edge) => edge.kind === "correlated")).toHaveLength(1);
    expect(() => createSupportHypergraph({
      query_id: QUERY,
      snapshot_digest: SNAPSHOT,
      nodes: [
        { kind: "evidence_unit", id: "eu-1" },
        { kind: "evidence_unit", id: "eu-2" }
      ],
      edges: [{ kind: "correlated", from: eu("eu-1"), to: eu("eu-2") }],
      correlations: [
        correlation("eu-1", "eu-2", "certified_independent"),
        correlation("eu-1", "eu-2", "same_evidence_unit")
      ]
    })).toThrow(CORRELATION_CONFLICT_REASON);
  });

  it("records alias equal/distinct meet as conflict instead of throwing", () => {
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
    expect(receipt.aliases).toEqual([
      { left_id: "bind.alice", right_id: "bind.alice-aka", state: "conflict" }
    ]);
  });
});

function graphWithBinding(candidate: string, binding: string) {
  return createSupportHypergraph({
    query_id: QUERY,
    snapshot_digest: SNAPSHOT,
    nodes: [
      { kind: "candidate_projection", id: candidate },
      { kind: "answer_binding", id: binding }
    ],
    edges: [expresses(candidate, binding)]
  });
}

function fullGraph() {
  return createSupportHypergraph({
    query_id: QUERY,
    snapshot_digest: SNAPSHOT,
    nodes: fullNodes(),
    edges: fullEdges(),
    aliases: [alias("bind.alice", "bind.alice-aka", "may_equal")],
    correlations: [correlation("eu-1", "eu-2", "possibly_correlated")]
  });
}

function fullNodes() {
  return [
    { kind: "candidate_projection" as const, id: CAND_A },
    { kind: "answer_binding" as const, id: "bind.alice" },
    { kind: "answer_binding" as const, id: "bind.alice-aka" },
    { kind: "proposition" as const, id: "prop.works-at" },
    { kind: "evidence_unit" as const, id: "eu-1" },
    { kind: "evidence_unit" as const, id: "eu-2" }
  ];
}

function fullEdges() {
  return [
    expresses(CAND_A, "bind.alice"),
    { kind: "yields" as const, from: bind("bind.alice"), to: prop("prop.works-at") },
    { kind: "grounds" as const, from: eu("eu-1"), to: prop("prop.works-at") },
    { kind: "correlated" as const, from: eu("eu-1"), to: eu("eu-2") }
  ];
}

function expresses(candidate: string, binding: string) {
  return {
    kind: "expresses" as const,
    from: { kind: "candidate_projection" as const, id: candidate },
    to: bind(binding)
  };
}

function bind(id: string) {
  return { kind: "answer_binding" as const, id };
}

function prop(id: string) {
  return { kind: "proposition" as const, id };
}

function eu(id: string) {
  return { kind: "evidence_unit" as const, id };
}

function lineage(id: string) {
  return { kind: "source_lineage" as const, id };
}

function edgeKinds(
  receipt: ReturnType<typeof createSupportHypergraph>,
  kind: string
): number {
  return receipt.edges.filter((edge) => edge.kind === kind).length;
}
