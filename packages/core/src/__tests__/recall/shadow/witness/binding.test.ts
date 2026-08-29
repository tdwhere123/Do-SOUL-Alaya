import { describe, expect, it } from "vitest";
import {
  createBindingRelationWitness,
  meetBindingRelation,
  bindingInformationLeq,
  refineBindingRelation,
  type BindingRelationState,
  type BindingRelationWitness
} from "../../../../recall/shadow/witness/index.js";
import { PAIR_PINS, PROV, PROV_EXTENDED } from "./fixtures.js";
import { assertMonotoneRefinement, assertPoset } from "./order-properties.js";

function binding(
  state: BindingRelationState,
  extras: { epistemic?: BindingRelationWitness["epistemic"] } = {}
): BindingRelationWitness {
  const epistemic = extras.epistemic ??
    (state === "conflict" ? { kind: "conflict" as const } : { kind: "exact" as const });
  return createBindingRelationWitness({
    identity: PAIR_PINS,
    provenance: PROV,
    epistemic,
    payload: { left_id: "left", right_id: "right", state }
  });
}

describe("binding relation domain", () => {
  const unknown = binding("unknown");
  const mayEqual = binding("may_equal");
  const equal = binding("equal");
  const distinct = binding("distinct");
  const conflict = binding("conflict");

  it("has a reflexive antisymmetric transitive information order", () => {
    assertPoset([unknown, mayEqual, equal, distinct, conflict], bindingInformationLeq);
  });

  it("lets unknown and may_equal refine toward equal", () => {
    assertMonotoneRefinement(unknown, mayEqual, bindingInformationLeq, refineBindingRelation);
    const refined = refineBindingRelation(mayEqual, {
      ...equal,
      provenance: PROV_EXTENDED
    });
    expect(refined.payload?.state).toBe("equal");
  });

  it("does not force may_equal to distinct without a receipt", () => {
    expect(bindingInformationLeq(mayEqual, distinct)).toBe(false);
    expect(() => refineBindingRelation(mayEqual, distinct)).toThrow(/incomparable|refinement/u);
    expect(meetBindingRelation(mayEqual, distinct).epistemic.kind).toBe("conflict");
  });

  it("meets equal and distinct as conflict, not last-write-wins", () => {
    const met = meetBindingRelation(equal, distinct);
    expect(met.epistemic.kind).toBe("conflict");
    expect(met.payload?.state).toBe("conflict");
    const refined = refineBindingRelation(equal, distinct);
    expect(refined.epistemic.kind).toBe("conflict");
    expect(refined.payload?.state).not.toBe("distinct");
    expect(refined.payload?.state).not.toBe("equal");
  });

  it("rejects weakening a concrete state back to unknown", () => {
    expect(() => refineBindingRelation(equal, unknown)).toThrow(/widening/u);
    expect(() => refineBindingRelation(distinct, unknown)).toThrow(/widening/u);
  });
});
