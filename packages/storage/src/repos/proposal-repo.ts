import {
  GreenGovernanceEventType,
  MemoryGovernanceEventType,
  PathGovernanceClass,
  PathRelationSchema,
  ProposalResolutionStateSchema,
  ProposalSchema,
  PublicMemoryEntryMutableFieldsSchema,
  RevokeReason,
  RuntimeGovernanceEventType,
  SoulGreenPiercedPayloadSchema,
  SoulMemoryUpdatedPayloadSchema,
  SoulSynthesisCreatedPayloadSchema,
  SynthesisCapsuleSchema,
  parseRuntimeGovernanceEventPayload,
  serializePathAnchorRef,
  type EventLogEntry,
  type MemoryEntry,
  type MemoryEntryMutableFields,
  type PathRelation,
  type Proposal,
  type ProposalResolutionState,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import {
  getEventLogWriter,
  insertEventLogEntry,
  type EventLogDraftInput
} from "./shared/event-log-writer.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import {
  MEMORY_ENTRY_SELECT_COLUMNS,
  parseMemoryEntryRow,
  parseUpdateFields,
  type MemoryEntryRow
} from "./memory-entry-row-mapper.js";
import { parseNonEmptyString, parseNullableString, parseTimestamp } from "./shared/validators.js";

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
  // (mcp-memory-proposal-workflow.ts), `'path_relation'` for the
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

export type ProposalResolutionEventInput = EventLogDraftInput;
export type ProposalCreationEventInput = EventLogDraftInput;

