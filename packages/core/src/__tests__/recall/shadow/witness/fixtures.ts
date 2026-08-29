import type {
  WitnessCompleteness,
  WitnessIdentityPins,
  WitnessProvenanceEntry
} from "../../../../recall/shadow/witness/index.js";

export const PINS: WitnessIdentityPins = {
  coordinate_id: "coord.witness.v1",
  query_id: "query-1",
  snapshot_digest: `sha256:${"a".repeat(64)}`,
  candidate_id: "cand-1"
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

export const COMPLETE: WitnessCompleteness = { owner: "named.completeness.owner.v1" };

export function pins(
  override: Partial<WitnessIdentityPins> = {}
): WitnessIdentityPins {
  return { ...PINS, ...override };
}
