import { describe, expect, it } from "vitest";
import { ShadowContractError } from
  "../../../../../recall/decision/contract-primitives.js";
import { compileQueryGamma } from
  "../../../../../recall/decision/query-proof/gamma/compile.js";
import {
  queryClassCapabilityStatus
} from "../../../../../recall/decision/query-proof/gamma/capability-matrix.js";
import {
  admitCompiledLowerFrontier,
  emptyQueryGammaSelectedSet,
  evaluateQueryGammaTuple,
  provedFeasibleCandidateKeys,
  provedInfeasibleCandidateKeys
} from "../../../../../recall/decision/query-proof/gamma/evaluate.js";
import {
  binding,
  candidate,
  compilationFor,
  compileGamma,
  PLANTED_OSF_SOURCE,
  hole,
  proposition,
  scalarQuery,
  sequenceQuery,
  distinctQuery,
  argmaxQuery
} from "./gamma-fixture.js";

describe("compile disposition", () => {
  it.each([
    ["complete", [], "compiled", "complete"],
    ["partial certified hole", [hole("unknown_correlation")], "compiled", "partial"],
    ["operator blocked", [hole("count_sum_unsupported")], "unsupported", "unsupported"]
  ] as const)("%s", (_label, holes, status, disposition) => {
    const compiled = compileQueryGamma({
      compilation: compilationFor(scalarQuery(), [...holes]),
      class_source: PLANTED_OSF_SOURCE,
      candidates: [candidate("A", { bindings: [binding("alice")] })]
    });
    expect(compiled.compile_status).toBe(status);
    expect(compiled.compile_disposition).toBe(disposition);
  });
});

describe("semantic feasibility mixtures", () => {
  it("keeps feasible, infeasible, and unresolved as independent states", () => {
    const compiled = compileGamma(scalarQuery([{
      id: "rel1",
      relation: "bought",
      arguments: ["x"]
    }]), [
      candidate("ok", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1")]
      }),
      candidate("refute", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1", "refutes")]
      }),
      candidate("open", { bindings_status: "unknown" })
    ]);
    expect(compiled.semantic_feasibility).toEqual([
      { candidate_key: "ok", semantic: "feasible" },
      { candidate_key: "open", semantic: "unresolved" },
      { candidate_key: "refute", semantic: "infeasible" }
    ]);
    expect([...provedFeasibleCandidateKeys(compiled)].sort()).toEqual(["ok"]);
    expect([...provedInfeasibleCandidateKeys(compiled)].sort()).toEqual(["refute"]);
    expect(provedFeasibleCandidateKeys(compiled).has("open")).toBe(false);
    expect(provedInfeasibleCandidateKeys(compiled).has("open")).toBe(false);
  });
});

describe("capture-once fail closed", () => {
  it("rejects getter compile premises", () => {
    const input = {
      compilation: compilationFor(scalarQuery()),
      candidates: [candidate("A", { bindings: [binding("alice")] })]
    };
    Object.defineProperty(input, "candidates", {
      enumerable: true,
      get: () => [candidate("A", { bindings: [binding("alice")] })]
    });
    expect(() => compileQueryGamma(input)).toThrow(ShadowContractError);
    expect(() => compileQueryGamma(input)).toThrow(/getters/u);
  });
});

describe("capability matrix is evidence-driven", () => {
  it("does not treat unproved lease as available", () => {
    expect(queryClassCapabilityStatus("scalar_simple").supported_in_shadow).toBe(false);
    expect(queryClassCapabilityStatus("required_proposition").supported_in_shadow).toBe(false);
    expect(queryClassCapabilityStatus("certified_independent_support").supported_in_shadow)
      .toBe(false);
    expect(queryClassCapabilityStatus("distinct").supported_in_shadow).toBe(false);
    expect(queryClassCapabilityStatus("sequence").supported_in_shadow).toBe(false);
    expect(queryClassCapabilityStatus("extremum").supported_in_shadow).toBe(false);
  });

  it("supports scalar-simple only from a proved OSF owner", () => {
    expect(queryClassCapabilityStatus("scalar_simple", {
      owner: "osf",
      available: true
    })).toMatchObject({
      supported_in_shadow: true,
      source_owner: "osf",
      source_available: true
    });
    expect(queryClassCapabilityStatus("scalar_simple", {
      owner: "osf",
      available: false
    }).supported_in_shadow).toBe(false);
  });
});