const SQLITE_VARIABLE_CHUNK_SIZE = 900;

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
// see also: apps/core-daemon/src/mcp-memory-proposal-workflow.ts synthesis_create branch
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
const SYNTHESIS_CREATE_DOSSIER_REFS: ReadonlySet<string> = new Set([
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
  findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<Proposal>[]>;
  findPending(workspaceId: string): Promise<readonly Readonly<Proposal>[]>;
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

const PROPOSAL_SELECT_COLUMNS = `
        runtime_id,
        object_kind,
        proposal_id,
        task_surface_ref,
        derived_from,
        retention_policy,
        dossier_ref,
        recommended_option_id,
        proposal_options,
        resolution_state,
        expires_at,
        last_updated_at,
        workspace_id,
        run_id,
        reviewer_identity,
        target_object_kind,
        proposed_change_summary,
        proposed_changes,
        proposed_path_relation,
        created_at,
        target_baseline_updated_at,
        source_delivery_ids
`;

interface ProposalRow {
  readonly runtime_id: string;
  readonly object_kind: string;
  readonly proposal_id: string;
  readonly task_surface_ref: string | null;
  readonly derived_from: string | null;
  readonly retention_policy: string;
  readonly dossier_ref: string | null;
  readonly recommended_option_id: string | null;
  readonly proposal_options: string;
  readonly resolution_state: string;
  readonly expires_at: string | null;
  readonly last_updated_at: string;
  // Scope metadata is available for workspace validation, not exposed in domain type.
  readonly workspace_id: string;
  readonly run_id: string | null;
  // Review identity + HITL summary projection columns.
  readonly reviewer_identity: string | null;
  readonly target_object_kind: string;
  readonly proposed_change_summary: string;
  readonly proposed_changes: string | null;
  readonly proposed_path_relation: string | null;
  readonly created_at: string | null;
  readonly target_baseline_updated_at: string | null;
  readonly source_delivery_ids: string | null;
}

interface ProposalPathRelationRow {
  readonly path_id: string;
  readonly workspace_id: string;
  readonly anchors_json: string;
  readonly constitution_json: string;
  readonly effect_vector_json: string;
  readonly plasticity_state_json: string;
  readonly lifecycle_json: string;
  readonly legitimacy_json: string;
  readonly created_at: string;
  readonly updated_at: string;
}

interface ProposalReviewerAssignmentRow {
  readonly proposal_id: string;
  readonly reviewer_identity: string;
  readonly assigned_at: string;
  readonly deadline_at: string | null;
  readonly escalation_after_ms: number | null;
}

interface PendingProposalSummaryRow extends ProposalRow {
  readonly assigned_reviewer_identity: string | null;
  readonly assigned_at: string | null;
  readonly deadline_at: string | null;
  readonly is_overdue: 0 | 1;
}

interface RevokableGreenStatusRow {
  readonly object_id: string;
}

export class SqliteProposalRepo implements ProposalRepo {
  private readonly createStatement;
  private readonly findByIdStatement;
  private readonly findByWorkspaceIdStatement;
  private readonly findPendingStatement;
  private readonly countPendingStatement;
  private readonly findPendingByRunIdStatement;
  private readonly assignReviewerStatement;
  private readonly findReviewerAssignmentStatement;
  private readonly updateResolutionStatement;
  private readonly updateResolutionWithIdentityStatement;
  private readonly updatePendingResolutionStatement;
  private readonly updatePendingResolutionWithIdentityStatement;
  private readonly findMemoryEntryByIdStatement;
  private readonly updateMemoryEntryStatement;
  private readonly findRevokableGreenStatusStatement;
  private readonly revokeGreenStatusStatement;
  private readonly findPathRelationByAnchorMemoryIdStatement;
  private readonly createPathRelationStatement;
  private readonly updatePathRelationLegitimacyStatement;
  // see also: synthesis-capsule-repo.ts SqliteSynthesisCapsuleRepo.createStatement
  // — the same INSERT column order, prepared here so the synthesis-create
  // accept-apply can insert the capsule inside the proposal-resolve transaction.
  private readonly createSynthesisCapsuleStatement;
  private readonly eventLogWriter;

  public constructor(private readonly db: StorageDatabase) {
    // INSERT also writes the HITL projection columns
    // (target_object_kind, proposed_change_summary, created_at).
    // Defaults from migration 058 keep legacy callers compatible if
    // they pass undefined for those fields.
    this.createStatement = db.connection.prepare(`
      INSERT INTO proposals (
        runtime_id,
        object_kind,
        proposal_id,
        task_surface_ref,
        derived_from,
        retention_policy,
        dossier_ref,
        recommended_option_id,
        proposal_options,
        resolution_state,
        expires_at,
        last_updated_at,
        workspace_id,
        run_id,
        target_object_kind,
        proposed_change_summary,
        proposed_changes,
        proposed_path_relation,
        created_at,
        target_baseline_updated_at,
        source_delivery_ids
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.findByIdStatement = db.connection.prepare(`
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE proposal_id = ?
      LIMIT 1
    `);

    this.findByWorkspaceIdStatement = db.connection.prepare(`
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE workspace_id = ?
      ORDER BY last_updated_at DESC, proposal_id DESC
    `);

    this.findPendingStatement = db.connection.prepare(`
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE workspace_id = ? AND resolution_state = 'pending'
      ORDER BY last_updated_at DESC, proposal_id DESC
    `);

    this.countPendingStatement = db.connection.prepare(`
      SELECT COUNT(*) AS total
      FROM proposals
      WHERE workspace_id = ? AND resolution_state = 'pending'
    `);

    this.findPendingByRunIdStatement = db.connection.prepare(`
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE run_id = ? AND resolution_state = 'pending' AND dossier_ref IS NOT NULL
      ORDER BY last_updated_at DESC, proposal_id DESC
      LIMIT 1
    `);

    this.assignReviewerStatement = db.connection.prepare(`
      INSERT INTO proposal_reviewer_assignments (
        proposal_id,
        reviewer_identity,
        assigned_at,
        deadline_at,
        escalation_after_ms
      ) VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(proposal_id) DO UPDATE SET
        reviewer_identity = excluded.reviewer_identity,
        assigned_at = excluded.assigned_at,
        deadline_at = excluded.deadline_at,
        escalation_after_ms = excluded.escalation_after_ms
    `);

    this.findReviewerAssignmentStatement = db.connection.prepare(`
      SELECT
        proposal_id,
        reviewer_identity,
        assigned_at,
        deadline_at,
        escalation_after_ms
      FROM proposal_reviewer_assignments
      WHERE proposal_id = ?
      LIMIT 1
    `);

    this.updateResolutionStatement = db.connection.prepare(`
      UPDATE proposals
      SET resolution_state = ?, last_updated_at = ?
      WHERE proposal_id = ?
    `);

    // Companion statement for the legacy updateResolution path that
    // also persists reviewer_identity.
    this.updateResolutionWithIdentityStatement = db.connection.prepare(`
      UPDATE proposals
      SET resolution_state = ?, last_updated_at = ?, reviewer_identity = ?
      WHERE proposal_id = ?
    `);

    this.updatePendingResolutionStatement = db.connection.prepare(`
      UPDATE proposals
      SET resolution_state = ?, last_updated_at = ?
      WHERE proposal_id = ? AND resolution_state = 'pending'
    `);

    this.updatePendingResolutionWithIdentityStatement = db.connection.prepare(`
      UPDATE proposals
      SET resolution_state = ?, last_updated_at = ?, reviewer_identity = ?
      WHERE proposal_id = ? AND resolution_state = 'pending'
    `);

    this.findMemoryEntryByIdStatement = db.connection.prepare(`
      SELECT${MEMORY_ENTRY_SELECT_COLUMNS}
      FROM memory_entries
      WHERE object_id = ?
      LIMIT 1
    `);

    this.updateMemoryEntryStatement = db.connection.prepare(`
      UPDATE memory_entries
      SET
        content = COALESCE(?, content),
        domain_tags = COALESCE(?, domain_tags),
        evidence_refs = COALESCE(?, evidence_refs),
        storage_tier = COALESCE(?, storage_tier),
        confidence = COALESCE(?, confidence),
        retention_state = COALESCE(?, retention_state),
        updated_at = ?
      WHERE object_id = ?
    `);

    this.findRevokableGreenStatusStatement = db.connection.prepare(`
      SELECT object_id
      FROM green_statuses
      WHERE target_object_id = ?
        AND workspace_id = ?
        AND green_state IN ('eligible', 'grace')
      LIMIT 1
    `);

    this.revokeGreenStatusStatement = db.connection.prepare(`
      UPDATE green_statuses
      SET
        green_state = 'revoked',
        revoke_reason = ?,
        updated_at = ?,
        last_transition_at = ?
      WHERE object_id = ?
        AND target_object_id = ?
        AND workspace_id = ?
        AND green_state IN ('eligible', 'grace')
    `);

    this.findPathRelationByAnchorMemoryIdStatement = db.connection.prepare(`
      SELECT
        path_id,
        workspace_id,
        anchors_json,
        constitution_json,
        effect_vector_json,
        plasticity_state_json,
        lifecycle_json,
        legitimacy_json,
        created_at,
        updated_at
      FROM path_relations
      WHERE workspace_id = ?
        AND (
          json_extract(anchors_json, '$.source_anchor.object_id') = ?
          OR json_extract(anchors_json, '$.target_anchor.object_id') = ?
          OR json_extract(anchors_json, '$.source_anchor.source_object_id') = ?
          OR json_extract(anchors_json, '$.target_anchor.source_object_id') = ?
        )
      ORDER BY
        CASE WHEN COALESCE(json_extract(lifecycle_json, '$.status'), 'active') = 'retired' THEN 1 ELSE 0 END,
        created_at ASC,
        path_id ASC
    `);

    this.createPathRelationStatement = db.connection.prepare(`
      INSERT INTO path_relations (
        path_id,
        workspace_id,
        anchors_json,
        constitution_json,
        effect_vector_json,
        plasticity_state_json,
        lifecycle_json,
        legitimacy_json,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.updatePathRelationLegitimacyStatement = db.connection.prepare(`
      UPDATE path_relations
      SET legitimacy_json = ?, updated_at = ?
      WHERE path_id = ?
    `);

    this.createSynthesisCapsuleStatement = db.connection.prepare(`
      INSERT INTO synthesis_capsules (
        object_id,
        object_kind,
        schema_version,
        lifecycle_state,
        created_at,
        updated_at,
        created_by,
        topic_key,
        synthesis_type,
        summary,
        evidence_refs,
        source_memory_refs,
        workspace_id,
        run_id,
        synthesis_status
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);

    this.eventLogWriter = getEventLogWriter(db.connection);
  }

  public async create(input: ProposalCreateInput): Promise<Readonly<Proposal>> {
    const parsedProposal = parseProposal(input.proposal);
    const parsedWorkspaceId = parseWorkspaceId(input.workspace_id);
    const parsedRunId = parseRunId(input.run_id);
    const targetObjectKind = parseNonEmptyString(input.target_object_kind, "target_object_kind");
    const proposedChangeSummary = input.proposed_change_summary ?? "";
    const proposedChanges = serializeProposedChanges(input.proposed_changes ?? null);
    const proposedPathRelation = serializeProposedPathRelation(input.proposed_path_relation ?? null);
    const createdAt = input.created_at ?? parsedProposal.last_updated_at;
    const targetBaselineUpdatedAt = parseNullableTimestamp(input.target_baseline_updated_at ?? null);
    const sourceDeliveryIds = serializeSourceDeliveryIds(input.source_delivery_ids ?? null);

    try {
      this.createStatement.run(
        parsedProposal.runtime_id,
        parsedProposal.object_kind,
        parsedProposal.proposal_id,
        parsedProposal.task_surface_ref,
        parsedProposal.derived_from,
        parsedProposal.retention_policy,
        parsedProposal.dossier_ref,
        parsedProposal.recommended_option_id,
        JSON.stringify(parsedProposal.proposal_options),
        parsedProposal.resolution_state,
        parsedProposal.expires_at,
        parsedProposal.last_updated_at,
        parsedWorkspaceId,
        parsedRunId,
        targetObjectKind,
        proposedChangeSummary,
        proposedChanges,
        proposedPathRelation,
        createdAt,
        targetBaselineUpdatedAt,
        sourceDeliveryIds
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create proposal ${parsedProposal.proposal_id}.`,
        error
      );
    }

    return parsedProposal;
  }

  public async createProposalWithEvents(
    input: ProposalCreateInput,
    events: readonly ProposalCreationEventInput[],
    options: CreateProposalWithEventsOptions = {}
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>> {
    const parsedProposal = parseProposal(input.proposal);
    const parsedWorkspaceId = parseWorkspaceId(input.workspace_id);
    const parsedRunId = parseRunId(input.run_id);
    const targetObjectKind = parseNonEmptyString(input.target_object_kind, "target_object_kind");
    const proposedChangeSummary = input.proposed_change_summary ?? "";
    const proposedChanges = serializeProposedChanges(input.proposed_changes ?? null);
    const proposedPathRelation = serializeProposedPathRelation(input.proposed_path_relation ?? null);
    const createdAt = input.created_at ?? parsedProposal.last_updated_at;
    const targetBaselineUpdatedAt = parseNullableTimestamp(input.target_baseline_updated_at ?? null);
    const sourceDeliveryIds = serializeSourceDeliveryIds(input.source_delivery_ids ?? null);
    const reviewerAssignment =
      options.reviewerAssignment === undefined
        ? undefined
        : parseProposalReviewerAssignment(options.reviewerAssignment);

    try {
      return this.db.connection.transaction(() => {
        const storedEvents = events.map((event) => insertEventLogEntry(this.eventLogWriter, event));
        this.createStatement.run(
          parsedProposal.runtime_id,
          parsedProposal.object_kind,
          parsedProposal.proposal_id,
          parsedProposal.task_surface_ref,
          parsedProposal.derived_from,
          parsedProposal.retention_policy,
          parsedProposal.dossier_ref,
          parsedProposal.recommended_option_id,
          JSON.stringify(parsedProposal.proposal_options),
          parsedProposal.resolution_state,
          parsedProposal.expires_at,
          parsedProposal.last_updated_at,
          parsedWorkspaceId,
          parsedRunId,
          targetObjectKind,
          proposedChangeSummary,
          proposedChanges,
          proposedPathRelation,
          createdAt,
          targetBaselineUpdatedAt,
          sourceDeliveryIds
        );
        if (reviewerAssignment !== undefined) {
          this.insertReviewerAssignment(reviewerAssignment);
        }

        return deepFreeze({
          proposal: parsedProposal,
          events: storedEvents
        });
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to create proposal ${parsedProposal.proposal_id} with creation events.`,
        error
      );
    }
  }

  public async findById(proposalId: string): Promise<Readonly<Proposal> | null> {
    try {
      const row = this.findByIdStatement.get(proposalId) as ProposalRow | undefined;
      return row === undefined ? null : parseProposalRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load proposal ${proposalId}.`, error);
    }
  }

  public async findScopedById(proposalId: string): Promise<Readonly<ScopedProposal> | null> {
    try {
      const row = this.findByIdStatement.get(proposalId) as ProposalRow | undefined;
      const assignment =
        row === undefined
          ? null
          : this.findReviewerAssignmentRow(row.proposal_id);
      return row === undefined
        ? null
        : deepFreeze({
            proposal: parseProposalRow(row),
            workspace_id: row.workspace_id,
            run_id: row.run_id,
            target_object_kind: row.target_object_kind,
            reviewer_identity: row.reviewer_identity,
            reviewer_assignment: assignment,
            proposed_changes: parseProposedChanges(row.proposed_changes),
            proposed_path_relation: parseProposedPathRelation(row.proposed_path_relation),
            target_baseline_updated_at: row.target_baseline_updated_at,
            source_delivery_ids: parseSourceDeliveryIds(row.source_delivery_ids)
          });
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load proposal ${proposalId}.`, error);
    }
  }

  public async findByWorkspaceId(workspaceId: string): Promise<readonly Readonly<Proposal>[]> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);

    try {
      const rows = this.findByWorkspaceIdStatement.all(parsedWorkspaceId) as ProposalRow[];
      return rows.map((row) => parseProposalRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list proposals for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async findPending(workspaceId: string): Promise<readonly Readonly<Proposal>[]> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);

    try {
      const rows = this.findPendingStatement.all(parsedWorkspaceId) as ProposalRow[];
      return rows.map((row) => parseProposalRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list pending proposals for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async countPending(workspaceId: string): Promise<number> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);

    try {
      const row = this.countPendingStatement.get(parsedWorkspaceId) as
        | { readonly total: number }
        | undefined;
      return row === undefined ? 0 : Number(row.total);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to count pending proposals for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async countPendingMemoryTargetEdges(
    workspaceId: string,
    targetObjectIds: readonly string[]
  ): Promise<number> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);
    const uniqueTargetObjectIds = [...new Set(targetObjectIds.map((id) =>
      parseNonEmptyString(id, "target_object_id")
    ))];
    if (uniqueTargetObjectIds.length === 0) {
      return 0;
    }

    try {
      let total = 0;
      for (let index = 0; index < uniqueTargetObjectIds.length; index += SQLITE_VARIABLE_CHUNK_SIZE) {
        const chunk = uniqueTargetObjectIds.slice(index, index + SQLITE_VARIABLE_CHUNK_SIZE);
        const placeholders = chunk.map(() => "?").join(", ");
        const row = this.db.connection
          .prepare(`
            SELECT COUNT(*) AS total
            FROM proposals
            WHERE workspace_id = ?
              AND resolution_state = 'pending'
              AND target_object_kind = 'memory_entry'
              AND derived_from IN (${placeholders})
          `)
          .get(parsedWorkspaceId, ...chunk) as { readonly total: number } | undefined;
        total += row === undefined ? 0 : Number(row.total);
      }
      return total;
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to count pending proposal memory target edges for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  // Projects pending rows into the soul.list_pending_proposals summary
  // shape. Built dynamically so the
  // optional since / limit filters compose; the underlying findPending
  // result is already workspace-scoped to keep the SECURITY invariant.
  public async findPendingSummaries(
    workspaceId: string,
    options: FindPendingSummariesOptions = {}
  ): Promise<readonly Readonly<PendingProposalSummary>[]> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);
    const since = options.since ?? null;
    const limit = options.limit ?? null;
    const referenceTime = parseTimestamp(options.now ?? new Date().toISOString());

    let sql = `
      SELECT
        p.runtime_id,
        p.object_kind,
        p.proposal_id,
        p.task_surface_ref,
        p.derived_from,
        p.retention_policy,
        p.dossier_ref,
        p.recommended_option_id,
        p.proposal_options,
        p.resolution_state,
        p.expires_at,
        p.last_updated_at,
        p.workspace_id,
        p.run_id,
        p.reviewer_identity,
        p.target_object_kind,
        p.proposed_change_summary,
        p.proposed_changes,
        p.created_at,
        a.reviewer_identity AS assigned_reviewer_identity,
        a.assigned_at AS assigned_at,
        a.deadline_at AS deadline_at,
        CASE
          WHEN a.deadline_at IS NOT NULL AND a.deadline_at < ? THEN 1
          ELSE 0
        END AS is_overdue
      FROM proposals p
      LEFT JOIN proposal_reviewer_assignments a
        ON a.proposal_id = p.proposal_id
      WHERE p.workspace_id = ? AND p.resolution_state = 'pending'
    `;
    const params: (string | number)[] = [referenceTime, parsedWorkspaceId];
    if (since !== null) {
      // Polling uses exclusive `>` cursor semantics. HITL pollers pass
      // the timestamp of their most-recent record as
      // `since`; an inclusive `>=` returns the boundary record on every
      // subsequent poll.
      sql += " AND p.created_at > ?";
      params.push(since);
    }
    sql += " ORDER BY p.created_at DESC, p.proposal_id DESC";
    if (limit !== null) {
      sql += " LIMIT ?";
      params.push(limit);
    }

    try {
      const rows = this.db.connection.prepare(sql).all(...params) as PendingProposalSummaryRow[];
      return rows.map((row) =>
        deepFreeze({
          proposal_id: row.proposal_id,
          // derived_from is nullable in the proposals schema; for the
          // MCP-driven proposeMemoryUpdate path it is always populated
          // with the target memory id, so falling back to runtime_id
          // keeps the projection total even for legacy/edge rows.
          target_object_id: row.derived_from ?? row.runtime_id,
          target_object_kind: row.target_object_kind,
          created_at: row.created_at ?? row.last_updated_at,
          proposed_change_summary: row.proposed_change_summary,
          proposed_changes: parseProposedChanges(row.proposed_changes),
          assigned_reviewer_identity: row.assigned_reviewer_identity,
          assigned_at: row.assigned_at,
          deadline_at: row.deadline_at,
          is_overdue: row.is_overdue === 1
        })
      );
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list pending proposal summaries for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async findPendingByRunId(runId: string): Promise<Readonly<Proposal> | null> {
    const parsedRunId = parseNonEmptyString(runId, "run_id");

    try {
      const row = this.findPendingByRunIdStatement.get(parsedRunId) as ProposalRow | undefined;
      return row === undefined ? null : parseProposalRow(row);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load pending bankruptcy proposal for run ${parsedRunId}.`,
        error
      );
    }
  }

  public async assignReviewer(input: ProposalReviewerAssignmentInput): Promise<Readonly<ProposalReviewerAssignment>> {
    const assignment = parseProposalReviewerAssignment(input);

    try {
      this.insertReviewerAssignment(assignment);
      const stored = this.findReviewerAssignmentRow(assignment.proposal_id);
      if (stored === null) {
        throw new StorageError(
          "NOT_FOUND",
          `Reviewer assignment for proposal ${assignment.proposal_id} was not found after write.`
        );
      }
      return stored;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to assign reviewer for proposal ${assignment.proposal_id}.`,
        error
      );
    }
  }

  public async findReviewerAssignment(
    proposalId: string
  ): Promise<Readonly<ProposalReviewerAssignment> | null> {
    const parsedProposalId = parseProposalId(proposalId);

    try {
      return this.findReviewerAssignmentRow(parsedProposalId);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to load reviewer assignment for proposal ${parsedProposalId}.`,
        error
      );
    }
  }

  public async updateResolution(
    proposalId: string,
    state: ProposalResolutionState,
    updatedAt: string,
    reviewerIdentity?: string
  ): Promise<Readonly<Proposal>> {
    const parsedProposalId = parseProposalId(proposalId);
    const parsedState = parseProposalResolutionState(state);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);
    // Persist reviewer_identity through the legacy update path.
    // Empty/whitespace identities are rejected;
    // when omitted, the column is left untouched (back-compat for
    // claim-promotion / auto-applied bankruptcy paths).
    const parsedReviewerIdentity =
      reviewerIdentity === undefined
        ? undefined
        : parseNonEmptyString(reviewerIdentity, "reviewer_identity");

    try {
      const result =
        parsedReviewerIdentity === undefined
          ? this.updateResolutionStatement.run(parsedState, parsedUpdatedAt, parsedProposalId)
          : this.updateResolutionWithIdentityStatement.run(
              parsedState,
              parsedUpdatedAt,
              parsedReviewerIdentity,
              parsedProposalId
            );

      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found.`);
      }

      const updated = await this.findById(parsedProposalId);

      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found after update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError("QUERY_FAILED", `Failed to update proposal ${parsedProposalId}.`, error);
    }
  }

  public async updatePendingResolution(
    proposalId: string,
    state: ProposalResolutionState,
    updatedAt: string
  ): Promise<Readonly<Proposal>> {
    const parsedProposalId = parseProposalId(proposalId);
    const parsedState = parseProposalResolutionState(state);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);

    try {
      const result = this.updatePendingResolutionStatement.run(parsedState, parsedUpdatedAt, parsedProposalId);

      if (result.changes === 0) {
        const existing = await this.findById(parsedProposalId);
        if (existing === null) {
          throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found.`);
        }

        throw new StorageError(
          "CONFLICT",
          `Proposal ${parsedProposalId} is already ${existing.resolution_state}.`
        );
      }

      const updated = await this.findById(parsedProposalId);

      if (updated === null) {
        throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found after update.`);
      }

      return updated;
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to update pending proposal ${parsedProposalId}.`,
        error
      );
    }
  }

  public async updatePendingResolutionWithEvents(
    proposalId: string,
    state: ProposalResolutionState,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    options: UpdatePendingResolutionOptions = {}
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly events: readonly EventLogEntry[];
  }>> {
    const parsedProposalId = parseProposalId(proposalId);
    const parsedState = parseProposalResolutionState(state);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);
    // Empty/whitespace identities are rejected; if the caller did not
    // pass reviewerIdentity (legacy callers, e.g. claim-promotion
    // flows), the column is left untouched.
    const reviewerIdentity =
      options.reviewerIdentity === undefined
        ? undefined
        : parseNonEmptyString(options.reviewerIdentity, "reviewer_identity");

    try {
      return this.db.connection.transaction(() => {
        const storedEvents = events.map((event) => insertEventLogEntry(this.eventLogWriter, event));
        const result =
          reviewerIdentity === undefined
            ? this.updatePendingResolutionStatement.run(parsedState, parsedUpdatedAt, parsedProposalId)
            : this.updatePendingResolutionWithIdentityStatement.run(
                parsedState,
                parsedUpdatedAt,
                reviewerIdentity,
                parsedProposalId
              );

        if (result.changes === 0) {
          throw this.createPendingResolutionFailure(parsedProposalId);
        }

        const row = this.findByIdStatement.get(parsedProposalId) as ProposalRow | undefined;
        if (row === undefined) {
          throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found after update.`);
        }

        return deepFreeze({
          proposal: parseProposalRow(row),
          events: storedEvents
        });
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to update pending proposal ${parsedProposalId} with review events.`,
        error
      );
    }
  }

  public async acceptPendingMemoryUpdateWithEvents(
    proposalId: string,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    memoryUpdate: AcceptedMemoryUpdateInput,
    options: UpdatePendingResolutionOptions = {}
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly memory: Readonly<MemoryEntry>;
    readonly events: readonly EventLogEntry[];
  }>> {
    const parsedProposalId = parseProposalId(proposalId);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);
    const reviewerIdentity =
      options.reviewerIdentity === undefined
        ? undefined
        : parseNonEmptyString(options.reviewerIdentity, "reviewer_identity");
    const parsedMemoryUpdate = parseAcceptedMemoryUpdateInput(memoryUpdate);

    try {
      return this.db.connection.transaction(() => {
        const proposalRow = this.findByIdStatement.get(parsedProposalId) as ProposalRow | undefined;
        if (proposalRow === undefined) {
          throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found.`);
        }
        if (proposalRow.resolution_state !== "pending") {
          throw this.createPendingResolutionFailure(parsedProposalId);
        }
        assertAcceptedMemoryUpdateMatchesProposal(proposalRow, parsedMemoryUpdate);

        const existingMemoryRow = this.findMemoryEntryByIdStatement.get(
          parsedMemoryUpdate.target_object_id
        ) as MemoryEntryRow | undefined;
        if (existingMemoryRow === undefined) {
          throw new StorageError(
            "NOT_FOUND",
            `Memory entry ${parsedMemoryUpdate.target_object_id} was not found.`
          );
        }
        const existingMemory = parseMemoryEntryRow(existingMemoryRow);
        if (existingMemory.workspace_id !== parsedMemoryUpdate.workspace_id) {
          throw new StorageError(
            "NOT_FOUND",
            `Memory entry ${parsedMemoryUpdate.target_object_id} was not found in workspace ${parsedMemoryUpdate.workspace_id}.`
          );
        }
        if (existingMemory.lifecycle_state === "archived") {
          throw new StorageError(
            "VALIDATION_FAILED",
            `Memory entry ${parsedMemoryUpdate.target_object_id} is archived and cannot be updated.`
          );
        }

        // Cross-proposal lost-update guard. The workflow captured the
        // memory's updated_at outside this transaction; if the live row
        // has moved on because a sibling proposal already committed
        // against the same memory entry, abort with CONFLICT so the
        // reviewer can re-review against the new baseline.
        if (
          parsedMemoryUpdate.expected_baseline_updated_at !== null &&
          existingMemory.updated_at !== parsedMemoryUpdate.expected_baseline_updated_at
        ) {
          throw new StorageError(
            "CONFLICT",
            `Memory entry ${parsedMemoryUpdate.target_object_id}: proposal was made against a stale snapshot; re-review required.`
          );
        }

        const storedReviewEvents = events.map((event) => insertEventLogEntry(this.eventLogWriter, event));
        const acceptedState = "accepted" satisfies ProposalResolutionState;
        const result =
          reviewerIdentity === undefined
            ? this.updatePendingResolutionStatement.run(
                acceptedState,
                parsedUpdatedAt,
                parsedProposalId
              )
            : this.updatePendingResolutionWithIdentityStatement.run(
                acceptedState,
                parsedUpdatedAt,
                reviewerIdentity,
                parsedProposalId
              );

        if (result.changes === 0) {
          throw this.createPendingResolutionFailure(parsedProposalId);
        }

        const parsedFields = parsedMemoryUpdate.proposed_changes;
        const memoryEvent = insertEventLogEntry(this.eventLogWriter, {
          event_type: MemoryGovernanceEventType.SOUL_MEMORY_UPDATED,
          entity_type: "memory_entry",
          entity_id: existingMemory.object_id,
          workspace_id: existingMemory.workspace_id,
          run_id: existingMemory.run_id,
          caused_by: parsedMemoryUpdate.caused_by,
          payload_json: SoulMemoryUpdatedPayloadSchema.parse({
            object_id: existingMemory.object_id,
            object_kind: existingMemory.object_kind,
            workspace_id: existingMemory.workspace_id,
            run_id: existingMemory.run_id,
            updated_fields: toUpdatedFieldNames(parsedMemoryUpdate.proposed_changes)
          })
        });
        const revokableGreenStatus =
          parsedFields.evidence_refs !== undefined &&
          shouldRevokeGreenForEvidenceRewrite(existingMemory.evidence_refs, parsedFields.evidence_refs)
            ? (this.findRevokableGreenStatusStatement.get(
                existingMemory.object_id,
                existingMemory.workspace_id
              ) as RevokableGreenStatusRow | undefined)
            : undefined;
        const greenEvent =
          revokableGreenStatus === undefined
            ? undefined
            : insertEventLogEntry(this.eventLogWriter, {
                event_type: GreenGovernanceEventType.SOUL_GREEN_PIERCED,
                entity_type: "green_status",
                entity_id: revokableGreenStatus.object_id,
                workspace_id: existingMemory.workspace_id,
                run_id: existingMemory.run_id,
                caused_by: parsedMemoryUpdate.caused_by,
                payload_json: SoulGreenPiercedPayloadSchema.parse({
                  object_id: revokableGreenStatus.object_id,
                  target_object_id: existingMemory.object_id,
                  revoke_reason: RevokeReason.MAPPING_REVOKED,
                  workspace_id: existingMemory.workspace_id,
                  occurred_at: parsedUpdatedAt
                })
              });
        const memoryResult = this.updateMemoryEntryStatement.run(
          parsedFields.content ?? null,
          parsedFields.domain_tags === undefined ? null : JSON.stringify(parsedFields.domain_tags),
          parsedFields.evidence_refs === undefined ? null : JSON.stringify(parsedFields.evidence_refs),
          parsedFields.storage_tier ?? null,
          parsedFields.confidence ?? null,
          parsedFields.retention_state ?? null,
          parsedFields.updated_at,
          parsedMemoryUpdate.target_object_id
        );
        if (memoryResult.changes === 0) {
          throw new StorageError(
            "NOT_FOUND",
            `Memory entry ${parsedMemoryUpdate.target_object_id} was not found during update.`
          );
        }
        if (revokableGreenStatus !== undefined) {
          const greenResult = this.revokeGreenStatusStatement.run(
            RevokeReason.MAPPING_REVOKED,
            parsedUpdatedAt,
            parsedUpdatedAt,
            revokableGreenStatus.object_id,
            existingMemory.object_id,
            existingMemory.workspace_id
          );
          if (greenResult.changes === 0) {
            throw new StorageError(
              "CONFLICT",
              `Green status ${revokableGreenStatus.object_id} was not revokable during memory update.`
            );
          }
        }

        const updatedMemoryRow = this.findMemoryEntryByIdStatement.get(
          parsedMemoryUpdate.target_object_id
        ) as MemoryEntryRow | undefined;
        if (updatedMemoryRow === undefined) {
          throw new StorageError(
            "NOT_FOUND",
            `Memory entry ${parsedMemoryUpdate.target_object_id} was not found after update.`
          );
        }
        const updatedMemory = parseMemoryEntryRow(updatedMemoryRow);

        const updatedProposalRow = this.findByIdStatement.get(parsedProposalId) as ProposalRow | undefined;
        if (updatedProposalRow === undefined) {
          throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found after update.`);
        }

        return deepFreeze({
          proposal: parseProposalRow(updatedProposalRow),
          memory: updatedMemory,
          events: greenEvent === undefined
            ? [...storedReviewEvents, memoryEvent]
            : [...storedReviewEvents, memoryEvent, greenEvent]
        });
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to accept proposal ${parsedProposalId} with durable memory update.`,
        error
      );
    }
  }

  public async acceptPendingPathRelationGovernanceWithEvents(
    proposalId: string,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    pathRelationGovernance: AcceptedPathRelationGovernanceInput,
    options: UpdatePendingResolutionOptions = {}
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly path_relation: Readonly<PathRelation>;
    readonly events: readonly EventLogEntry[];
  }>> {
    const parsedProposalId = parseProposalId(proposalId);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);
    const reviewerIdentity =
      options.reviewerIdentity === undefined
        ? undefined
        : parseNonEmptyString(options.reviewerIdentity, "reviewer_identity");
    const parsedPathRelationGovernance = parseAcceptedPathRelationGovernanceInput(
      pathRelationGovernance
    );

    try {
      return this.db.connection.transaction(() => {
        const proposalRow = this.findByIdStatement.get(parsedProposalId) as ProposalRow | undefined;
        if (proposalRow === undefined) {
          throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found.`);
        }
        if (proposalRow.resolution_state !== "pending") {
          throw this.createPendingResolutionFailure(parsedProposalId);
        }
        assertAcceptedPathRelationGovernanceMatchesProposal(
          proposalRow,
          parsedPathRelationGovernance
        );

        const memoryRow = this.findMemoryEntryByIdStatement.get(
          parsedPathRelationGovernance.target_object_id
        ) as MemoryEntryRow | undefined;
        if (memoryRow === undefined) {
          throw new StorageError(
            "NOT_FOUND",
            `Memory entry ${parsedPathRelationGovernance.target_object_id} was not found.`
          );
        }
        const memory = parseMemoryEntryRow(memoryRow);
        if (memory.workspace_id !== parsedPathRelationGovernance.workspace_id) {
          throw new StorageError(
            "NOT_FOUND",
            `Memory entry ${parsedPathRelationGovernance.target_object_id} was not found in workspace ${parsedPathRelationGovernance.workspace_id}.`
          );
        }

        const storedReviewEvents = events.map((event) => insertEventLogEntry(this.eventLogWriter, event));
        const acceptedState = "accepted" satisfies ProposalResolutionState;
        const result =
          reviewerIdentity === undefined
            ? this.updatePendingResolutionStatement.run(
                acceptedState,
                parsedUpdatedAt,
                parsedProposalId
              )
            : this.updatePendingResolutionWithIdentityStatement.run(
                acceptedState,
                parsedUpdatedAt,
                reviewerIdentity,
                parsedProposalId
              );

        if (result.changes === 0) {
          throw this.createPendingResolutionFailure(parsedProposalId);
        }

        const pathApply = this.upsertStrictlyGovernedPathRelation(
          parsedPathRelationGovernance,
          proposalRow
        );

        const updatedProposalRow = this.findByIdStatement.get(parsedProposalId) as ProposalRow | undefined;
        if (updatedProposalRow === undefined) {
          throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found after update.`);
        }

        return deepFreeze({
          proposal: parseProposalRow(updatedProposalRow),
          path_relation: pathApply.pathRelation,
          events:
            pathApply.event === null
              ? storedReviewEvents
              : [...storedReviewEvents, pathApply.event]
        });
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to accept proposal ${parsedProposalId} with durable path relation governance update.`,
        error
      );
    }
  }

  public async acceptPendingSynthesisCreateWithEvents(
    proposalId: string,
    updatedAt: string,
    events: readonly ProposalResolutionEventInput[],
    synthesisCreate: AcceptedSynthesisCreateInput,
    options: UpdatePendingResolutionOptions = {}
  ): Promise<Readonly<{
    readonly proposal: Readonly<Proposal>;
    readonly synthesis: Readonly<SynthesisCapsule>;
    readonly events: readonly EventLogEntry[];
  }>> {
    const parsedProposalId = parseProposalId(proposalId);
    const parsedUpdatedAt = parseUpdatedAt(updatedAt);
    const reviewerIdentity =
      options.reviewerIdentity === undefined
        ? undefined
        : parseNonEmptyString(options.reviewerIdentity, "reviewer_identity");
    const parsedSynthesisCreate = parseAcceptedSynthesisCreateInput(synthesisCreate);

    try {
      return this.db.connection.transaction(() => {
        const proposalRow = this.findByIdStatement.get(parsedProposalId) as ProposalRow | undefined;
        if (proposalRow === undefined) {
          throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found.`);
        }
        if (proposalRow.resolution_state !== "pending") {
          throw this.createPendingResolutionFailure(parsedProposalId);
        }
        assertAcceptedSynthesisCreateMatchesProposal(proposalRow, parsedSynthesisCreate);

        const storedReviewEvents = events.map((event) => insertEventLogEntry(this.eventLogWriter, event));
        const acceptedState = "accepted" satisfies ProposalResolutionState;
        const result =
          reviewerIdentity === undefined
            ? this.updatePendingResolutionStatement.run(
                acceptedState,
                parsedUpdatedAt,
                parsedProposalId
              )
            : this.updatePendingResolutionWithIdentityStatement.run(
                acceptedState,
                parsedUpdatedAt,
                reviewerIdentity,
                parsedProposalId
              );

        if (result.changes === 0) {
          throw this.createPendingResolutionFailure(parsedProposalId);
        }

        const capsule = parsedSynthesisCreate.capsule;
        const synthesisEvent = insertEventLogEntry(this.eventLogWriter, {
          event_type: MemoryGovernanceEventType.SOUL_SYNTHESIS_CREATED,
          entity_type: "synthesis_capsule",
          entity_id: capsule.object_id,
          workspace_id: capsule.workspace_id,
          run_id: capsule.run_id,
          caused_by: capsule.created_by,
          payload_json: SoulSynthesisCreatedPayloadSchema.parse({
            object_id: capsule.object_id,
            object_kind: capsule.object_kind,
            workspace_id: capsule.workspace_id,
            run_id: capsule.run_id
          })
        });
        this.createSynthesisCapsuleStatement.run(
          capsule.object_id,
          capsule.object_kind,
          capsule.schema_version,
          capsule.lifecycle_state,
          capsule.created_at,
          capsule.updated_at,
          capsule.created_by,
          capsule.topic_key,
          capsule.synthesis_type,
          capsule.summary,
          JSON.stringify(capsule.evidence_refs),
          JSON.stringify(capsule.source_memory_refs),
          capsule.workspace_id,
          capsule.run_id,
          capsule.synthesis_status
        );

        const updatedProposalRow = this.findByIdStatement.get(parsedProposalId) as ProposalRow | undefined;
        if (updatedProposalRow === undefined) {
          throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found after update.`);
        }

        return deepFreeze({
          proposal: parseProposalRow(updatedProposalRow),
          synthesis: capsule,
          events: [...storedReviewEvents, synthesisEvent]
        });
      })();
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }

      throw new StorageError(
        "QUERY_FAILED",
        `Failed to accept proposal ${parsedProposalId} with durable synthesis create.`,
        error
      );
    }
  }

  private createPendingResolutionFailure(proposalId: string): StorageError {
    const row = this.findByIdStatement.get(proposalId) as ProposalRow | undefined;
    if (row === undefined) {
      return new StorageError("NOT_FOUND", `Proposal ${proposalId} was not found.`);
    }

    return new StorageError("CONFLICT", `Proposal ${proposalId} is already ${row.resolution_state}.`);
  }

  private insertReviewerAssignment(assignment: ProposalReviewerAssignment): void {
    this.assignReviewerStatement.run(
      assignment.proposal_id,
      assignment.reviewer_identity,
      assignment.assigned_at,
      assignment.deadline_at,
      assignment.escalation_after_ms
    );
  }

  private findReviewerAssignmentRow(proposalId: string): Readonly<ProposalReviewerAssignment> | null {
    const row = this.findReviewerAssignmentStatement.get(proposalId) as
      | ProposalReviewerAssignmentRow
      | undefined;
    return row === undefined ? null : parseProposalReviewerAssignmentRow(row);
  }

  private upsertStrictlyGovernedPathRelation(
    input: ReturnType<typeof parseAcceptedPathRelationGovernanceInput>,
    proposalRow: ProposalRow
  ): Readonly<{ readonly pathRelation: Readonly<PathRelation>; readonly event: EventLogEntry | null }> {
    const proposedPathRelation = parseProposedPathRelation(proposalRow.proposed_path_relation);
    const existingRows = this.findPathRelationByAnchorMemoryIdStatement.all(
      input.workspace_id,
      input.target_object_id,
      input.target_object_id,
      input.target_object_id,
      input.target_object_id
    ) as ProposalPathRelationRow[];
    const existingRow =
      proposedPathRelation === null
        ? existingRows[0]
        : existingRows.find((row) =>
            pathRelationMatchesProposalPayload(
              parseProposalPathRelationRow(row),
              input.target_object_id,
              proposedPathRelation
            )
          );

    if (existingRow !== undefined) {
      const existing = parseProposalPathRelationRow(existingRow);
      const updated = applyPathRelationProposal(existing, input, proposedPathRelation);
      const result = this.updatePathRelationLegitimacyStatement.run(
        JSON.stringify(updated.legitimacy),
        updated.updated_at,
        updated.path_id
      );
      if (result.changes === 0) {
        throw new StorageError("NOT_FOUND", `Path relation ${updated.path_id} was not found.`);
      }
      const pathEvent = insertEventLogEntry(this.eventLogWriter, {
        event_type: RuntimeGovernanceEventType.PATH_RELATION_LEGITIMACY_UPDATED,
        entity_type: "path_relation",
        entity_id: updated.path_id,
        workspace_id: updated.workspace_id,
        run_id: proposalRow.run_id,
        caused_by: input.caused_by,
        payload_json: parseRuntimeGovernanceEventPayload(
          RuntimeGovernanceEventType.PATH_RELATION_LEGITIMACY_UPDATED,
          {
            path_id: updated.path_id,
            workspace_id: updated.workspace_id,
            previous_governance_class: existing.legitimacy.governance_class,
            new_governance_class: updated.legitimacy.governance_class,
            previous_evidence_basis: existing.legitimacy.evidence_basis,
            new_evidence_basis: updated.legitimacy.evidence_basis,
            updated_at: updated.updated_at
          }
        ) as unknown as Record<string, unknown>
      });
      return deepFreeze({ pathRelation: updated, event: pathEvent });
    }

    const created =
      proposedPathRelation === null
        ? createStrictlyGovernedPathRelation(input)
        : createPathRelationFromProposalPayload(input, proposedPathRelation);
    const pathEvent = insertEventLogEntry(this.eventLogWriter, {
      event_type: RuntimeGovernanceEventType.PATH_RELATION_CREATED,
      entity_type: "path_relation",
      entity_id: created.path_id,
      workspace_id: created.workspace_id,
      run_id: proposalRow.run_id,
      caused_by: input.caused_by,
      payload_json: parseRuntimeGovernanceEventPayload(
        RuntimeGovernanceEventType.PATH_RELATION_CREATED,
        {
          path_id: created.path_id,
          workspace_id: created.workspace_id,
          relation_kind: created.constitution.relation_kind,
          source_anchor_kind: created.anchors.source_anchor.kind,
          target_anchor_kind: created.anchors.target_anchor.kind,
          initial_strength: created.plasticity_state.strength,
          governance_class: created.legitimacy.governance_class,
          created_at: created.created_at
        }
      ) as unknown as Record<string, unknown>
    });
    this.createPathRelationStatement.run(
      created.path_id,
      created.workspace_id,
      JSON.stringify(created.anchors),
      JSON.stringify(created.constitution),
      JSON.stringify(created.effect_vector),
      JSON.stringify(created.plasticity_state),
      JSON.stringify(created.lifecycle),
      JSON.stringify(created.legitimacy),
      created.created_at,
      created.updated_at
    );
    return deepFreeze({ pathRelation: created, event: pathEvent });
  }
}

