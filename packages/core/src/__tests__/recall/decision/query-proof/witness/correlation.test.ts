import { describe, expect, it } from "vitest";
import {
  correlationInformationLeq,
  createCorrelationWitness,
  meetCorrelation,
  refineCorrelation,
  type CorrelationState,
  type CorrelationWitness
} from "../../../../../recall/decision/query-proof/witness/index.js";
import { PAIR_PINS, PROV, PROV_EXTENDED } from "./fixtures.js";
import { assertMonotoneRefinement, assertPoset } from "./order-properties.js";

function correlation(state: CorrelationState): CorrelationWitness {
  return createCorrelationWitness({
    identity: PAIR_PINS,
    provenance: PROV,
    epistemic: { kind: "exact" },
    payload: { left_id: "ev-1", right_id: "ev-2", state }
  });
}

describe("correlation partition domain", () => {
  const possibly = correlation("possibly_correlated");
  const lineage = correlation("same_source_lineage");
  const unit = correlation("same_evidence_unit");
  const independent = correlation("certified_independent");

  it("has a reflexive antisymmetric transitive information order", () => {
    assertPoset([possibly, lineage, unit, independent], correlationInformationLeq);
  });

  it("refines possibly_correlated to any stronger knowledge", () => {
    assertMonotoneRefinement(
      possibly,
      lineage,
      correlationInformationLeq,
      refineCorrelation
    );
    expect(refineCorrelation(possibly, {
      ...independent,
      provenance: PROV_EXTENDED
    }).payload?.state).toBe("certified_independent");
    expect(refineCorrelation(lineage, unit).payload?.state).toBe("same_evidence_unit");
  });

  it("cannot weaken correlation knowledge", () => {
    expect(() => refineCorrelation(unit, lineage)).toThrow(/widening/u);
    expect(() => refineCorrelation(unit, possibly)).toThrow(/widening/u);
    expect(() => refineCorrelation(independent, possibly)).toThrow(/widening/u);
    expect(refineCorrelation(independent, lineage).epistemic.kind).toBe("conflict");
  });

  it("meets certified_independent with same-unit or lineage as conflict", () => {
    expect(meetCorrelation(independent, unit).epistemic.kind).toBe("conflict");
    expect(meetCorrelation(independent, lineage).epistemic.kind).toBe("conflict");
    expect(meetCorrelation(lineage, unit).payload?.state).toBe("same_evidence_unit");
  });
});
