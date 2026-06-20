export interface HealthIssueGroupRow {
  readonly group_id: string;
  readonly workspace_id: string;
  readonly target_object_id: string;
  readonly target_object_kind: string;
  readonly cause_kind: HealthIssueCauseKind;
  readonly severity: HealthIssueSeverity;
  readonly confidence: number;
  readonly first_seen_at: string;
  readonly last_seen_at: string;
  readonly count: number;
  readonly suggested_actions: readonly string[];
  readonly resolution_state: HealthIssueResolutionState;
  readonly resolved_at: string | null;
  readonly resolved_by: string | null;
}

export interface HealthInboxEnvelope {
  readonly success: boolean;
  readonly data: {
    readonly workspace_id: string;
    readonly groups: readonly HealthIssueGroupRow[];
    readonly total_count: number;
  };
}

export type HealthIssueCauseKind =
  | "orphan_radar"
  | "green_revoked"
  | "evidence_failure"
  | "path_relation_failure";
export type HealthIssueSeverity = "info" | "warn" | "blocking";
export type HealthIssueResolutionState = "pending" | "resolved" | "suppressed";

export type StateFilter = "all" | HealthIssueResolutionState;
export type CauseFilter = "all" | HealthIssueCauseKind;

export const STATE_OPTIONS: ReadonlyArray<StateFilter> = [
  "all",
  "pending",
  "resolved",
  "suppressed"
];

export const CAUSE_OPTIONS: ReadonlyArray<CauseFilter> = [
  "all",
  "orphan_radar",
  "green_revoked",
  "evidence_failure",
  "path_relation_failure"
];

export const SEVERITY_BADGE: Readonly<Record<HealthIssueSeverity, string>> = {
  blocking: "bg-state-error/15 text-state-error border-state-error/40",
  warn: "bg-state-warning/15 text-state-warning border-state-warning/40",
  info: "bg-beige-200 text-ink-600 border-beige-300"
};