function parseProposal(value: Proposal): Readonly<Proposal> {
  try {
    return deepFreeze(ProposalSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal.", error);
  }
}

function parseProposalRow(row: ProposalRow): Readonly<Proposal> {
  let proposalOptions: unknown;

  try {
    proposalOptions = JSON.parse(row.proposal_options);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse proposal options JSON.", error);
  }

  try {
    return deepFreeze(
      ProposalSchema.parse({
        runtime_id: row.runtime_id,
        object_kind: row.object_kind,
        proposal_id: row.proposal_id,
        task_surface_ref: row.task_surface_ref,
        derived_from: row.derived_from,
        retention_policy: row.retention_policy,
        dossier_ref: row.dossier_ref,
        recommended_option_id: row.recommended_option_id,
        proposal_options: proposalOptions,
        resolution_state: row.resolution_state,
        expires_at: row.expires_at,
        last_updated_at: row.last_updated_at
      })
    );
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal row.", error);
  }
}

function serializeProposedChanges(
  value: MemoryEntryMutableFields | null
): string | null {
  if (value === null) {
    return null;
  }

  try {
    return JSON.stringify(PublicMemoryEntryMutableFieldsSchema.parse(value));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal proposed_changes.", error);
  }
}

function parseProposedChanges(value: string | null): Readonly<MemoryEntryMutableFields> | null {
  if (value === null) {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse proposal proposed_changes JSON.", error);
  }

  try {
    return deepFreeze(PublicMemoryEntryMutableFieldsSchema.parse(parsedJson));
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal proposed_changes row.", error);
  }
}

function serializeProposedPathRelation(
  value: PathRelationProposalPayload | null
): string | null {
  if (value === null) {
    return null;
  }

  const parsed = parsePathRelationProposalPayload(value);
  return JSON.stringify(parsed);
}

function parseProposedPathRelation(value: string | null): Readonly<PathRelationProposalPayload> | null {
  if (value === null) {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse proposal proposed_path_relation JSON.", error);
  }

  return parsePathRelationProposalPayload(parsedJson);
}

function parsePathRelationProposalPayload(value: unknown): Readonly<PathRelationProposalPayload> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal proposed_path_relation.");
  }
  const candidate = value as Partial<PathRelationProposalPayload>;
  try {
    const relation = PathRelationSchema.parse({
      path_id: "proposal-payload-validation",
      workspace_id: "proposal-payload-validation-workspace",
      anchors: {
        source_anchor: { kind: "object", object_id: "proposal-payload-validation-source" },
        target_anchor: candidate.target_anchor
      },
      constitution: candidate.constitution,
      effect_vector: candidate.effect_vector,
      plasticity_state: candidate.plasticity_state,
      lifecycle: candidate.lifecycle,
      legitimacy: candidate.legitimacy,
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z"
    });
    return deepFreeze({
      target_anchor: relation.anchors.target_anchor,
      constitution: relation.constitution,
      effect_vector: relation.effect_vector,
      plasticity_state: relation.plasticity_state,
      lifecycle: relation.lifecycle,
      legitimacy: relation.legitimacy
    });
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal proposed_path_relation.", error);
  }
}

