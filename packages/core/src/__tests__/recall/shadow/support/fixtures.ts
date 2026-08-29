import {
  createBindingRelationWitness,
  createCorrelationWitness,
  type BindingRelationState,
  type BindingRelationWitness,
  type BindingSourceObservationReceiptV1,
  type CorrelationState,
  type CorrelationWitness,
  type WitnessIdentityPins,
  type WitnessProvenanceEntry
} from "../../../../recall/shadow/witness/index.js";
import { digestRecallFieldIdentity } from
  "../../../../recall/field/field-identity.js";

export const SNAPSHOT = `sha256:${"b".repeat(64)}`;
export const QUERY = "query-support-1";

export const PINS: WitnessIdentityPins = {
  coordinate_id: "coord.support.v1",
  query_id: QUERY,
  snapshot_digest: SNAPSHOT
};

export const PROV: readonly WitnessProvenanceEntry[] = Object.freeze([
  Object.freeze({ source_id: "src-support", producer: "producer.support" })
]);

const RELATION_OBSERVATION_BODY = Object.freeze({
  schema_version: 1 as const,
  source_owner: "support_fixture_registry",
  source_observation_id: "support-binding-observation-1",
  source_id: PROV[0]!.source_id,
  producer_operator_id: PROV[0]!.producer,
  producer_operator_version: "1"
});
const RELATION_OBSERVATION = Object.freeze({
  ...RELATION_OBSERVATION_BODY,
  observation_digest: digestRecallFieldIdentity(RELATION_OBSERVATION_BODY)
});
export const RELATION_VERIFIER = Object.freeze({
  source_owner: RELATION_OBSERVATION.source_owner,
  producer_operator_id: RELATION_OBSERVATION.producer_operator_id,
  producer_operator_version: RELATION_OBSERVATION.producer_operator_version,
  verifySourceObservation(receipt: BindingSourceObservationReceiptV1): boolean {
    const { observation_digest, ...body } = receipt;
    return observation_digest === RELATION_OBSERVATION.observation_digest
      && digestRecallFieldIdentity(body) === observation_digest;
  }
});

export function alias(
  left: string,
  right: string,
  state: BindingRelationState
): BindingRelationWitness {
  const payload = {
    left_id: left,
    right_id: right,
    state,
    ...((state === "equal" || state === "distinct") ? {
      relation_evidence_receipt: relationReceipt(left, right, state)
    } : {})
  };
  return createBindingRelationWitness({
    identity: PINS,
    provenance: PROV,
    epistemic: { kind: "exact" },
    payload,
    evidence_verifier: RELATION_VERIFIER
  });
}

function relationReceipt(left: string, right: string, relation: "equal" | "distinct") {
  const [left_id, right_id] = left <= right ? [left, right] : [right, left];
  const body = {
    schema_version: 1 as const,
    operator_id: "binding_relation_evidence_v1" as const,
    relation,
    query_id: PINS.query_id,
    snapshot_digest: PINS.snapshot_digest,
    left_id,
    right_id,
    source_observation: RELATION_OBSERVATION
  };
  return Object.freeze({ ...body, receipt_digest: digestRecallFieldIdentity(body) });
}

export function correlation(
  left: string,
  right: string,
  state: CorrelationState
): CorrelationWitness {
  return createCorrelationWitness({
    identity: PINS,
    provenance: PROV,
    epistemic: { kind: "exact" },
    payload: { left_id: left, right_id: right, state }
  });
}
