import { describe, expect, it } from "vitest";
import {
  createBindingRelationWitness,
  joinBindingRelation,
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
  extras: {
    epistemic?: BindingRelationWitness["epistemic"];
    withDistinctnessReceipt?: boolean;
  } = {}
): BindingRelationWitness {
  const epistemic = extras.epistemic ??
    (state === "conflict" ? { kind: "conflict" as const } : { kind: "exact" as const });
  const withDistinctnessReceipt = extras.withDistinctnessReceipt ?? state === "distinct";
  const payload = {
    left_id: "left",
    right_id: "right",
    state,
    ...(withDistinctnessReceipt ? {
      distinctness_receipt: {
        schema_version: 1 as const,
        operator_id: "binding_distinctness_evidence_v1" as const,
        query_id: PAIR_PINS.query_id,
        snapshot_digest: PAIR_PINS.snapshot_digest,
        left_id: "left",
        right_id: "right",
        source_id: PROV[0]!.source_id,
        producer: PROV[0]!.producer
      }
    } : {})
  };
  return createBindingRelationWitness({
    identity: PAIR_PINS,
    provenance: PROV,
    epistemic,
    payload
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

  it("refines may_equal to proved distinct with identity-bound evidence", () => {
    expect(bindingInformationLeq(mayEqual, distinct)).toBe(true);
    expect(refineBindingRelation(mayEqual, distinct).payload?.state).toBe("distinct");
    expect(meetBindingRelation(mayEqual, distinct).payload?.state).toBe("distinct");
  });

  it("rejects distinctness without typed positive evidence", () => {
    expect(() => binding("distinct", { withDistinctnessReceipt: false })).toThrow(/distinctness receipt/u);
    expect(mayEqual.payload?.state).toBe("may_equal");
  });

  it("rejects distinctness evidence with drifted identity or provenance", () => {
    const driftedPayload = {
      left_id: "left",
      right_id: "right",
      state: "distinct" as const,
      distinctness_receipt: {
        schema_version: 1 as const,
        operator_id: "binding_distinctness_evidence_v1" as const,
        query_id: "other-query",
        snapshot_digest: PAIR_PINS.snapshot_digest,
        left_id: "left",
        right_id: "right",
        source_id: "missing-source",
        producer: "missing-producer"
      }
    };
    expect(() => createBindingRelationWitness({
      identity: PAIR_PINS,
      provenance: PROV,
      epistemic: { kind: "exact" },
      payload: driftedPayload
    })).toThrow(/identity/u);
    expect(() => createBindingRelationWitness({
      identity: PAIR_PINS,
      provenance: PROV,
      epistemic: { kind: "exact" },
      payload: {
        ...driftedPayload,
        distinctness_receipt: {
          ...driftedPayload.distinctness_receipt,
          query_id: PAIR_PINS.query_id
        }
      }
    })).toThrow(/provenance/u);
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

  it("joins equal and distinct to their may_equal possibility set", () => {
    expect(joinBindingRelation(equal, distinct).payload?.state).toBe("may_equal");
    expect(joinBindingRelation(distinct, equal).payload?.state).toBe("may_equal");
  });

  it("rejects weakening a concrete state back to unknown", () => {
    expect(() => refineBindingRelation(equal, unknown)).toThrow(/widening/u);
    expect(() => refineBindingRelation(distinct, unknown)).toThrow(/widening/u);
  });
});
