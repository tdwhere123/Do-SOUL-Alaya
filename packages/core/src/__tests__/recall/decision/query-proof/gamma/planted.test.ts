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
  proposition,
  scalarQuery
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
});
