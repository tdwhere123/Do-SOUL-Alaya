import {
  createBindingRelationWitness,
  createCorrelationWitness,
  type BindingRelationState,
  type BindingRelationWitness,
  type CorrelationState,
  type CorrelationWitness,
  type WitnessIdentityPins,
  type WitnessProvenanceEntry
} from "../../../../recall/shadow/witness/index.js";

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

export function alias(
  left: string,
  right: string,
  state: BindingRelationState
): BindingRelationWitness {
  const payload = {
    left_id: left,
    right_id: right,
    state,
    ...(state === "distinct" ? {
      distinctness_receipt: {
        schema_version: 1 as const,
        operator_id: "binding_distinctness_evidence_v1" as const,
        query_id: PINS.query_id,
        snapshot_digest: PINS.snapshot_digest,
        left_id: left,
        right_id: right,
        source_id: PROV[0]!.source_id,
        producer: PROV[0]!.producer
      }
    } : {})
  };
  return createBindingRelationWitness({
    identity: PINS,
    provenance: PROV,
    epistemic: { kind: "exact" },
    payload
  });
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
