import type {
  EventLogEntry,
  MemoryEntryMutableFields,
  PathAnchorRef,
  Proposal,
  SoulPendingProposalSummary,
  SynthesisCapsule
} from "@do-soul/alaya-protocol";

export interface McpMemoryProposalWorkflowEventLogRepo {
  append(event: Omit<EventLogEntry, "event_id" | "created_at" | "revision">): EventLogEntry | Promise<EventLogEntry>;
  queryByEntity(entityType: string, entityId: string): Promise<readonly EventLogEntry[]>;
}

export class SourceDeliveryAnchorValidationError extends Error {
  public readonly code = "VALIDATION";
}

export type ProposalResolutionEventInput = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;
export type ProposalCreationEventInput = Omit<EventLogEntry, "event_id" | "created_at" | "revision">;

export interface McpMemoryProposalWorkflowProposalRepo {
  create(input: {
    readonly proposal: Proposal;
    readonly workspace_id: string;
    readonly run_id: string | null;
    readonly target_object_kind?: string;
    readonly proposed_changes?: MemoryEntryMutableFields | null;
    readonly proposed_change_summary?: string;
    readonly created_at?: string;
    readonly target_baseline_updated_at?: string | null;
    readonly source_delivery_ids?: readonly string[] | null;
  }): Promise<Readonly<Proposal>>;
  createProposalWithEvents(
    input: {
      readonly proposal: Proposal;
      readonly workspace_id: string;
      readonly run_id: string | null;
      readonly target_object_kind?: string;
      readonly proposed_changes?: MemoryEntryMutableFields | null;
      readonly proposed_change_summary?: string;
      readonly created_at?: string;
      readonly target_baseline_updated_at?: string | null;
      readonly source_delivery_ids?: readonly string[] | null;
    },
    events: readonly ProposalCreationEventInput[],
    options?: {
      readonly reviewerAssignment?: {
        readonly proposal_id: string;
        readonly reviewer_identity: string;
        readonly assigned_at: string;
        readonly deadline_at?: string | null;
        readonly escalation_after_ms?: number | null;
      };
    }
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>>;
  findById(proposalId: string): Promise<Readonly<Proposal> | null>;
  findScopedById(proposalId: string): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly workspace_id: string;
    readonly run_id: string | null;
    readonly reviewer_identity?: string | null;
    readonly reviewer_assignment?: Readonly<{ readonly reviewer_identity: string }> | null;
    readonly target_object_id?: string | null;
    readonly target_object_kind?: string | null;
    readonly proposed_changes?: Readonly<MemoryEntryMutableFields> | null;
    readonly proposed_path_relation?: Readonly<{
      readonly target_anchor: PathAnchorRef;
      readonly constitution?: Readonly<{ readonly relation_kind?: string | null }> | null;
    }> | null;
    readonly target_baseline_updated_at?: string | null;
    readonly source_delivery_ids?: readonly string[] | null;
  }> | null>;
  findPendingSummaries(
    workspaceId: string,
    options?: {
      readonly since?: string | null;
      readonly limit?: number;
      readonly now?: string;
    }
  ): Promise<readonly Readonly<SoulPendingProposalSummary>[]>;
  acceptPendingMemoryUpdateWithEvents?(
    proposalId: string,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    memoryUpdate: {
      readonly target_object_id: string;
      readonly workspace_id: string;
      readonly proposed_changes: MemoryEntryMutableFields;
      readonly updated_at: string;
      readonly caused_by: string;
      readonly expected_baseline_updated_at?: string | null;
    },
    options?: { readonly reviewerIdentity?: string }
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>>;
  acceptPendingPathRelationGovernanceWithEvents?(
    proposalId: string,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    pathRelationGovernance: {
      readonly target_object_id: string;
      readonly workspace_id: string;
      readonly path_id_on_create: string;
      readonly updated_at: string;
      readonly caused_by: string;
    },
    options?: { readonly reviewerIdentity?: string }
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>>;
  acceptPendingSynthesisCreateWithEvents?(
    proposalId: string,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    synthesisCreate: {
      readonly workspace_id: string;
      readonly capsule: SynthesisCapsule;
      readonly caused_by: string;
    },
    options?: { readonly reviewerIdentity?: string }
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>>;
  updatePendingResolutionWithEvents(
    proposalId: string,
    state: Proposal["resolution_state"],
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    options?: { readonly reviewerIdentity?: string }
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>>;
}

export interface McpMemoryProposalWorkflowRuntimeNotifier {
  notifyEntry(entry: EventLogEntry): void | Promise<void>;
}
