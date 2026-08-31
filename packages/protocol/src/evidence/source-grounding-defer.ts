export const SOURCE_GROUNDING_DEFER_QUEUE_CAP = 2_048;
export const SOURCE_GROUNDING_DEFER_QUEUE_OVERFLOW_ALLOWANCE = 1;

export const sourceGroundingDeferReasons = [
  "matched_text_absent",
  "matched_text_ambiguous",
  "source_grounding_missing",
  "source_grounding_rejected",
  "source_assertion_incomplete",
  "source_assertion_not_self_contained",
  "source_assertion_too_long"
] as const;

export type SourceGroundingDeferReason = typeof sourceGroundingDeferReasons[number];
export type SourceGroundingDeferAdmissionState = "ready" | "capacity_blocked";
export type SourceGroundingDeferCapacityState = "ready" | "saturated";

export interface SourceGroundingDeferEntry {
  readonly signal_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly defer_reason: SourceGroundingDeferReason;
  readonly enqueued_at: string;
  readonly claim_token_fingerprint: string | null;
  readonly claim_expires_at: string | null;
  readonly admission_state: SourceGroundingDeferAdmissionState;
}

export interface SourceGroundingDeferEnqueueInput {
  readonly signal_id: string;
  readonly workspace_id: string;
  readonly run_id: string;
  readonly defer_reason: SourceGroundingDeferReason;
  readonly enqueued_at?: string;
}

export interface SourceGroundingDeferEnqueueResult {
  readonly entry: SourceGroundingDeferEntry;
  readonly evicted: SourceGroundingDeferEntry | null;
}

export interface SourceGroundingDeferStats {
  readonly queue_depth: number;
  /** Compatibility alias; the limit applies independently per workspace. */
  readonly queue_cap: number;
  readonly queue_cap_per_workspace: number;
  readonly queue_hard_limit_per_workspace: number;
  readonly queue_scope: "workspace" | "aggregate";
  readonly claimable_depth: number;
  readonly capacity_blocked_depth: number;
  readonly capacity_state: SourceGroundingDeferCapacityState;
  readonly deferred_by_reason: Readonly<Partial<Record<SourceGroundingDeferReason, number>>>;
}

export function isSourceGroundingDeferReason(value: string): value is SourceGroundingDeferReason {
  return (sourceGroundingDeferReasons as readonly string[]).includes(value);
}
