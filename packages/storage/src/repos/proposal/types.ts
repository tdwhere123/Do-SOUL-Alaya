import type {
  EventLogEntry,
  MemoryEntry,
  MemoryEntryMutableFields,
  PathRelation,
  Proposal,
  ProposalResolutionState,
  SynthesisCapsule
} from "@do-soul/alaya-protocol";
import type { EventLogDraftInput } from "../shared/event-log-writer.js";

export interface ProposalCreateInput {
  readonly proposal: Proposal;
  readonly workspace_id: string;
  readonly run_id: string | null;
  // `target_object_kind` is required at the repository boundary.
  // Migration `058-reviewer-identity.sql` left
  // `target_object_kind TEXT NOT NULL DEFAULT 'memory_entry'` as a
  // one-time backfill for legacy rows; the default would silently
  // mislabel future inserts that omit the column. Type-system
  // enforcement is cheaper than dropping the SQL default (SQLite has
  // no `ALTER COLUMN ... DROP DEFAULT`). Production callers pass it
  // explicitly: `'memory_entry'` for `soul.propose_memory_update`
  // (apps/core-daemon/src/mcp-memory/proposal-workflow.ts), `'path_relation'` for the
  // strictly_governed promote endpoint
  // (apps/core-daemon/src/routes/proposals.ts), and `'bankruptcy_dossier'`
  // for the budget bankruptcy path (budget-wiring.ts).
  readonly target_object_kind: string;
  readonly proposed_change_summary?: string;
  readonly proposed_changes?: MemoryEntryMutableFields | null;
  readonly proposed_path_relation?: PathRelationProposalPayload | null;
  readonly created_at?: string;
  readonly target_baseline_updated_at?: string | null;
  readonly source_delivery_ids?: readonly string[] | null;
}

export interface PathRelationProposalPayload {
  readonly target_anchor: PathRelation["anchors"]["target_anchor"];
  readonly constitution: PathRelation["constitution"];
  readonly effect_vector: PathRelation["effect_vector"];
  readonly plasticity_state: PathRelation["plasticity_state"];
  readonly lifecycle: PathRelation["lifecycle"];
  readonly legitimacy: PathRelation["legitimacy"];
}

export interface ScopedProposal {
  readonly proposal: Readonly<Proposal>;
  readonly workspace_id: string;
  readonly run_id: string | null;
  readonly target_object_kind: string;
  // Null until the proposal is reviewed; carries the explicit
  // reviewer identity once review_memory_proposal completes.
  readonly reviewer_identity: string | null;
  readonly reviewer_assignment: Readonly<ProposalReviewerAssignment> | null;
  // Scoped governance payload for accept-as-apply workflow only. Intentionally
  // not exposed through the public Proposal
  // domain projection returned by findById/findPending.
  readonly proposed_changes: Readonly<MemoryEntryMutableFields> | null;
  readonly proposed_path_relation: Readonly<PathRelationProposalPayload> | null;
  readonly target_baseline_updated_at: string | null;
  readonly source_delivery_ids: readonly string[] | null;
}

export interface PendingProposalSummary {
  readonly proposal_id: string;
  readonly target_object_id: string;
  readonly target_object_kind: string;
  readonly created_at: string;
  readonly proposed_change_summary: string;
  readonly proposed_changes: Readonly<MemoryEntryMutableFields> | null;
  readonly assigned_reviewer_identity: string | null;
  readonly assigned_at: string | null;
  readonly deadline_at: string | null;
  readonly is_overdue: boolean;
}

export interface ProposalReviewerAssignmentInput {
  readonly proposal_id: string;
  readonly reviewer_identity: string;
  readonly assigned_at: string;
  readonly deadline_at?: string | null;
  readonly escalation_after_ms?: number | null;
}

export interface ProposalReviewerAssignment {
  readonly proposal_id: string;
  readonly reviewer_identity: string;
  readonly assigned_at: string;
  readonly deadline_at: string | null;
  readonly escalation_after_ms: number | null;
}

export interface FindPendingSummariesOptions {
  readonly since?: string | null;
  readonly limit?: number;
  readonly now?: string;
}

export interface ProposalListPageOptions {
  readonly limit: number;
  readonly offset: number;
}

export type ProposalResolutionEventInput = EventLogDraftInput;
export type ProposalCreationEventInput = EventLogDraftInput;

export const SQLITE_VARIABLE_CHUNK_SIZE = 900;

export interface UpdatePendingResolutionOptions {
  readonly reviewerIdentity?: string;
}

export interface AcceptedMemoryUpdateInput {
  readonly target_object_id: string;
  readonly workspace_id: string;
  readonly proposed_changes: MemoryEntryMutableFields;
  readonly updated_at: string;
  readonly caused_by: string;
  // Optional baseline snapshot of memory_entry.updated_at captured by
  // the workflow's pre-transaction read. When provided, the
  // accept-and-apply transaction asserts that the live memory is still
  // at this baseline before mutating; on mismatch it throws CONFLICT so
  // the workflow can surface "stale snapshot, re-review required".
  readonly expected_baseline_updated_at?: string | null;
}

