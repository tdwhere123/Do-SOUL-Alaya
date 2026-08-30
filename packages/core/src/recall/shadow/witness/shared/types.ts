export const WITNESS_DOMAIN_KINDS = [
  "numeric_interval",
  "must_may_set",
  "binding_relation",
  "temporal_bitemporal",
  "four_valued_proposition",
  "correlation_partition",
  "membership_frontier"
] as const;

export type WitnessDomainKind = (typeof WITNESS_DOMAIN_KINDS)[number];

export type WitnessIdentityPins = Readonly<{
  readonly coordinate_id: string;
  readonly query_id: string;
  readonly snapshot_digest: string;
  readonly observer_id?: string;
  readonly candidate_id?: string;
  readonly universe_digest?: string;
  readonly proposition_id?: string;
}>;

export type WitnessIdentityPinKey = keyof WitnessIdentityPins;

export type WitnessProvenanceEntry = Readonly<{
  readonly source_id: string;
  readonly producer: string;
}>;

export type WitnessCompleteness = Readonly<{
  readonly schema_version: 1;
  readonly receipt_id: "recall.witness.completeness.v1";
  readonly authority_id: string;
  readonly authority_digest: string;
  readonly owner: string;
  readonly observer_id: string;
  readonly coordinate_id: string;
  readonly query_id: string;
  readonly snapshot_digest: string;
  readonly candidate_id: string;
  readonly universe_digest: string;
  readonly domain: WitnessDomainKind;
  readonly receipt_digest: string;
}>;

export type WitnessEpistemic =
  | Readonly<{ readonly kind: "exact" }>
  | Readonly<{
      readonly kind: "exact";
      readonly known_zero: true;
      readonly completeness: WitnessCompleteness;
    }>
  | Readonly<{ readonly kind: "unavailable" }>
  | Readonly<{ readonly kind: "not_observed" }>
  | Readonly<{ readonly kind: "not_applicable" }>
  | Readonly<{
      readonly kind: "negative";
      readonly named_negative: string;
    }>
  | Readonly<{ readonly kind: "conflict" }>;

export type WitnessEpistemicKind = WitnessEpistemic["kind"];

export type TypedWitness<K extends WitnessDomainKind, P> = Readonly<{
  readonly domain: K;
  readonly identity: WitnessIdentityPins;
  readonly provenance: readonly WitnessProvenanceEntry[];
  readonly epistemic: WitnessEpistemic;
  readonly payload: P | null;
}>;

export type WitnessInformationOrder =
  | "equal"
  | "narrower"
  | "wider"
  | "incomparable";

export type WitnessCreateInput<P> = Readonly<{
  readonly identity: WitnessIdentityPins;
  readonly provenance: readonly WitnessProvenanceEntry[];
  readonly epistemic: WitnessEpistemic;
  readonly payload?: P | null;
}>;