function serializeSourceDeliveryIds(value: readonly string[] | null): string | null {
  if (value === null) {
    return null;
  }

  const parsed = parseSourceDeliveryIdsArray(value);
  return JSON.stringify(parsed);
}

function parseSourceDeliveryIds(value: string | null): readonly string[] | null {
  if (value === null) {
    return null;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to parse proposal source_delivery_ids JSON.", error);
  }

  return parseSourceDeliveryIdsArray(parsedJson);
}

function parseSourceDeliveryIdsArray(value: unknown): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new StorageError("VALIDATION_FAILED", "Proposal source_delivery_ids must be a non-empty array.");
  }
  return deepFreeze(
    value.map((item, index) => parseNonEmptyString(item, `source_delivery_ids[${index}]`))
  );
}

function parseAcceptedMemoryUpdateInput(
  input: AcceptedMemoryUpdateInput
): Readonly<{
  readonly target_object_id: string;
  readonly workspace_id: string;
  readonly proposed_changes: MemoryEntryMutableFields & { readonly updated_at: string };
  readonly caused_by: string;
  readonly expected_baseline_updated_at: string | null;
}> {
  const parsedChanges = parseUpdateFields({
    ...PublicMemoryEntryMutableFieldsSchema.parse(input.proposed_changes),
    updated_at: parseUpdatedAt(input.updated_at)
  });

  const expectedBaselineUpdatedAt =
    input.expected_baseline_updated_at === null ||
    input.expected_baseline_updated_at === undefined
      ? null
      : parseUpdatedAt(input.expected_baseline_updated_at);

  return deepFreeze({
    target_object_id: parseNonEmptyString(input.target_object_id, "target_object_id"),
    workspace_id: parseWorkspaceId(input.workspace_id),
    proposed_changes: parsedChanges,
    caused_by: parseNonEmptyString(input.caused_by, "caused_by"),
    expected_baseline_updated_at: expectedBaselineUpdatedAt
  });
}

