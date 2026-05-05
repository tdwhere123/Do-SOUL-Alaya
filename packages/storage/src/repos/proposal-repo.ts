import {
  MemoryGovernanceEventType,
  ProposalResolutionStateSchema,
  ProposalSchema,
  PublicMemoryEntryMutableFieldsSchema,
  SoulMemoryUpdatedPayloadSchema,
  type EventLogEntry,
  type MemoryEntry,
  type MemoryEntryMutableFields,
  type Proposal,
  type ProposalResolutionState
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
  // D2 MERGED-I19 (architect-I2): `target_object_kind` is now REQUIRED.
  // Migration `058-reviewer-identity.sql` left
  // `target_object_kind TEXT NOT NULL DEFAULT 'memory_entry'` as a
  // one-time backfill for pre-A1 rows; the default would silently
  // mislabel future inserts that omit the column. Type-system
  // enforcement is cheaper than dropping the SQL default (SQLite has
  // no `ALTER COLUMN ... DROP DEFAULT`). All three current production
  // callers pass it explicitly: `'memory_entry'` for
  // `soul.propose_memory_update` (mcp-memory-proposal-workflow.ts),
  // `'synthesis_capsule'` for `ProposalService.createFromSynthesisPromotion`
  // (proposal-service.ts), and `'bankruptcy_dossier'` for the budget
  // bankruptcy path (budget-wiring.ts).
  readonly target_object_kind: string;
  readonly proposed_change_summary?: string;
  readonly proposed_changes?: MemoryEntryMutableFields | null;
  readonly created_at?: string;
}

export interface ScopedProposal {
  readonly proposal: Readonly<Proposal>;
  readonly workspace_id: string;
  readonly run_id: string | null;
  // A1 — null until the proposal is reviewed; carries the explicit
  // reviewer identity once review_memory_proposal completes.
  readonly reviewer_identity: string | null;
  readonly reviewer_assignment: Readonly<ProposalReviewerAssignment> | null;
  // Phase 6 — scoped governance payload. Stored for accept-as-apply
  // workflow only; intentionally not exposed through the public Proposal
  // domain projection returned by findById/findPending.
  readonly proposed_changes: Readonly<MemoryEntryMutableFields> | null;
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

export interface UpdatePendingResolutionOptions {
  readonly reviewerIdentity?: string;
}

export interface AcceptedMemoryUpdateInput {
  readonly target_object_id: string;
  readonly workspace_id: string;
  readonly proposed_changes: MemoryEntryMutableFields;
  readonly updated_at: string;
  readonly caused_by: string;
}

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
  findPendingSummaries(
    workspaceId: string,
    options?: FindPendingSummariesOptions
  ): Promise<readonly Readonly<PendingProposalSummary>[]>;
  findPendingByRunId(runId: string): Promise<Readonly<Proposal> | null>;
  assignReviewer(input: ProposalReviewerAssignmentInput): Promise<Readonly<ProposalReviewerAssignment>>;
  findReviewerAssignment(proposalId: string): Promise<Readonly<ProposalReviewerAssignment> | null>;
  // A1 fix-loop (finding-5): reviewerIdentity is optional at the repo
  // boundary so legacy callers (claim-promotion flows, fixtures) keep
  // compiling, but every code path that should write
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
        created_at
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
  // Scope metadata — available for workspace validation, not exposed in domain type.
  readonly workspace_id: string;
  readonly run_id: string | null;
  // A1 — review identity + HITL summary projection columns.
  readonly reviewer_identity: string | null;
  readonly target_object_kind: string;
  readonly proposed_change_summary: string;
  readonly proposed_changes: string | null;
  readonly created_at: string | null;
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

export class SqliteProposalRepo implements ProposalRepo {
  private readonly createStatement;
  private readonly findByIdStatement;
  private readonly findByWorkspaceIdStatement;
  private readonly findPendingStatement;
  private readonly findPendingByRunIdStatement;
  private readonly assignReviewerStatement;
  private readonly findReviewerAssignmentStatement;
  private readonly updateResolutionStatement;
  private readonly updateResolutionWithIdentityStatement;
  private readonly updatePendingResolutionStatement;
  private readonly updatePendingResolutionWithIdentityStatement;
  private readonly findMemoryEntryByIdStatement;
  private readonly updateMemoryEntryStatement;
  private readonly eventLogWriter;

  public constructor(private readonly db: StorageDatabase) {
    // A1 — INSERT now also writes the HITL projection columns
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
        created_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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

    // A1 fix-loop (finding-5): companion statement for the legacy
    // updateResolution path that also persists reviewer_identity.
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
        updated_at = ?
      WHERE object_id = ?
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
    const createdAt = input.created_at ?? parsedProposal.last_updated_at;

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
        createdAt
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
    const createdAt = input.created_at ?? parsedProposal.last_updated_at;
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
          createdAt
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
            reviewer_identity: row.reviewer_identity,
            reviewer_assignment: assignment,
            proposed_changes: parseProposedChanges(row.proposed_changes)
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

  // A1 (HITL daemon backbone) — projects pending rows into the
  // soul.list_pending_proposals summary shape. Built dynamically so the
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
      // D2 MERGED-I2 (reviewer-I3): exclusive `>` cursor semantics.
      // HITL pollers pass the timestamp of their most-recent record as
      // `since`; an inclusive `>=` returns the boundary record on every
      // subsequent poll. Mirrors A3's deliberate exclusive `>` choice
      // for usage records (see path-plasticity-runtime.ts docstring).
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
    // A1 fix-loop (finding-5): persist reviewer_identity through the
    // legacy update path. Empty/whitespace identities are rejected;
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
    // A1 — empty/whitespace identities are rejected; if the caller did
    // not pass reviewerIdentity (legacy callers, e.g. claim-promotion
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
        const memoryResult = this.updateMemoryEntryStatement.run(
          parsedFields.content ?? null,
          parsedFields.domain_tags === undefined ? null : JSON.stringify(parsedFields.domain_tags),
          parsedFields.evidence_refs === undefined ? null : JSON.stringify(parsedFields.evidence_refs),
          parsedFields.storage_tier ?? null,
          parsedFields.updated_at,
          parsedMemoryUpdate.target_object_id
        );
        if (memoryResult.changes === 0) {
          throw new StorageError(
            "NOT_FOUND",
            `Memory entry ${parsedMemoryUpdate.target_object_id} was not found during update.`
          );
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

        const proposalRow = this.findByIdStatement.get(parsedProposalId) as ProposalRow | undefined;
        if (proposalRow === undefined) {
          throw new StorageError("NOT_FOUND", `Proposal ${parsedProposalId} was not found after update.`);
        }

        return deepFreeze({
          proposal: parseProposalRow(proposalRow),
          memory: updatedMemory,
          events: [...storedReviewEvents, memoryEvent]
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

function parseAcceptedMemoryUpdateInput(
  input: AcceptedMemoryUpdateInput
): Readonly<{
  readonly target_object_id: string;
  readonly workspace_id: string;
  readonly proposed_changes: MemoryEntryMutableFields & { readonly updated_at: string };
  readonly caused_by: string;
}> {
  const parsedChanges = parseUpdateFields({
    ...PublicMemoryEntryMutableFieldsSchema.parse(input.proposed_changes),
    updated_at: parseUpdatedAt(input.updated_at)
  });

  return deepFreeze({
    target_object_id: parseNonEmptyString(input.target_object_id, "target_object_id"),
    workspace_id: parseWorkspaceId(input.workspace_id),
    proposed_changes: parsedChanges,
    caused_by: parseNonEmptyString(input.caused_by, "caused_by")
  });
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
