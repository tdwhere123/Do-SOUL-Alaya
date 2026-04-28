export const sessionTrustStates = [
  "installed",
  "configured",
  "delivered",
  "used",
  "skipped",
  "unverifiable",
  "mixed"
] as const;
export type SessionTrustState = (typeof sessionTrustStates)[number];

export const contextDeliveryOutcomes = ["delivered", "skipped", "failed"] as const;
export type ContextDeliveryOutcome = (typeof contextDeliveryOutcomes)[number];

export const usageProofStrengths = ["explicit", "accepted", "weak", "unverifiable", "negative"] as const;
export type UsageProofStrength = (typeof usageProofStrengths)[number];

export const sessionTerminalStatuses = ["completed", "cancelled", "failed", "adapter_disconnected"] as const;
export type SessionTerminalStatus = (typeof sessionTerminalStatuses)[number];

export const memorySessionEventTypes = [
  "installed",
  "configured",
  "session_started",
  "context_requested",
  "context_delivered",
  "usage_proof_recorded",
  "proposal_recorded",
  "terminal_event",
  "trust_summary_generated"
] as const;
export type MemorySessionEventType = (typeof memorySessionEventTypes)[number];

export interface ContextDeliveryRecord {
  readonly delivery_id: string;
  readonly session_id: string;
  readonly run_id: string;
  readonly workspace_id: string;
  readonly context_pack_id: string;
  readonly target_agent: string;
  readonly profile_scope: string;
  readonly activation_mode: string;
  readonly outcome: ContextDeliveryOutcome;
  readonly memory_ids: readonly string[];
  readonly reason: string | null;
  readonly delivered_at: string;
  readonly source_ref: string;
  readonly evidence_refs: readonly string[];
}

export interface UsageProofRecord {
  readonly proof_id: string;
  readonly session_id: string;
  readonly run_id: string;
  readonly workspace_id: string;
  readonly context_pack_id: string;
  readonly memory_ids: readonly string[];
  readonly proof_strength: UsageProofStrength;
  readonly proof_source: string;
  readonly confidence: number;
  readonly observed_at: string;
  readonly summary: string;
  readonly source_ref: string;
  readonly evidence_refs: readonly string[];
}

export interface MemorySessionEventBase {
  readonly type: MemorySessionEventType;
  readonly event_id: string;
  readonly session_id: string;
  readonly run_id: string;
  readonly workspace_id: string;
  readonly agent_target: string;
  readonly profile_scope: string;
  readonly activation_mode: string;
  readonly recorded_at: string;
  readonly source_ref: string;
  readonly evidence_refs: readonly string[];
}

export interface InstalledSessionEvent extends MemorySessionEventBase {
  readonly type: "installed";
}

export interface ConfiguredSessionEvent extends MemorySessionEventBase {
  readonly type: "configured";
}

export interface SessionStartedEvent extends MemorySessionEventBase {
  readonly type: "session_started";
}

export interface ContextRequestedEvent extends MemorySessionEventBase {
  readonly type: "context_requested";
}

export interface ContextDeliveredEvent extends MemorySessionEventBase {
  readonly type: "context_delivered";
  readonly delivery: ContextDeliveryRecord;
}

export interface UsageProofRecordedEvent extends MemorySessionEventBase {
  readonly type: "usage_proof_recorded";
  readonly usage_proof: UsageProofRecord;
}

export interface ProposalRecordedEvent extends MemorySessionEventBase {
  readonly type: "proposal_recorded";
  readonly proposal_id: string;
}

export interface TerminalSessionEvent extends MemorySessionEventBase {
  readonly type: "terminal_event";
  readonly terminal_status: SessionTerminalStatus;
  readonly terminal_reason: string;
}

export interface TrustSummaryGeneratedEvent extends MemorySessionEventBase {
  readonly type: "trust_summary_generated";
  readonly summary_id: string;
}

export type MemorySessionEvent =
  | InstalledSessionEvent
  | ConfiguredSessionEvent
  | SessionStartedEvent
  | ContextRequestedEvent
  | ContextDeliveredEvent
  | UsageProofRecordedEvent
  | ProposalRecordedEvent
  | TerminalSessionEvent
  | TrustSummaryGeneratedEvent;

export interface TerminalEventSummary {
  readonly event_id: string;
  readonly status: SessionTerminalStatus;
  readonly reason: string;
  readonly recorded_at: string;
}

export interface TrustSummarySourceCounts {
  readonly event_count: number;
  readonly delivery_count: number;
  readonly proof_count: number;
}

export interface TrustSummary {
  readonly state: SessionTrustState;
  readonly session_id: string | null;
  readonly run_id: string | null;
  readonly workspace_id: string | null;
  readonly installed: boolean;
  readonly configured: boolean;
  readonly session_started: boolean;
  readonly delivered_count: number;
  readonly skipped_count: number;
  readonly failed_delivery_count: number;
  readonly used_proof_count: number;
  readonly weak_proof_count: number;
  readonly unverifiable_proof_count: number;
  readonly delivered_context_pack_ids: readonly string[];
  readonly delivered_memory_ids: readonly string[];
  readonly used_memory_ids: readonly string[];
  readonly unproved_memory_ids: readonly string[];
  readonly skipped_context_pack_ids: readonly string[];
  readonly delivery_evidence_refs: readonly string[];
  readonly delivery_source_refs: readonly string[];
  readonly usage_proof_ids: readonly string[];
  readonly usage_proof_evidence_refs: readonly string[];
  readonly usage_proof_source_refs: readonly string[];
  readonly terminal: TerminalEventSummary | null;
  readonly late_terminal_event_ids: readonly string[];
  readonly late_usage_proof_ids: readonly string[];
  readonly reasons: readonly string[];
  readonly generated_from: TrustSummarySourceCounts;
}
