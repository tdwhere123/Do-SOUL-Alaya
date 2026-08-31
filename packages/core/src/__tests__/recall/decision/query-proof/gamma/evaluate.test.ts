import { describe, expect, it } from "vitest";
import {
  acceptQueryGammaCandidate,
  admitCompiledLowerFrontier,
  emptyQueryGammaSelectedSet,
  evaluateQueryGammaTuple
} from "../../../../../recall/decision/query-proof/gamma/evaluate.js";
import {
  argmaxQuery,
  binding,
  candidate,
  compileGamma,
  distinctQuery,
  proposition,
  scalarQuery
} from "./gamma-fixture.js";

describe("query-compiled Gamma standings and marginals", () => {
  it("gives zero repeated marginal after a covered binding, proposition, or independent atom", () => {
    const compiled = compileGamma(scalarQuery([{
      id: "rel1",
      relation: "bought",
      arguments: ["x"]
    }], [{
      id: "need-ind",
      constraint: "independent_support",
      arguments: ["x"]
    }]), [
      candidate("A", {
        bindings: [binding("alice")],
        propositions: [
          proposition("rel1"),
          proposition("need-ind", "supports", "certified_independent")
        ]
      }),
      candidate("B", {
        bindings: [binding("alice")],
        propositions: [
          proposition("rel1"),
          proposition("need-ind", "supports", "certified_independent")
        ]
      })
    ]);
    const afterA = acceptQueryGammaCandidate(
      emptyQueryGammaSelectedSet(), compiled, "A", "A", 1, "mem"
    );
    expect(evaluateQueryGammaTuple(compiled, emptyQueryGammaSelectedSet(), "A")).toEqual({
      answer_binding_position: 1,
      required_proposition_support: 1,
      certified_independent_support: 1
    });
    expect(evaluateQueryGammaTuple(compiled, afterA, "B")).toEqual({
      answer_binding_position: 0,
      required_proposition_support: 0,
      certified_independent_support: 0
    });
  });

  it("lets same-lineage candidates cover two distinct required propositions", () => {
    const compiled = compileGamma(scalarQuery([
      { id: "rel1", relation: "bought", arguments: ["x"] },
      { id: "rel2", relation: "from", arguments: ["x"] }
    ]), [
      candidate("A", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1", "supports", "correlated")]
      }),
      candidate("B", {
        bindings: [binding("alice")],
        propositions: [proposition("rel2", "supports", "correlated")]
      })
    ]);
    const afterA = acceptQueryGammaCandidate(
      emptyQueryGammaSelectedSet(), compiled, "A", "A", 1, "mem"
    );
    expect(evaluateQueryGammaTuple(compiled, afterA, "B")).toEqual({
      answer_binding_position: 0,
      required_proposition_support: 1,
      certified_independent_support: 0
    });
  });

  it("treats unknown distinctness as unresolved coverage rather than proved non-coverage", () => {
    const compiled = compileGamma(distinctQuery(), [
      candidate("A", { bindings: [binding("alice", "proved_distinct")] }),
      candidate("B", { bindings: [binding("alice", "unknown")] })
    ]);
    expect(compiled.semantic_feasibility.find((row) => row.candidate_key === "B")?.semantic)
      .toBe("unresolved");
    expect(evaluateQueryGammaTuple(compiled, emptyQueryGammaSelectedSet(), "B")).toEqual({
      answer_binding_position: 0,
      required_proposition_support: 0,
      certified_independent_support: 0
    });
  });

  it("does not count alias may-equal as proved distinct", () => {
    const compiled = compileGamma(distinctQuery(), [
      candidate("A", { bindings: [binding("alice", "proved_distinct")] }),
      candidate("B", { bindings: [binding("alice-alias", "may_equal")] })
    ]);
    expect(compiled.atoms.map((atom) => atom.target)).toEqual(["alice"]);
    expect(evaluateQueryGammaTuple(compiled, emptyQueryGammaSelectedSet(), "B"))
      .toEqual({
        answer_binding_position: 0,
        required_proposition_support: 0,
        certified_independent_support: 0
      });
  });

  it("lets unknown correlation contribute support but not independence novelty", () => {
    const compiled = compileGamma(scalarQuery([{
      id: "rel1",
      relation: "bought",
      arguments: ["x"]
    }], [{
      id: "need-ind",
      constraint: "independent_support",
      arguments: ["x"]
    }]), [
      candidate("A", {
        bindings: [binding("alice")],
        propositions: [
          proposition("rel1", "supports", "unknown"),
          proposition("need-ind", "supports", "unknown")
        ]
      })
    ]);
    expect(evaluateQueryGammaTuple(compiled, emptyQueryGammaSelectedSet(), "A")).toEqual({
      answer_binding_position: 1,
      required_proposition_support: 1,
      certified_independent_support: 0
    });
  });

  it("gives no third-stratum gain to a certified-independent extra without a matching CQ_q obligation", () => {
    const compiled = compileGamma(scalarQuery([{
      id: "rel1",
      relation: "bought",
      arguments: ["x"]
    }]), [
      candidate("A", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1")]
      }),
      candidate("B", {
        bindings: [binding("bob")],
        propositions: [proposition("rel1", "supports", "certified_independent")]
      })
    ]);
    const afterA = acceptQueryGammaCandidate(
      emptyQueryGammaSelectedSet(), compiled, "A", "A", 1, "mem"
    );
    expect(evaluateQueryGammaTuple(compiled, afterA, "B").certified_independent_support).toBe(0);
    expect(compiled.independent_support_obligation).toBe(false);
  });

  it("admits a lower-frontier candidate only for a compiled atom core is proved not to cover", () => {
    const compiled = compileGamma(scalarQuery([{
      id: "rel1",
      relation: "bought",
      arguments: ["x"]
    }, {
      id: "rel2",
      relation: "from",
      arguments: ["x"]
    }]), [
      candidate("core", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1"), proposition("rel2", "absent")]
      }),
      candidate("lower", {
        bindings: [binding("bob")],
        propositions: [proposition("rel1", "absent"), proposition("rel2")]
      }),
      candidate("unknown-core", {
        bindings: [binding("carol")],
        propositions: [proposition("rel1"), proposition("rel2", "unknown")]
      })
    ]);
    const admitted = admitCompiledLowerFrontier(
      compiled, emptyQueryGammaSelectedSet(), "lower", ["core"]
    );
    expect(admitted.admitted).toBe(true);
    expect(admitted.compiled_atom_ids).toContain("proposition:rel2");
    expect(admitCompiledLowerFrontier(
      compiled, emptyQueryGammaSelectedSet(), "lower", ["unknown-core"]
    ).admitted).toBe(false);
  });

  it("refuses to score unsupported Gamma as a zero tuple", () => {
    const compiled = compileGamma(argmaxQuery(), [candidate("A")]);
    expect(compiled.compile_status).toBe("unsupported");
    expect(() => evaluateQueryGammaTuple(compiled, emptyQueryGammaSelectedSet(), "A"))
      .toThrow(/unsupported Gamma/u);
  });

  it("keeps resource infeasibility from changing semantic standings", () => {
    const compiled = compileGamma(scalarQuery(), [
      candidate("A", { bindings: [binding("alice")], token_cost: 8 })
    ], {
      resource_policy: {
        schema_version: 1,
        reject_duplicate_object: true,
        token_budget: 3,
        per_dimension_limits: null
      }
    });
    expect(compiled.semantic_feasibility[0]?.semantic).toBe("feasible");
    expect(compiled.resource_policy.token_budget).toBe(3);
  });
});
