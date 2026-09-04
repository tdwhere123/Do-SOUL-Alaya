import { describe, expect, it } from "vitest";
import { ShadowContractError } from
  "../../../../../recall/decision/contract-primitives.js";
import { compileQueryGamma } from
  "../../../../../recall/decision/query-proof/gamma/compile.js";
import {
  FORBIDDEN_GAMMA_EVIDENCE_KEYS
} from "../../../../../recall/decision/query-proof/gamma/contract.js";
import {
  emptyQueryGammaSelectedSet,
  evaluateQueryGammaTuple
} from "../../../../../recall/decision/query-proof/gamma/evaluate.js";
import {
  binding,
  candidate,
  compilationFor,
  compileGamma,
  PLANTED_OSF_SOURCE,
  distinctQuery,
  findGammaAtom,
  proposition,
  scalarQuery,
  sequenceQuery,
  supportedQuery
} from "./gamma-fixture.js";

describe("query-compiled Gamma planted leakage", () => {
  it("rejects facility, Values_v, content-id, source-id, and prior injection on evidence", () => {
    for (const key of [
      "facility", "Values_v", "content_id", "cid", "source_id", "fused_score",
      "frontier_index", "prior", "gold", "weight", "match_strength", "benchmark",
      "independent_evidence", "relation_bonus", "diversity", "local_swap",
      "forest_repair", "propagation"
    ]) {
      expect(() => compileQueryGamma({
        compilation: compilationFor(scalarQuery()),
        candidates: [{
          ...candidate("A", { bindings: [binding("alice")] }),
          [key]: 1
        } as never]
      })).toThrow(ShadowContractError);
    }
    expect(FORBIDDEN_GAMMA_EVIDENCE_KEYS).toContain("independent_evidence");
  });

  it("rejects pointwise strength, frontier, and benchmark labels on the compile input", () => {
    expect(() => compileQueryGamma({
      compilation: compilationFor(scalarQuery()),
      candidates: [candidate("A")],
      fused_score: 0.9
    } as never)).toThrow(/fused_score/u);
    expect(() => compileQueryGamma({
      compilation: compilationFor(scalarQuery()),
      candidates: [candidate("A")],
      FrontierPriority: 1
    } as never)).toThrow(/FrontierPriority/u);
    expect(() => compileQueryGamma({
      compilation: compilationFor(scalarQuery()),
      candidates: [candidate("A")],
      relation_bonus: 1
    } as never)).toThrow(/unknown fields/u);
    expect(() => compileQueryGamma({
      compilation: compilationFor(scalarQuery()),
      candidates: [candidate("A")],
      diversity: 1
    } as never)).toThrow(/unknown fields/u);
    expect(() => compileQueryGamma({
      compilation: compilationFor(scalarQuery()),
      candidates: [candidate("A")],
      local_swap: 1
    } as never)).toThrow(/unknown fields/u);
  });

  it("does not let unresolved semantic feasibility enter the certified candidate set", () => {
    const compiled = compileGamma(scalarQuery(), [
      candidate("open", { bindings_status: "unknown" }),
      candidate("ok", { bindings: [binding("alice")] })
    ]);
    const certified = compiled.semantic_feasibility
      .filter((row) => row.semantic === "feasible")
      .map((row) => row.candidate_key);
    expect(certified).toEqual(["ok"]);
    expect(compiled.semantic_feasibility.find((row) => row.candidate_key === "open")?.semantic)
      .toBe("unresolved");
  });

  it("keeps unknown correlation in the certified semantic set", () => {
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
          proposition("need-ind", "supports", "unknown", "constraint")
        ]
      })
    ]);
    const certified = compiled.semantic_feasibility
      .filter((row) => row.semantic === "feasible")
      .map((row) => row.candidate_key);
    expect(certified).toEqual(["A"]);
    expect(evaluateQueryGammaTuple(compiled, emptyQueryGammaSelectedSet(), "A")
      .certified_independent_support).toBe(0);
  });

  it("does not treat a scalar binding-target collision as a proposition refute", () => {
    const compiled = compileGamma(scalarQuery(), [
      candidate("A", {
        bindings: [binding("alice")],
        propositions: [proposition("x", "refutes")]
      })
    ]);
    const scalar = findGammaAtom(compiled, { kind: "scalar_binding", target: "x" });
    expect(compiled.atoms).toEqual([
      expect.objectContaining({
        atom_id: scalar.atom_id,
        kind: "scalar_binding",
        target: "x"
      })
    ]);
    expect(compiled.standings.find((row) =>
      row.candidate_key === "A" && row.atom_id === scalar.atom_id)?.coverage)
      .toBe("covers");
    expect(compiled.semantic_feasibility).toEqual([
      { candidate_key: "A", semantic: "feasible" }
    ]);
  });

  it("fails closed on Proxy compile premises instead of a second live read", () => {
    const covering = candidate("A", { bindings: [binding("alice")] });
    const switching = new Proxy({
      compilation: compilationFor(scalarQuery()),
      candidates: [covering]
    }, {
      get(target, property, receiver) {
        return Reflect.get(target, property, receiver);
      }
    });
    expect(() => compileQueryGamma(switching)).toThrow(/proxies/u);
  });

  it("ignores a later candidate array swap and nested mutation after compile capture", () => {
    const bindingRow = {
      variable: "x",
      semantic_identity: "alice",
      distinctness: "proved_distinct" as const
    };
    const bag = [
      candidate("A", { bindings: [bindingRow] })
    ];
    const compiled = compileQueryGamma({
      compilation: compilationFor(scalarQuery()),
      class_source: PLANTED_OSF_SOURCE,
      candidates: bag
    });
    bag.splice(0, 1, candidate("B", { bindings_status: "unknown" }));
    bindingRow.variable = "y";
    expect(compiled.semantic_feasibility).toEqual([
      { candidate_key: "A", semantic: "feasible" }
    ]);
    expect(compiled.standings.find((row) =>
      row.atom_id === findGammaAtom(compiled, { kind: "scalar_binding", target: "x" }).atom_id)
      ?.coverage).toBe("covers");
  });

  it("does not let weights or live novelty change compiled strata", () => {
    const compiled = compileGamma(scalarQuery([{
      id: "rel1",
      relation: "bought",
      arguments: ["x"]
    }]), [
      candidate("A", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1")]
      })
    ]);
    expect(evaluateQueryGammaTuple(compiled, emptyQueryGammaSelectedSet(), "A")).toEqual({
      answer_binding_position: 1,
      required_proposition_support: 1,
      certified_independent_support: 0
    });
    expect(compiled.atoms.map((atom) => atom.atom_id).join(" ")).not.toMatch(/facility|Values_v|cid/u);
  });

  it("does not split distinct variable and identity on the first colon", () => {
    const query = supportedQuery({
      variables: [{ name: "x:y", sort: "entity" }],
      answer: { kind: "distinct", variable: "x:y", completion: { kind: "at_most", n: 5 } }
    });
    const compiled = compileGamma(query, [
      candidate("A", { bindings: [binding("z", "proved_distinct", "x:y")] }),
      candidate("B", { bindings: [binding("y:z", "proved_distinct", "x")] })
    ]);
    expect(compiled.compile_status).toBe("unsupported");
    expect(compiled.unsupported_reason).toBe("distinctness_source_unsupported");
  });

  it("keeps predicate and constraint atoms with the same id distinct", () => {
    const compiled = compileGamma(scalarQuery([{
      id: "p",
      relation: "bought",
      arguments: ["x"]
    }], [{
      id: "p",
      constraint: "after",
      arguments: ["x"]
    }]), [
      candidate("A", {
        bindings: [binding("alice")],
        propositions: [proposition("p")]
      })
    ]);
    const predicate = findGammaAtom(compiled, {
      kind: "required_proposition",
      target: "p",
      jurisdiction: "predicate"
    });
    const constraint = findGammaAtom(compiled, {
      kind: "required_proposition",
      target: "p",
      jurisdiction: "constraint"
    });
    expect(predicate.atom_id).not.toBe(constraint.atom_id);
    expect(new Set(compiled.atoms.map((atom) => atom.atom_id)).size)
      .toBe(compiled.atoms.length);
    expect(compiled.standings.find((row) =>
      row.atom_id === predicate.atom_id)?.coverage).toBe("covers");
    expect(compiled.standings.find((row) =>
      row.atom_id === constraint.atom_id)?.coverage).toBe("does_not_cover");
    expect(evaluateQueryGammaTuple(compiled, emptyQueryGammaSelectedSet(), "A")).toEqual({
      answer_binding_position: 1,
      required_proposition_support: 1,
      certified_independent_support: 0
    });
  });

  it("rejects duplicate compile-input candidate keys", () => {
    expect(() => compileQueryGamma({
      compilation: compilationFor(scalarQuery()),
      candidates: [
        candidate("A", { bindings: [binding("alice")] }),
        candidate("A", { bindings: [binding("bob")] })
      ]
    })).toThrow(/duplicate compile-input candidate_key/u);
  });

  it("does not treat all-unknown distinct as vacuously feasible", () => {
    const compiled = compileGamma(distinctQuery(), [
      candidate("also-open", { bindings_status: "unknown" }),
      candidate("open", { bindings_status: "unknown" })
    ]);
    expect(compiled.compile_status).toBe("unsupported");
    expect(compiled.atoms).toEqual([]);
    expect(compiled.semantic_feasibility).toEqual([]);
  });

  it("does not treat all-unknown sequence as vacuously feasible", () => {
    const compiled = compileGamma(sequenceQuery(2), [
      candidate("open", { bindings_status: "unknown" })
    ]);
    expect(compiled.compile_status).toBe("unsupported");
    expect(compiled.atoms).toEqual([]);
    expect(compiled.semantic_feasibility).toEqual([]);
  });
});
