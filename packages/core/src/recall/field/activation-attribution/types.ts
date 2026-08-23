import type { MemoryEntry, StorageTier } from "@do-soul/alaya-protocol";
import type { SliceCompatibilityInputV2 } from "../../flood/slice-key-selector.js";
import type { RecallQueryIntent } from "../../query/recall-query-plan.js";
import type {
  FloodAxisInactiveReason,
  RecallSupplementaryData
} from "../../runtime/recall-service-types.js";
import type { IntegratedFloodAxisInputs } from
  "../../scoring/integrated-flood-scoring.js";
import type { RecallQueryFieldAttributionReceipt } from
  "../query-attribution/query-field-attribution.js";
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
  "source_proximity",
  "guarded_update"
] as const);

export const ACTIVATION_ATTRIBUTION_STATUSES = Object.freeze([
  "not_applicable",
  "unavailable",
  "zero_match",
  "missing_attribution"
] as const);

export const ACTIVATION_ATTRIBUTION_FUEL_CHANNELS = Object.freeze([
  "slice_compatibility",
  "path_inflow",
  "evidence_support"
] as const);

export type ActivationAttributionChannel =
  typeof ACTIVATION_ATTRIBUTION_CHANNELS[number];
export type ActivationAttributionStatus =
  typeof ACTIVATION_ATTRIBUTION_STATUSES[number];
export type ActivationAttributionQueryShape = "t1" | "t2" | "t3";
export type ActivationAttributionFuelChannel =
  typeof ACTIVATION_ATTRIBUTION_FUEL_CHANNELS[number];

export type ActivationAttributionReason =
  | "empty_query"
  | "no_gold_surface"
  | "no_gold_surface_overlap"
  | "gold_surface_overlap"
  | "query_attribution_unobserved"
  | "receipt_attribution_partial"
  | "slice_unobserved"
  | "slice_pass_through"
  | "slice_no_match"
  | "slice_attributed_fuel"
  | "path_unobserved"
  | "path_not_eligible"
  | "path_index_unavailable"
  | "path_pass_through"
  | "path_no_fuel"
  | "path_attributed_fuel"
  | "evidence_unobserved"
  | "evidence_pass_through"
  | "evidence_no_support"
  | "evidence_attributed_fuel"
  | "no_date_language"
  | "date_not_flood_fuel"
  | "no_speaker_probe"
  | "proximity_unobserved"
  | "proximity_not_hot_substrate"
  | "proximity_no_seeds"
  | "proximity_no_neighbors"
  | "neighbor_not_flood_fuel"
  | "no_update_language"
  | "guarded_update_not_flood_fuel";

export type ActivationAttributionChannelReceipt = Readonly<{
  readonly channel: ActivationAttributionChannel;
  readonly status: ActivationAttributionStatus;
  readonly reason: ActivationAttributionReason;
  readonly counts_as_fuel: boolean;
  readonly flood_axis_status: FloodAxisInactiveReason | null;
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

export type ActivationAttributionProximityObservation = Readonly<{
  readonly tier: StorageTier;
  readonly seed_count: number;
  readonly neighbor_count: number;
}>;

export type ActivationAttributionFloodObservation = Readonly<{
  readonly entry: Readonly<MemoryEntry>;
  readonly axisInputs: IntegratedFloodAxisInputs;
  readonly supplementaryData: RecallSupplementaryData;
  readonly memorySupplementEligible?: boolean;
}>;

export type ActivationAttributionAuditRow = Readonly<{
  readonly query_id: string;
  readonly query_shape: ActivationAttributionQueryShape;
  readonly query_text: string;
  readonly gold_surface?: string | null;
  readonly query_field_attribution?: RecallQueryFieldAttributionReceipt;
  readonly flood?: ActivationAttributionFloodObservation;
  readonly slice?: SliceCompatibilityInputV2;
  readonly source_proximity?: ActivationAttributionProximityObservation;
}>;

export type ActivationAttributionAuditReceipt = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof ACTIVATION_ATTRIBUTION_OPERATOR_ID;
  readonly query_id: string;
  readonly query_shape: ActivationAttributionQueryShape;
  readonly query_text: string;
  readonly intent: RecallQueryIntent;
  readonly fuel_verified: boolean | null;
  readonly channels: readonly Readonly<ActivationAttributionChannelReceipt>[];
  readonly char_ngram_consumer: CharNgramConsumerFact;
  readonly source_proximity_consumer: SourceProximityConsumerFact;
  readonly receipt_digest: RecallFieldDigest;
}>;