function parseAcceptedPathRelationGovernanceInput(
  input: AcceptedPathRelationGovernanceInput
): Readonly<{
  readonly target_object_id: string;
  readonly workspace_id: string;
  readonly path_id_on_create: string;
  readonly updated_at: string;
  readonly caused_by: string;
}> {
  return deepFreeze({
    target_object_id: parseNonEmptyString(input.target_object_id, "target_object_id"),
    workspace_id: parseWorkspaceId(input.workspace_id),
    path_id_on_create: parseNonEmptyString(input.path_id_on_create, "path_id_on_create"),
    updated_at: parseUpdatedAt(input.updated_at),
    caused_by: parseNonEmptyString(input.caused_by, "caused_by")
  });
}

function assertAcceptedMemoryUpdateMatchesProposal(
  row: ProposalRow,
  update: ReturnType<typeof parseAcceptedMemoryUpdateInput>
): void {
  if (
    row.workspace_id !== update.workspace_id ||
    row.target_object_kind !== "memory_entry" ||
    row.derived_from !== update.target_object_id ||
    row.target_baseline_updated_at !== update.expected_baseline_updated_at
  ) {
    throw createAcceptedMemoryUpdateMismatch(row.proposal_id);
  }

  const storedChanges = parseProposedChanges(row.proposed_changes);
  if (
    storedChanges === null ||
    !proposedChangesMatch(storedChanges, update.proposed_changes)
  ) {
    throw createAcceptedMemoryUpdateMismatch(row.proposal_id);
  }
}

