import {
  type EventLogEntry,
  type MemoryEntry,
  type PathRelation,
  type Proposal,
  type ProposalResolutionState,
  type SynthesisCapsule
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { MEMORY_ENTRY_SELECT_COLUMNS } from "../memory-entry/row-mapper.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { getEventLogWriter, insertEventLogEntry } from "../shared/event-log-writer.js";
import { parseNonEmptyString, parseTimestamp } from "../shared/validators.js";
import {
  acceptPendingMemoryUpdateWithEvents,
  acceptPendingPathRelationGovernanceWithEvents,
  acceptPendingSynthesisCreateWithEvents,
  type SqliteProposalWorkflowContext
} from "./accept-workflows.js";
import {
  parseNullableTimestamp,
  parseProposal,
  parseProposalId,
  parseProposalResolutionState,
  parseProposalReviewerAssignment,
  parseProposalReviewerAssignmentRow,
  parseProposalRow,
  parseProposedChanges,
  parseRunId,
  parseSourceDeliveryIds,
  parseUpdatedAt,
  parseWorkspaceId,
  serializeProposedChanges,
  serializeSourceDeliveryIds
} from "./mappers.js";
import { parseProposedPathRelation, serializeProposedPathRelation } from "./path-relations.js";
import {
  PROPOSAL_SELECT_COLUMNS,
  type PendingProposalSummaryRow,
  type ProposalReviewerAssignmentRow,
  type ProposalRow
} from "./rows.js";
import {
  SQLITE_VARIABLE_CHUNK_SIZE,
  type AcceptedMemoryUpdateInput,
  type AcceptedPathRelationGovernanceInput,
  type AcceptedSynthesisCreateInput,
  type CreateProposalWithEventsOptions,
  type FindPendingSummariesOptions,
  type PendingProposalSummary,
  type ProposalListPageOptions,
  type ProposalCreateInput,
  type ProposalCreationEventInput,
  type ProposalRepo,
  type ProposalResolutionEventInput,
  type ProposalReviewerAssignment,
  type ProposalReviewerAssignmentInput,
  type ScopedProposal,
  type UpdatePendingResolutionOptions
} from "./types.js";

export class SqliteProposalRepo implements ProposalRepo {
  private readonly createStatement;
  private readonly findByIdStatement;
  private readonly findByWorkspaceIdStatement;
  private readonly findByWorkspaceIdPagedStatement;
  private readonly countByWorkspaceIdStatement;
  private readonly findPendingStatement;
  private readonly findPendingPagedStatement;
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
    this.findByWorkspaceIdPagedStatement = db.connection.prepare(`
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE workspace_id = ?
      ORDER BY last_updated_at DESC, proposal_id DESC
      LIMIT ? OFFSET ?
    `);
    this.countByWorkspaceIdStatement = db.connection.prepare(`
      SELECT COUNT(*) AS total
      FROM proposals
      WHERE workspace_id = ?
    `);

    this.findPendingStatement = db.connection.prepare(`
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE workspace_id = ? AND resolution_state = 'pending'
      ORDER BY last_updated_at DESC, proposal_id DESC
    `);
    this.findPendingPagedStatement = db.connection.prepare(`
      SELECT${PROPOSAL_SELECT_COLUMNS}
      FROM proposals
      WHERE workspace_id = ? AND resolution_state = 'pending'
      ORDER BY last_updated_at DESC, proposal_id DESC
      LIMIT ? OFFSET ?
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

  public async findByWorkspaceId(
    workspaceId: string,
    page?: ProposalListPageOptions
  ): Promise<readonly Readonly<Proposal>[]> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);

    try {
      const rows =
        page === undefined
          ? (this.findByWorkspaceIdStatement.all(parsedWorkspaceId) as ProposalRow[])
          : (this.findByWorkspaceIdPagedStatement.all(parsedWorkspaceId, page.limit, page.offset) as ProposalRow[]);
      return rows.map((row) => parseProposalRow(row));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list proposals for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async countByWorkspaceId(workspaceId: string): Promise<number> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);

    try {
      const row = this.countByWorkspaceIdStatement.get(parsedWorkspaceId) as
        | { readonly total: number }
        | undefined;
      return row === undefined ? 0 : Number(row.total);
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to count proposals for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public async findPending(
    workspaceId: string,
    page?: ProposalListPageOptions
  ): Promise<readonly Readonly<Proposal>[]> {
    const parsedWorkspaceId = parseWorkspaceId(workspaceId);

    try {
      const rows =
        page === undefined
          ? (this.findPendingStatement.all(parsedWorkspaceId) as ProposalRow[])
          : (this.findPendingPagedStatement.all(parsedWorkspaceId, page.limit, page.offset) as ProposalRow[]);
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
    return await acceptPendingMemoryUpdateWithEvents(
      this.createWorkflowContext(),
      proposalId,
      updatedAt,
      events,
      memoryUpdate,
      options
    );
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
    return await acceptPendingPathRelationGovernanceWithEvents(
      this.createWorkflowContext(),
      proposalId,
      updatedAt,
      events,
      pathRelationGovernance,
      options
    );
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
    return await acceptPendingSynthesisCreateWithEvents(
      this.createWorkflowContext(),
      proposalId,
      updatedAt,
      events,
      synthesisCreate,
      options
    );
  }

  private createWorkflowContext(): SqliteProposalWorkflowContext {
    return {
      db: this.db,
      eventLogWriter: this.eventLogWriter,
      findByIdStatement: this.findByIdStatement,
      findMemoryEntryByIdStatement: this.findMemoryEntryByIdStatement,
      updateMemoryEntryStatement: this.updateMemoryEntryStatement,
      findRevokableGreenStatusStatement: this.findRevokableGreenStatusStatement,
      revokeGreenStatusStatement: this.revokeGreenStatusStatement,
      updatePendingResolutionStatement: this.updatePendingResolutionStatement,
      updatePendingResolutionWithIdentityStatement: this.updatePendingResolutionWithIdentityStatement,
      findPathRelationByAnchorMemoryIdStatement: this.findPathRelationByAnchorMemoryIdStatement,
      createPathRelationStatement: this.createPathRelationStatement,
      updatePathRelationLegitimacyStatement: this.updatePathRelationLegitimacyStatement,
      createSynthesisCapsuleStatement: this.createSynthesisCapsuleStatement,
      createPendingResolutionFailure: (proposalId) => this.createPendingResolutionFailure(proposalId)
    };
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
