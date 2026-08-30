import type {
  WitnessCompleteness,
  WitnessIdentityPins,
  WitnessProvenanceEntry
} from "../../../../../recall/decision/query-proof/witness/index.js";

export const PINS: WitnessIdentityPins = {
  coordinate_id: "coord.witness.v1",
  query_id: "query-1",
  snapshot_digest: `sha256:${"a".repeat(64)}`,
  observer_id: "observer.numeric.interval.v1",
  candidate_id: "cand-1",
  universe_digest: `sha256:${"b".repeat(64)}`
};

export const PROPOSITION_PINS: WitnessIdentityPins = {
  coordinate_id: "coord.proposition.v1",
  query_id: "query-1",
  snapshot_digest: `sha256:${"a".repeat(64)}`,
  proposition_id: "prop-1"
};

export const PAIR_PINS: WitnessIdentityPins = {
  coordinate_id: "coord.pair.v1",
  query_id: "query-1",
  snapshot_digest: `sha256:${"a".repeat(64)}`
};

export const PROV: readonly WitnessProvenanceEntry[] = Object.freeze([
  Object.freeze({ source_id: "src-1", producer: "producer.alpha" })
]);

export const PROV_EXTENDED: readonly WitnessProvenanceEntry[] = Object.freeze([
  Object.freeze({ source_id: "src-1", producer: "producer.alpha" }),
  Object.freeze({ source_id: "src-2", producer: "producer.beta" })
]);

export const UNISSUED_COMPLETENESS: WitnessCompleteness = Object.freeze({
  schema_version: 1,
  receipt_id: "recall.witness.completeness.v1",
  authority_id: "authority.not-admitted.v1",
  authority_digest: `sha256:${"c".repeat(64)}`,
  owner: "named.completeness.owner.v1",
  observer_id: PINS.observer_id!,
  coordinate_id: PINS.coordinate_id,
  query_id: PINS.query_id,
  snapshot_digest: PINS.snapshot_digest,
  candidate_id: PINS.candidate_id!,
  universe_digest: PINS.universe_digest!,
  domain: "numeric_interval",
  receipt_digest: `sha256:${"d".repeat(64)}`
});

export function pins(
  override: Partial<WitnessIdentityPins> = {}
): WitnessIdentityPins {
  return { ...PINS, ...override };
}