export interface AcceptedPathRelationGovernanceInput {
  readonly target_object_id: string;
  readonly workspace_id: string;
  readonly path_id_on_create: string;
  readonly updated_at: string;
  readonly caused_by: string;
}

// invariant: the durable side of the librarian/auditor synthesis review
// accept-apply. The workflow fully composes the SynthesisCapsule (object_id,
// deterministic summary, evidence_refs recovered from the proposal's dropped
// candidate set, topic_key derived from `derived_from`) outside the
// transaction; this input only carries the pre-built capsule plus the
// proposal-resolve scope so the storage layer flips the proposal to accepted,
// inserts the capsule row, and appends SOUL_SYNTHESIS_CREATED in ONE
// transaction. caused_by attributes the resolve to `proposal_accept:<id>`.
// see also: apps/core-daemon/src/mcp-memory/proposal-workflow.ts synthesis_create branch
export interface AcceptedSynthesisCreateInput {
  readonly workspace_id: string;
  readonly capsule: SynthesisCapsule;
  readonly caused_by: string;
}

// The dossier_ref values that route a pending proposal to the synthesis-create
// accept-apply (librarian clusters + auditor pattern synthesis). Branching on
// dossier_ref is robust: these proposals carry no target_object_kind beyond the
// migration default, so the kind alone cannot distinguish them from a plain
// memory_entry update.
export const SYNTHESIS_CREATE_DOSSIER_REFS: ReadonlySet<string> = new Set([
  "librarian.synthesis",
  "bootstrapping.synthesis_candidate"
]);

export interface CreateProposalWithEventsOptions {
  readonly reviewerAssignment?: ProposalReviewerAssignmentInput;
}

export interface ProposalRepo {
  create(input: ProposalCreateInput): Promise<Readonly<Proposal>>;
  createProposalWithEvents(
    input: ProposalCreateInput,
    events: readonly ProposalCreationEventInput[],
    options?: CreateProposalWithEventsOptions
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>>;
  findById(proposalId: string): Promise<Readonly<Proposal> | null>;
  findScopedById(proposalId: string): Promise<Readonly<ScopedProposal> | null>;
  findByWorkspaceId(
    workspaceId: string,
    page?: ProposalListPageOptions
  ): Promise<readonly Readonly<Proposal>[]>;
  countByWorkspaceId(workspaceId: string): Promise<number>;
  findPending(
    workspaceId: string,
    page?: ProposalListPageOptions
  ): Promise<readonly Readonly<Proposal>[]>;
  // Cheap COUNT(*) for pending proposals in a workspace. Used by the soul
  // graph endpoint to report a true `node_total` independent of the
  // findPendingSummaries SQL `LIMIT` (otherwise the sampled-vs-complete
  // chip in the inspector would lie when more than `limit` pending
  // proposals exist).
  countPending(workspaceId: string): Promise<number>;
  countPendingMemoryTargetEdges(
    workspaceId: string,
    targetObjectIds: readonly string[]
  ): Promise<number>;
  findPendingSummaries(
    workspaceId: string,
    options?: FindPendingSummariesOptions
  ): Promise<readonly Readonly<PendingProposalSummary>[]>;
  findPendingByRunId(runId: string): Promise<Readonly<Proposal> | null>;
  assignReviewer(input: ProposalReviewerAssignmentInput): Promise<Readonly<ProposalReviewerAssignment>>;
  findReviewerAssignment(proposalId: string): Promise<Readonly<ProposalReviewerAssignment> | null>;
  // reviewerIdentity is optional at the repo boundary so legacy callers
  // (claim-promotion flows, fixtures) keep compiling, but every code path
  // that should write
  // resolution_state ∈ ('accepted','rejected') now passes it. The
  // SqliteProposalRepo writes the column when present and leaves it
  // untouched when omitted.
  updateResolution(
    proposalId: string,
    state: ProposalResolutionState,
    updatedAt: string,
    reviewerIdentity?: string
  ): Promise<Readonly<Proposal>>;
  updatePendingResolution(
    proposalId: string,
    state: ProposalResolutionState,
    updatedAt: string
  ): Promise<Readonly<Proposal>>;
  updatePendingResolutionWithEvents(
    proposalId: string,
    state: ProposalResolutionState,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    options?: UpdatePendingResolutionOptions
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>>;
  acceptPendingMemoryUpdateWithEvents(
    proposalId: string,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    memoryUpdate: AcceptedMemoryUpdateInput,
    options?: UpdatePendingResolutionOptions
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly memory: Readonly<MemoryEntry>;
    readonly events: readonly EventLogEntry[];
  }>>;
  acceptPendingPathRelationGovernanceWithEvents(
    proposalId: string,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    pathRelationGovernance: AcceptedPathRelationGovernanceInput,
    options?: UpdatePendingResolutionOptions
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly path_relation: Readonly<PathRelation>;
    readonly events: readonly EventLogEntry[];
  }>>;
  acceptPendingSynthesisCreateWithEvents(
    proposalId: string,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    synthesisCreate: AcceptedSynthesisCreateInput,
    options?: UpdatePendingResolutionOptions
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly synthesis: Readonly<SynthesisCapsule>;
    readonly events: readonly EventLogEntry[];
  }>>;
}