describe("unproved classes are unsupported before Decide_Q", () => {
  it.each([
    ["distinct", distinctQuery(), "distinctness_source_unsupported"],
    ["sequence", sequenceQuery(1), "sequence_slots_source_unsupported"],
    ["extremum", argmaxQuery(), "extremum_witness_source_unsupported"]
  ] as const)("%s", (_label, query, reason) => {
    const compiled = compileGamma(query, [candidate("A")]);
    expect(compiled.compile_status).toBe("unsupported");
    expect(compiled.unsupported_reason).toBe(reason);
    expect(compiled.atoms).toEqual([]);
  });
});

describe("lower-frontier higher-stratum gain", () => {
  it("denies admission whose only uncovered gain is certified independence", () => {
    const compiled = compileGamma(scalarQuery([], [{
      id: "need-ind",
      constraint: "independent_support",
      arguments: ["x"]
    }]), [
      candidate("core", {
        bindings: [binding("alice")],
        propositions: [proposition("need-ind", "supports", "unknown", "constraint")]
      }),
      candidate("lower", {
        bindings: [binding("alice")],
        propositions: [proposition("need-ind", "supports", "certified_independent", "constraint")]
      })
    ]);
    const admitted = admitCompiledLowerFrontier(
      compiled, emptyQueryGammaSelectedSet(), "lower", ["core"]
    );
    expect(admitted.admitted).toBe(false);
  });

  it("admits lower-frontier only for uncovered higher-stratum atoms", () => {
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
      })
    ]);
    expect(admitCompiledLowerFrontier(
      compiled, emptyQueryGammaSelectedSet(), "lower", ["core"]
    ).admitted).toBe(true);
  });
});

describe("same-lineage cannot mint certified independence", () => {
  it("counts proposition coverage without independence novelty", () => {
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
          proposition("need-ind", "supports", "correlated", "constraint")
        ]
      })
    ]);
    expect(evaluateQueryGammaTuple(compiled, emptyQueryGammaSelectedSet(), "A")).toEqual({
      answer_binding_position: 1,
      required_proposition_support: 1,
      certified_independent_support: 0
    });
  });
});

describe("digest sensitivity", () => {
  it("changes gamma digest when classified holes change", () => {
    const complete = compileGamma(scalarQuery(), [
      candidate("A", { bindings: [binding("alice")] })
    ]);
    const partial = compileQueryGamma({
      compilation: compilationFor(scalarQuery(), [hole("unknown_correlation")]),
      class_source: PLANTED_OSF_SOURCE,
      candidates: [candidate("A", { bindings: [binding("alice")] })]
    });
    expect(complete.gamma_digest).not.toBe(partial.gamma_digest);
    expect(partial.compile_disposition).toBe("partial");
  });

  it("changes gamma digest for atoms, source evidence, and query, not standings", () => {
    const alice = compileGamma(scalarQuery(), [
      candidate("A", { bindings: [binding("alice")] })
    ]);
    const unknown = compileGamma(scalarQuery(), [
      candidate("A", { bindings_status: "unknown" })
    ]);
    const otherQuery = compileGamma(scalarQuery([{
      id: "rel1", relation: "bought", arguments: ["x"]
    }]), [
      candidate("A", {
        bindings: [binding("alice")],
        propositions: [proposition("rel1")]
      })
    ]);
    expect(alice.source_evidence_digest).not.toBe(unknown.source_evidence_digest);
    expect(alice.gamma_digest).not.toBe(unknown.gamma_digest);
    expect(alice.atoms).not.toEqual(otherQuery.atoms);
    expect(alice.gamma_digest).not.toBe(otherQuery.gamma_digest);
    const standingForgery = Object.freeze({
      ...alice,
      standings: Object.freeze(alice.standings.map((row) => Object.freeze({
        ...row,
        coverage: "does_not_cover" as const
      })))
    });
    expect(standingForgery.gamma_digest).toBe(alice.gamma_digest);
    expect(standingForgery.standings).not.toEqual(alice.standings);
    const feasibilityForgery = Object.freeze({
      ...alice,
      semantic_feasibility: Object.freeze(alice.semantic_feasibility.map((row) =>
        Object.freeze({ ...row, semantic: "unresolved" as const })))
    });
    expect(feasibilityForgery.gamma_digest).toBe(alice.gamma_digest);
  });
});
