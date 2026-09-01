import { describe, expect, it } from "vitest";
import { digestRecallFieldIdentity } from
  "../../../../../recall/field/field-identity.js";
import { compileQueryGamma } from
  "../../../../../recall/decision/query-proof/gamma/compile.js";
import {
  QUERY_GAMMA_STRATA,
  QUERY_PROOF_GAMMA_OPERATOR_ID
} from "../../../../../recall/decision/query-proof/gamma/contract.js";
import {
  emptyQueryGammaSelectedSet,
  evaluateQueryGammaTuple
} from "../../../../../recall/decision/query-proof/gamma/evaluate.js";
import {
  allObservableDistinct,
  argmaxQuery,
  argminQuery,
  binding,
  candidate,
  compilationFor,
  compileGamma,
  distinctQuery,
  extremumWitness,
  hole,
  proposition,
  scalarQuery,
  sequenceQuery
} from "./gamma-fixture.js";

describe("query-compiled Gamma_q", () => {
  it("compiles scalar, distinct, and sequence into one three-stratum atom vocabulary", () => {
    const scalar = compileGamma(scalarQuery(), [candidate("A", { bindings: [binding("alice")] })]);
    expect(scalar.compile_status).toBe("compiled");
    expect(scalar.operator_id).toBe(QUERY_PROOF_GAMMA_OPERATOR_ID);
    expect(scalar.atoms.map((atom) => atom.stratum)).toEqual(["answer_binding_position"]);
    expect(scalar.independent_support_obligation).toBe(false);

    const distinct = compileGamma(distinctQuery(), [
      candidate("A", { bindings: [binding("alice"), binding("bob")] })
    ]);
    expect(distinct.atoms.map((atom) =>
      `${atom.variable}:${atom.semantic_identity}`).sort()).toEqual(["x:alice", "x:bob"]);

    const sequence = compileGamma(sequenceQuery(2), [
      candidate("A", { sequence_slots: [{ position: 0, binding: "alice" }] }),
      candidate("B", { sequence_slots: [{ position: 1, binding: "bob" }] })
    ]);
    expect(sequence.atoms.map((atom) => ({
      position: atom.position,
      target: atom.target
    }))).toEqual([
      { position: 0, target: "alice" },
      { position: 1, target: "bob" }
    ]);

  });

  it("keeps resource feasibility a separate selected-set policy from semantic feasibility", () => {
    const compiled = compileGamma(scalarQuery(), [
      candidate("A", { bindings: [binding("alice")], token_cost: 9 })
    ], {
      resource_policy: {
        schema_version: 1,
        reject_duplicate_object: true,
        token_budget: 4,
        per_dimension_limits: { mem: 1 }
      }
    });
    expect(compiled.semantic_feasibility).toEqual([{ candidate_key: "A", semantic: "feasible" }]);
    expect(compiled.resource_policy.token_budget).toBe(4);
    expect(compiled.resource_policy.reject_duplicate_object).toBe(true);
  });

  it("marks unknown evidence unresolved and refuting evidence infeasible", () => {
    const compiled = compileGamma(scalarQuery([{
      id: "rel1",
      relation: "bought",
      arguments: ["x"]
    }]), [
      candidate("unknown", { bindings_status: "unknown" }),
      candidate("refute", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1", "refutes")]
      }),
      candidate("ok", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1")]
      })
    ]);
    expect(compiled.semantic_feasibility).toEqual([
      { candidate_key: "ok", semantic: "feasible" },
      { candidate_key: "refute", semantic: "infeasible" },
      { candidate_key: "unknown", semantic: "unresolved" }
    ]);
  });

  it("keeps the third coordinate structural zero unless CQ_q already carries independent-support Phi", () => {
    const without = compileGamma(scalarQuery([{
      id: "rel1",
      relation: "bought",
      arguments: ["x"]
    }]), [
      candidate("A", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1", "supports", "certified_independent")]
      })
    ]);
    expect(without.independent_support_obligation).toBe(false);
    expect(without.atoms.some((atom) => atom.stratum === "certified_independent_support"))
      .toBe(false);
    expect(evaluateQueryGammaTuple(without, emptyQueryGammaSelectedSet(), "A"))
      .toEqual({
        answer_binding_position: 1,
        required_proposition_support: 1,
        certified_independent_support: 0
      });

    const withObligation = compileGamma(scalarQuery([{
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
          proposition("need-ind", "supports", "certified_independent", "constraint")
        ]
      })
    ]);
    expect(withObligation.independent_support_obligation).toBe(true);
    expect(withObligation.atoms.map((atom) => atom.stratum)).toEqual([...QUERY_GAMMA_STRATA]);
    expect(evaluateQueryGammaTuple(withObligation, emptyQueryGammaSelectedSet(), "A")
      .certified_independent_support).toBe(1);

    const base = compilationFor(scalarQuery([{
      id: "rel1",
      relation: "bought",
      arguments: ["x"]
    }]));
    const { digest: _digest, ...body } = base;
    const sensitivities = Object.freeze([{
      effect: "proposition_bound" as const,
      target: "independent_support"
    }]);
    const compilation = Object.freeze({
      ...body,
      sensitivities,
      digest: digestRecallFieldIdentity({ ...body, sensitivities })
    });
    const fromSensitivity = compileQueryGamma({
      compilation,
      candidates: [
        candidate("A", {
          bindings: [binding("alice")],
          propositions: [
            proposition("rel1"),
            proposition("independent_support", "supports", "certified_independent", "sensitivity")
          ]
        })
      ]
    });
    expect(fromSensitivity.independent_support_obligation).toBe(true);
    expect(fromSensitivity.atoms.some((atom) =>
      atom.stratum === "certified_independent_support")).toBe(true);
  });

  it("records all_observable as a seal obligation and not as a score atom", () => {
    const compiled = compileGamma(allObservableDistinct(), [
      candidate("A", { bindings: [binding("alice")] })
    ]);
    expect(compiled.seal_obligations).toHaveLength(1);
    expect(compiled.seal_obligations[0]?.kind).toBe("all_observable");
    expect(compiled.atoms.every((atom) => atom.kind !== "required_proposition")).toBe(true);
  });

  it("returns explicit unsupported for missing extrema witness and blocked programs", () => {
    expect(compileGamma(argmaxQuery(), [candidate("A")]).unsupported_reason)
      .toBe("missing_extremum_closure_witness");
    const compilation = compilationFor(argmaxQuery());
    expect(compileGamma(argmaxQuery(), [candidate("A")], {
      compilation,
      extremum_witness: extremumWitness(compilation, "argmax", ["alice"])
    }).unsupported_reason).toBe("extremum_source_authority_unavailable");
    const blocked = compilationFor(scalarQuery(), [hole("count_sum_unsupported")]);
    expect(compileQueryGamma({
      compilation: blocked,
      candidates: [candidate("A")]
    }).unsupported_reason).toBe("operator_resolution_blocked");
    const certifiedHole = compilationFor(scalarQuery(), [hole("unknown_correlation")]);
    expect(compileQueryGamma({
      compilation: certifiedHole,
      candidates: [candidate("A")]
    }).unsupported_reason).toBe("blocks_certified_delivery");
  });

  it("does not let a wrong typed variable cover a distinct atom", () => {
    const compiled = compileGamma(distinctQuery(), [
      candidate("A", { bindings: [binding("alice")] }),
      candidate("wrong", { bindings: [binding("alice", "proved_distinct", "y")] })
    ]);
    expect(compiled.atoms.map((atom) =>
      `${atom.variable}:${atom.semantic_identity}`)).toEqual(["x:alice"]);
    expect(compiled.standings.find((row) =>
      row.candidate_key === "wrong" && row.atom_id === compiled.atoms[0]?.atom_id)?.coverage)
      .toBe("does_not_cover");
    expect(compiled.standings.find((row) =>
      row.candidate_key === "A" && row.atom_id === compiled.atoms[0]?.atom_id)?.coverage)
      .toBe("covers");
    const identity = compileGamma(distinctQuery(), [
      candidate("A", { bindings: [binding("alice")] }),
      candidate("other", { bindings: [binding("bob")] })
    ]);
    expect(identity.standings.find((row) =>
      row.candidate_key === "other" && row.atom_id === identity.atoms.find((atom) =>
        atom.semantic_identity === "alice")?.atom_id)?.coverage)
      .toBe("does_not_cover");
  });

  it("rejects an extremum witness with a mismatched query or principal binding", () => {
    const query = argmaxQuery();
    const compilation = compilationFor(query);
    const witness = extremumWitness(compilation, "argmax", ["alice"], query);
    expect(compileGamma(query, [candidate("A")], {
      compilation,
      extremum_witness: { ...witness, query_digest: compilation.digest,
        witness_digest: digestRecallFieldIdentity({ tampered: "query" }) }
    }).unsupported_reason).toBe("invalid_extremum_closure_witness");
    const queryTamper = { ...witness, query_digest: compilation.digest };
    const queryBody = (({ witness_digest: _digest, ...body }) => body)(queryTamper);
    expect(compileGamma(query, [candidate("A")], {
      compilation,
      extremum_witness: {
        ...queryTamper,
        witness_digest: digestRecallFieldIdentity(queryBody)
      }
    }).unsupported_reason).toBe("extremum_witness_query_mismatch");
    const honest = extremumWitness(compilation, "argmax", ["alice"], query, ["A"]);
    const principalBody = (({ witness_digest: _p, ...body }) => body)({
      ...honest,
      principal_digest: digestRecallFieldIdentity({ principal: "wrong" })
    });
    expect(compileGamma(query, [candidate("A")], {
      compilation,
      extremum_witness: {
        ...principalBody,
        witness_digest: digestRecallFieldIdentity(principalBody)
      }
    }).unsupported_reason).toBe("extremum_witness_principal_mismatch");
    const universeBody = (({ witness_digest: _u, ...body }) => body)({
      ...honest,
      universe_digest: compilation.snapshot_receipt_digest
    });
    expect(compileGamma(query, [candidate("A")], {
      compilation,
      extremum_witness: {
        ...universeBody,
        witness_digest: digestRecallFieldIdentity(universeBody)
      }
    }).unsupported_reason).toBe("extremum_witness_universe_mismatch");
    const sensitivityBody = (({ witness_digest: _s, ...body }) => body)({
      ...honest,
      sensitivity_id: "extremum:wrong"
    });
    expect(compileGamma(query, [candidate("A")], {
      compilation,
      extremum_witness: {
        ...sensitivityBody,
        witness_digest: digestRecallFieldIdentity(sensitivityBody)
      }
    }).unsupported_reason).toBe("extremum_witness_sensitivity_mismatch");
    const closureBody = (({ witness_digest: _c, ...body }) => body)({
      ...honest,
      closure_result_digest: digestRecallFieldIdentity({ closure: "wrong" })
    });
    expect(compileGamma(query, [candidate("A")], {
      compilation,
      extremum_witness: {
        ...closureBody,
        witness_digest: digestRecallFieldIdentity(closureBody)
      }
    }).unsupported_reason).toBe("extremum_witness_closure_mismatch");
  });

  it("digests compiled atoms and standings independently of candidate permutation", () => {
    const query = distinctQuery();
    const left = compileGamma(query, [
      candidate("B", { bindings: [binding("bob")] }),
      candidate("A", { bindings: [binding("alice")] })
    ]);
    const right = compileGamma(query, [
      candidate("A", { bindings: [binding("alice")] }),
      candidate("B", { bindings: [binding("bob")] })
    ]);
    expect(left.gamma_digest).toBe(right.gamma_digest);
    expect(left.atoms).toEqual(right.atoms);
    expect(left.standings).toEqual(right.standings);
  });

  it("returns explicit unsupported for illegal sequence slots", () => {
    expect(compileGamma(sequenceQuery(2), [
      candidate("A", { sequence_slots: [{ position: 9, binding: "late" }] })
    ]).unsupported_reason).toBe("illegal_sequence_slot");
    expect(compileGamma(sequenceQuery(2), [
      candidate("A", { sequence_slots: [{ position: -1, binding: "neg" }] })
    ]).unsupported_reason).toBe("illegal_sequence_slot");
  });

  it("rejects an extremum witness for the wrong operator", () => {
    const query = argmaxQuery();
    const compilation = compilationFor(query);
    const compiled = compileGamma(query, [candidate("A")], {
      compilation,
      extremum_witness: extremumWitness(compilation, "argmin", ["alice"])
    });
    expect(compiled.unsupported_reason).toBe("extremum_operator_mismatch");
  });

  it("rejects a tampered extremum witness digest", () => {
    const query = argmaxQuery();
    const compilation = compilationFor(query);
    const witness = extremumWitness(compilation, "argmax", ["alice"]);
    const compiled = compileGamma(query, [candidate("A")], {
      compilation,
      extremum_witness: { ...witness, witness_digest: digestRecallFieldIdentity({ tampered: true }) }
    });
    expect(compiled.unsupported_reason).toBe("invalid_extremum_closure_witness");
  });
});