function assertAcceptedPathRelationGovernanceMatchesProposal(
  row: ProposalRow,
  update: ReturnType<typeof parseAcceptedPathRelationGovernanceInput>
): void {
  if (
    row.workspace_id !== update.workspace_id ||
    row.target_object_kind !== "path_relation" ||
    row.derived_from !== update.target_object_id
  ) {
    throw createAcceptedPathRelationGovernanceMismatch(row.proposal_id);
  }
}

function createAcceptedMemoryUpdateMismatch(proposalId: string): StorageError {
  return new StorageError(
    "CONFLICT",
    `Accepted memory update does not match proposal ${proposalId}.`
  );
}

function createAcceptedPathRelationGovernanceMismatch(proposalId: string): StorageError {
  return new StorageError(
    "CONFLICT",
    `Accepted path relation governance update does not match proposal ${proposalId}.`
  );
}

function parseAcceptedSynthesisCreateInput(
  input: AcceptedSynthesisCreateInput
): Readonly<{
  readonly workspace_id: string;
  readonly capsule: Readonly<SynthesisCapsule>;
  readonly caused_by: string;
}> {
  let capsule: Readonly<SynthesisCapsule>;
  try {
    capsule = SynthesisCapsuleSchema.parse(input.capsule);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate synthesis capsule.", error);
  }
  const workspaceId = parseWorkspaceId(input.workspace_id);
  if (capsule.workspace_id !== workspaceId) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Synthesis capsule workspace ${capsule.workspace_id} does not match accept scope ${workspaceId}.`
    );
  }
  return deepFreeze({
    workspace_id: workspaceId,
    capsule,
    caused_by: parseNonEmptyString(input.caused_by, "caused_by")
  });
}

function assertAcceptedSynthesisCreateMatchesProposal(
  row: ProposalRow,
  create: ReturnType<typeof parseAcceptedSynthesisCreateInput>
): void {
  if (
    row.workspace_id !== create.workspace_id ||
    row.dossier_ref === null ||
    !SYNTHESIS_CREATE_DOSSIER_REFS.has(row.dossier_ref)
  ) {
    throw createAcceptedSynthesisCreateMismatch(row.proposal_id);
  }
}

function createAcceptedSynthesisCreateMismatch(proposalId: string): StorageError {
  return new StorageError(
    "CONFLICT",
    `Accepted synthesis create does not match proposal ${proposalId}.`
  );
}

function createStrictlyGovernedPathRelation(
  input: ReturnType<typeof parseAcceptedPathRelationGovernanceInput>
): Readonly<PathRelation> {
  return PathRelationSchema.parse({
    path_id: input.path_id_on_create,
    workspace_id: input.workspace_id,
    anchors: {
      source_anchor: { kind: "object", object_id: input.target_object_id },
      target_anchor: {
        kind: "object_facet",
        object_id: input.target_object_id,
        facet_key: "strictly_governed_constraint"
      }
    },
    constitution: {
      relation_kind: "governance_constraint",
      why_this_relation_exists: ["operator accepted strictly_governed governance promotion"]
    },
    effect_vector: {
      salience: 1,
      recall_bias: 1,
      verification_bias: 1,
      unfinishedness_bias: 0,
      default_manifestation_preference: "stance_bias"
    },
    plasticity_state: {
      strength: 1,
      direction_bias: "source_to_target",
      stability_class: "pinned",
      support_events_count: 1,
      contradiction_events_count: 0,
      last_reinforced_at: input.updated_at
    },
    lifecycle: {
      status: "active",
      retirement_rule: "manual"
    },
    legitimacy: {
      evidence_basis: [input.caused_by],
      governance_class: PathGovernanceClass.STRICTLY_GOVERNED
    },
    created_at: input.updated_at,
    updated_at: input.updated_at
  });
}

function createPathRelationFromProposalPayload(
  input: ReturnType<typeof parseAcceptedPathRelationGovernanceInput>,
  payload: Readonly<PathRelationProposalPayload>
): Readonly<PathRelation> {
  return PathRelationSchema.parse({
    path_id: input.path_id_on_create,
    workspace_id: input.workspace_id,
    anchors: {
      source_anchor: { kind: "object", object_id: input.target_object_id },
      target_anchor: payload.target_anchor
    },
    constitution: payload.constitution,
    effect_vector: payload.effect_vector,
    plasticity_state: {
      ...payload.plasticity_state,
      last_reinforced_at: payload.plasticity_state.last_reinforced_at ?? input.updated_at
    },
    lifecycle: payload.lifecycle,
    legitimacy: {
      ...payload.legitimacy,
      evidence_basis: appendUniqueEvidenceBasis(
        payload.legitimacy.evidence_basis,
        input.caused_by
      )
    },
    created_at: input.updated_at,
    updated_at: input.updated_at
  });
}

function applyPathRelationProposal(
  existing: Readonly<PathRelation>,
  input: ReturnType<typeof parseAcceptedPathRelationGovernanceInput>,
  payload: Readonly<PathRelationProposalPayload> | null
): Readonly<PathRelation> {
  const proposedLegitimacy = payload?.legitimacy ?? existing.legitimacy;
  return PathRelationSchema.parse({
    ...existing,
    legitimacy: {
      ...proposedLegitimacy,
      evidence_basis: appendUniqueEvidenceBasis(
        existing.legitimacy.evidence_basis,
        ...proposedLegitimacy.evidence_basis,
        input.caused_by
      ),
      governance_class:
        payload === null
          ? PathGovernanceClass.STRICTLY_GOVERNED
          : proposedLegitimacy.governance_class
    },
    updated_at: input.updated_at
  });
}

function pathRelationMatchesProposalPayload(
  relation: Readonly<PathRelation>,
  sourceObjectId: string,
  payload: Readonly<PathRelationProposalPayload>
): boolean {
  return (
    relation.anchors.source_anchor.kind === "object" &&
    relation.anchors.source_anchor.object_id === sourceObjectId &&
    serializePathAnchorRef(relation.anchors.target_anchor) ===
      serializePathAnchorRef(payload.target_anchor)
  );
}

function parseProposalPathRelationRow(row: ProposalPathRelationRow): Readonly<PathRelation> {
  return PathRelationSchema.parse({
    path_id: row.path_id,
    workspace_id: row.workspace_id,
    anchors: parseJsonField(row.anchors_json, "anchors"),
    constitution: parseJsonField(row.constitution_json, "constitution"),
    effect_vector: parseJsonField(row.effect_vector_json, "effect_vector"),
    plasticity_state: parseJsonField(row.plasticity_state_json, "plasticity_state"),
    lifecycle: parseJsonField(row.lifecycle_json, "lifecycle"),
    legitimacy: parseJsonField(row.legitimacy_json, "legitimacy"),
    created_at: row.created_at,
    updated_at: row.updated_at
  });
}

function parseJsonField(value: string, fieldName: string): unknown {
  try {
    return JSON.parse(value) as unknown;
  } catch (error) {
    throw new StorageError(
      "VALIDATION_FAILED",
      `Failed to parse path relation ${fieldName}.`,
      error
    );
  }
}

function appendUniqueEvidenceBasis(
  current: readonly string[],
  ...nextValues: readonly string[]
): readonly string[] {
  const result = [...current];
  for (const next of nextValues) {
    if (!result.includes(next)) {
      result.push(next);
    }
  }
  return result;
}

function proposedChangesMatch(
  stored: Readonly<MemoryEntryMutableFields>,
  supplied: Readonly<MemoryEntryMutableFields>
): boolean {
  return (
    stored.content === supplied.content &&
    stringArraysMatch(stored.domain_tags, supplied.domain_tags) &&
    stringArraysMatch(stored.evidence_refs, supplied.evidence_refs) &&
    stored.storage_tier === supplied.storage_tier &&
    stored.confidence === supplied.confidence &&
    stored.retention_state === supplied.retention_state
  );
}

function stringArraysMatch(
  left: readonly string[] | undefined,
  right: readonly string[] | undefined
): boolean {
  if (left === undefined || right === undefined) {
    return left === right;
  }

  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function shouldRevokeGreenForEvidenceRewrite(
  previousEvidenceRefs: readonly string[],
  nextEvidenceRefs: readonly string[]
): boolean {
  if (previousEvidenceRefs.length === 0) {
    return false;
  }
  const next = new Set(nextEvidenceRefs);
  return !previousEvidenceRefs.some((ref) => next.has(ref));
}

function toUpdatedFieldNames(fields: MemoryEntryMutableFields): string[] {
  const updatedFields: string[] = [];

  if (fields.content !== undefined) {
    updatedFields.push("content");
  }
  if (fields.domain_tags !== undefined) {
    updatedFields.push("domain_tags");
  }
  if (fields.evidence_refs !== undefined) {
    updatedFields.push("evidence_refs");
  }
  if (fields.storage_tier !== undefined) {
    updatedFields.push("storage_tier");
  }
  if (fields.confidence !== undefined) {
    updatedFields.push("confidence");
  }
  if (fields.retention_state !== undefined) {
    updatedFields.push("retention_state");
  }

  return updatedFields;
}

function parseProposalReviewerAssignment(
  input: ProposalReviewerAssignmentInput
): Readonly<ProposalReviewerAssignment> {
  return deepFreeze({
    proposal_id: parseProposalId(input.proposal_id),
    reviewer_identity: parseNonEmptyString(input.reviewer_identity, "reviewer_identity"),
    assigned_at: parseTimestamp(input.assigned_at),
    deadline_at: parseNullableTimestamp(input.deadline_at ?? null),
    escalation_after_ms: parseNullableNonNegativeInteger(
      input.escalation_after_ms ?? null,
      "escalation_after_ms"
    )
  });
}

function parseProposalReviewerAssignmentRow(
  row: ProposalReviewerAssignmentRow
): Readonly<ProposalReviewerAssignment> {
  return deepFreeze({
    proposal_id: parseProposalId(row.proposal_id),
    reviewer_identity: parseNonEmptyString(row.reviewer_identity, "reviewer_identity"),
    assigned_at: parseTimestamp(row.assigned_at),
    deadline_at: parseNullableTimestamp(row.deadline_at),
    escalation_after_ms: parseNullableNonNegativeInteger(
      row.escalation_after_ms,
      "escalation_after_ms"
    )
  });
}

function parseProposalResolutionState(state: ProposalResolutionState): ProposalResolutionState {
  try {
    return ProposalResolutionStateSchema.parse(state);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", "Failed to validate proposal resolution state.", error);
  }
}

function parseProposalId(value: string): string {
  return parseNonEmptyString(value, "proposal_id");
}

function parseWorkspaceId(value: string): string {
  return parseNonEmptyString(value, "workspace_id");
}

function parseRunId(value: string | null): string | null {
  return parseNullableString(value, "run_id");
}

function parseNullableTimestamp(value: string | null): string | null {
  return value === null ? null : parseTimestamp(value);
}

function parseNullableNonNegativeInteger(value: number | null, field: string): number | null {
  if (value === null) {
    return null;
  }
  if (!Number.isInteger(value) || value < 0) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate ${field}.`);
  }
  return value;
}

const parseUpdatedAt = parseTimestamp;
