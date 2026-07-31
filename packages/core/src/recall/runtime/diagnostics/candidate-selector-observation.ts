import type { MemoryEntry, PathAnchorRef } from "@do-soul/alaya-protocol";

export type RecallSelectorEvidenceDirectness =
  | "direct_document"
  | "referenced"
  | "none"
  | "unresolved";

export type RecallSelectorEvidenceAuthority =
  | "verified_user_assertion"
  | "verified_user_projection"
  | "unverified"
  | "none";

export type RecallSelectorEvidenceValidity =
  | "behavior_eligible"
  | "recall_qualified"
  | "observed_reference"
  | "unresolved"
  | "none";

export type RecallSelectorEventStatus =
  | "asserted"
  | "prospective"
  | "negated"
  | "reversed"
  | "unknown"
  | "not_observed";

export type RecallSelectorTemporalCompatibility =
  | "not_requested"
  | "compatible"
  | "conflicted"
  | "unknown"
  | "not_observed";

export interface RecallSelectorPathReceipt {
  readonly receipt_status: "complete" | "partial";
  readonly path_id: string | null;
  readonly relation_kind: string | null;
  readonly source_object_id: string | null;
  readonly target_object_id: string | null;
  readonly source_anchor: Readonly<PathAnchorRef> | null;
  readonly target_anchor: Readonly<PathAnchorRef> | null;
  readonly source_version: string | null;
  readonly edge_conductance: number | null;
}

export interface RecallCandidateSelectorObservation {
  readonly schema_version: 1;
  readonly evidence: Readonly<{
    readonly directness: RecallSelectorEvidenceDirectness;
    readonly authority: RecallSelectorEvidenceAuthority;
    readonly validity: RecallSelectorEvidenceValidity;
    readonly document_identity: string | null;
    readonly evidence_refs: readonly string[];
    readonly event_status: RecallSelectorEventStatus;
    readonly preference_polarity: MemoryEntry["preference_polarity"] | null;
  }>;
  readonly temporal: Readonly<{
    readonly compatibility: RecallSelectorTemporalCompatibility;
    readonly event_time_start: string | null;
    readonly event_time_end: string | null;
    readonly valid_from: string | null;
    readonly valid_to: string | null;
    readonly time_precision: MemoryEntry["time_precision"] | null;
    readonly time_source: MemoryEntry["time_source"] | null;
  }>;
  readonly coverage: Readonly<{ readonly marginal_gain: number | null }>;
  readonly path: Readonly<{
    readonly status: "not_observed" | "unavailable" | "none" | "partial" | "complete";
    readonly receipts: readonly Readonly<RecallSelectorPathReceipt>[];
  }>;
}
