import {
  HealthIssueCauseKindSchema,
  type HealthIssueGroup
} from "@do-soul/alaya-protocol";

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
    readonly returned_count?: number;
    readonly total_count?: number;
  };
}

export function healthInboxReturnedCount(data: HealthInboxEnvelope["data"]): number {
  return data.returned_count ?? data.groups.length;
}

export type HealthIssueCauseKind = HealthIssueGroup["cause_kind"];
export type HealthIssueSeverity = HealthIssueGroup["severity"];
export type HealthIssueResolutionState = HealthIssueGroup["resolution_state"];

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
  ...HealthIssueCauseKindSchema.options
];

export const SEVERITY_BADGE: Readonly<Record<HealthIssueSeverity, string>> = {
  blocking: "bg-state-error/15 text-state-error border-state-error/40",
  warn: "bg-state-warning/15 text-state-warning border-state-warning/40",
  info: "bg-beige-200 text-ink-600 border-beige-300"
};
