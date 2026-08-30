import { describe, expect, it } from "vitest";
import {
  createBindingRelationWitness,
  joinBindingRelation,
  meetBindingRelation,
  bindingInformationLeq,
  refineBindingRelation,
  type BindingRelationState,
  type BindingRelationWitness,
  type BindingSourceObservationReceiptV1
} from "../../../../recall/shadow/witness/index.js";
import { digestRecallFieldIdentity } from
  "../../../../recall/field/field-identity.js";
import { PAIR_PINS, PROV, PROV_EXTENDED } from "./fixtures.js";
import { assertMonotoneRefinement, assertPoset } from "./order-properties.js";

const OBSERVATION_BODY = Object.freeze({
  schema_version: 1 as const,
  source_owner: "binding_test_registry",
  source_observation_id: "binding-observation-1",
  source_id: PROV[0]!.source_id,
  producer_operator_id: PROV[0]!.producer,
  producer_operator_version: "1"
});
const SOURCE_OBSERVATION = Object.freeze({
  ...OBSERVATION_BODY,
  observation_digest: digestRecallFieldIdentity(OBSERVATION_BODY)
});
const EVIDENCE_VERIFIER = Object.freeze({
  source_owner: OBSERVATION_BODY.source_owner,
  producer_operator_id: OBSERVATION_BODY.producer_operator_id,
  producer_operator_version: OBSERVATION_BODY.producer_operator_version,
  verifySourceObservation(receipt: BindingSourceObservationReceiptV1): boolean {
    const { observation_digest, ...body } = receipt;
    return observation_digest === SOURCE_OBSERVATION.observation_digest
      && digestRecallFieldIdentity(body) === observation_digest;
  }
});

function binding(
  state: BindingRelationState,
  extras: {
    epistemic?: BindingRelationWitness["epistemic"];
    withRelationReceipt?: boolean;
  } = {}
): BindingRelationWitness {
  const epistemic = extras.epistemic ??
    (state === "conflict" ? { kind: "conflict" as const } : { kind: "exact" as const });
  const withRelationReceipt = extras.withRelationReceipt
    ?? (state === "equal" || state === "distinct");
  const payload = {
    left_id: "left",
    right_id: "right",
    state,
    ...(withRelationReceipt && (state === "equal" || state === "distinct") ? {
      relation_evidence_receipt: relationReceipt(state)
    } : {})
  };
  return createBindingRelationWitness({
    identity: PAIR_PINS,
    provenance: PROV,
    epistemic,
    payload,
    evidence_verifier: EVIDENCE_VERIFIER
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

  it("keeps equal and distinct at may_equal without admitted positive evidence", () => {
    expect(binding("equal", { withRelationReceipt: false }).payload?.state).toBe("may_equal");
    expect(binding("distinct", { withRelationReceipt: false }).payload?.state).toBe("may_equal");
  });

  it("rejects caller-authored observation strings not owned by the verifier", () => {
    const forged = relationReceipt("equal", {
      source_observation: {
        ...SOURCE_OBSERVATION,
        source_observation_id: "caller-forged"
      }
    });
    const witness = createBindingRelationWitness({
      identity: PAIR_PINS,
      provenance: PROV,
      epistemic: { kind: "exact" },
      payload: {
        left_id: "left",
        right_id: "right",
        state: "equal",
        relation_evidence_receipt: forged
      },
      evidence_verifier: EVIDENCE_VERIFIER
    });
    expect(witness.payload?.state).toBe("may_equal");
  });

  it.each([
    ["relation", { relation: "equal" as const }],
    ["query", { query_id: "other-query" }],
    ["snapshot", { snapshot_digest: `sha256:${"d".repeat(64)}` }],
    ["pair", { left_id: "other-left" }],
    ["source", { source_observation: { ...SOURCE_OBSERVATION, source_id: "missing-source" } }],
    ["version", { source_observation: {
      ...SOURCE_OBSERVATION,
      producer_operator_version: "forged"
    } }],
    ["digest", { receipt_digest: `sha256:${"e".repeat(64)}` }]
  ])("fails closed on a tampered %s binding receipt", (_label, override) => {
    const valid = relationReceipt("distinct");
    const witness = createBindingRelationWitness({
      identity: PAIR_PINS,
      provenance: PROV,
      epistemic: { kind: "exact" },
      payload: {
        left_id: "left",
        right_id: "right",
        state: "distinct",
        relation_evidence_receipt: { ...valid, ...override }
      },
      evidence_verifier: EVIDENCE_VERIFIER
    });
    expect(witness.payload?.state).toBe("may_equal");
  });

  it("does not infer equality from matching semantic strings or distinctness from ids", () => {
    expect(createBindingRelationWitness({
      identity: PAIR_PINS,
      provenance: PROV,
      epistemic: { kind: "exact" },
      payload: { left_id: "person.alice", right_id: "person.alice", state: "equal" }
    }).payload?.state).toBe("may_equal");
    expect(createBindingRelationWitness({
      identity: PAIR_PINS,
      provenance: PROV,
      epistemic: { kind: "exact" },
      payload: { left_id: "id-a", right_id: "id-b", state: "distinct" }
    }).payload?.state).toBe("may_equal");
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

function relationReceipt(
  relation: "equal" | "distinct",
  override: Record<string, unknown> = {}
) {
  const body = {
    schema_version: 1 as const,
    operator_id: "binding_relation_evidence_v1" as const,
    relation,
    query_id: PAIR_PINS.query_id,
    snapshot_digest: PAIR_PINS.snapshot_digest,
    left_id: "left",
    right_id: "right",
    source_observation: SOURCE_OBSERVATION
  };
  return {
    ...body,
    receipt_digest: digestRecallFieldIdentity(body),
    ...override
  };
}
