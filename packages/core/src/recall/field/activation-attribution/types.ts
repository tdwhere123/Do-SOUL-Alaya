import type { StorageTier } from "@do-soul/alaya-protocol";
import type { RecallFieldDigest } from "../field-identity.js";

export const ACTIVATION_ATTRIBUTION_OPERATOR_ID =
  "activation_flood_attribution_audit_v1";

export const ACTIVATION_ATTRIBUTION_CHANNELS = Object.freeze([
  "query_probes",
  "slice_compatibility",
  "path_inflow",
  "evidence_support",
  "date",
  "speaker",
  "source_proximity"
] as const);

export const ACTIVATION_ATTRIBUTION_STATUSES = Object.freeze([
  "not_applicable",
  "unavailable",
  "zero_match",
  "missing_attribution"
] as const);

export type ActivationAttributionChannel =
  typeof ACTIVATION_ATTRIBUTION_CHANNELS[number];
export type ActivationAttributionStatus =
  typeof ACTIVATION_ATTRIBUTION_STATUSES[number];
export type ActivationAttributionQueryShape = "t1" | "t2" | "t3";

export type ActivationAttributionReason =
  | "empty_query"
  | "no_gold_surface"
  | "no_retrieval_probe_overlap"
  | "receipt_attribution_partial"
  | "slice_unobserved"
  | "slice_pass_through"
  | "slice_no_match"
  | "path_unobserved"
  | "path_not_eligible"
  | "path_index_unavailable"
  | "path_no_inflow"
  | "path_no_fuel"
  | "path_attributed_fuel"
  | "evidence_unobserved"
  | "evidence_vectors_absent"
  | "evidence_no_support"
  | "evidence_attributed_fuel"
  | "no_date_language"
  | "date_not_flood_fuel"
  | "no_speaker_language"
  | "speaker_not_flood_fuel"
  | "proximity_unobserved"
  | "proximity_not_hot_substrate"
  | "proximity_no_seeds"
  | "proximity_no_neighbors"
  | "neighbor_not_flood_fuel";

export type ActivationAttributionChannelReceipt = Readonly<{
  readonly channel: ActivationAttributionChannel;
  readonly status: ActivationAttributionStatus;
  readonly reason: ActivationAttributionReason;
}>;

export type CharNgramConsumerFact = Readonly<{
  readonly compiled: true;
  readonly retrieval_consumer: "none";
}>;

export type SourceProximityConsumerFact = Readonly<{
  readonly substrate: typeof StorageTier.HOT;
  readonly radius: number;
  readonly seed_cap: number;
  readonly admission_cap: number;
}>;

export type ActivationAttributionPathObservation = Readonly<{
  readonly eligible: boolean;
  readonly availability?: "unavailable" | "storage_error" | "observed";
  readonly inflow_count?: number;
  readonly a_path?: number;
}>;

export type ActivationAttributionEvidenceObservation = Readonly<{
  readonly vectors_present: boolean;
  readonly support?: number;
}>;

export type ActivationAttributionProximityObservation = Readonly<{
  readonly tier: StorageTier;
  readonly seed_count: number;
  readonly neighbor_count: number;
}>;

export type ActivationAttributionAuditRow = Readonly<{
  readonly query_id: string;
  readonly query_shape: ActivationAttributionQueryShape;
  readonly query_text: string;
  readonly gold_surface?: string | null;
  readonly slice?: "pass_through" | "rejected";
  readonly path?: ActivationAttributionPathObservation;
  readonly evidence?: ActivationAttributionEvidenceObservation;
  readonly source_proximity?: ActivationAttributionProximityObservation;
}>;

export type ActivationAttributionAuditReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof ACTIVATION_ATTRIBUTION_OPERATOR_ID;
  readonly query_id: string;
  readonly query_shape: ActivationAttributionQueryShape;
  readonly query_text: string;
  readonly channels: readonly Readonly<ActivationAttributionChannelReceipt>[];
  readonly char_ngram_consumer: CharNgramConsumerFact;
  readonly source_proximity_consumer: SourceProximityConsumerFact;
  readonly receipt_digest: RecallFieldDigest;
}>;
