import type { Proposal } from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { StorageError } from "../../shared/errors.js";
import { deepFreeze } from "../shared/deep-freeze.js";
import { parseNonEmptyString, parseTimestamp } from "../shared/validators.js";
import { parseProposalId, parseProposalReviewerAssignment, parseProposalReviewerAssignmentRow, parseProposalRow, parseProposedChanges, parseSourceDeliveryIds, parseWorkspaceId } from "./mappers.js";
import { parseProposedPathRelation } from "./path-relations.js";
import type { PendingProposalSummaryRow, ProposalReviewerAssignmentRow, ProposalRow } from "./rows.js";
import type { ProposalStatements } from "./sqlite-proposal-statements.js";
import { SQLITE_VARIABLE_CHUNK_SIZE, type FindPendingSummariesOptions, type PendingProposalSummary, type ProposalListPageOptions, type ProposalReviewerAssignment, type ProposalReviewerAssignmentInput, type ScopedProposal } from "./types.js";

interface PendingSummariesQuery {
  readonly sql: string;
  readonly params: readonly (string | number)[];
}

export class ProposalReadQueries {
  public constructor(
    private readonly db: StorageDatabase,
    private readonly statements: ProposalStatements
  ) {}

  public async findById(proposalId: string): Promise<Readonly<Proposal> | null> {
    try {
      const row = this.statements.findByIdStatement.get(proposalId) as ProposalRow | undefined;
      return row === undefined ? null : parseProposalRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load proposal ${proposalId}.`, error);
    }
  }

  public async findScopedById(proposalId: string): Promise<Readonly<ScopedProposal> | null> {
    try {
      const row = this.statements.findByIdStatement.get(proposalId) as ProposalRow | undefined;
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
          ? (this.statements.findByWorkspaceIdStatement.all(parsedWorkspaceId) as ProposalRow[])
          : (this.statements.findByWorkspaceIdPagedStatement.all(parsedWorkspaceId, page.limit, page.offset) as ProposalRow[]);
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
      const row = this.statements.countByWorkspaceIdStatement.get(parsedWorkspaceId) as
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
          ? (this.statements.findPendingStatement.all(parsedWorkspaceId) as ProposalRow[])
          : (this.statements.findPendingPagedStatement.all(parsedWorkspaceId, page.limit, page.offset) as ProposalRow[]);
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
      const row = this.statements.countPendingStatement.get(parsedWorkspaceId) as
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
    const referenceTime = parseTimestamp(options.now ?? new Date().toISOString());
    const query = buildPendingSummariesQuery(parsedWorkspaceId, referenceTime, options);

    try {
      const rows = this.db.connection.prepare(query.sql).all(...query.params) as PendingProposalSummaryRow[];
      return rows.map((row) => parsePendingProposalSummary(row));
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
      const row = this.statements.findPendingByRunIdStatement.get(parsedRunId) as ProposalRow | undefined;
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


  private insertReviewerAssignment(assignment: ProposalReviewerAssignment): void {
    this.statements.assignReviewerStatement.run(
      assignment.proposal_id,
      assignment.reviewer_identity,
      assignment.assigned_at,
      assignment.deadline_at,
      assignment.escalation_after_ms
    );
  }

  private findReviewerAssignmentRow(proposalId: string): Readonly<ProposalReviewerAssignment> | null {
    const row = this.statements.findReviewerAssignmentStatement.get(proposalId) as
      | ProposalReviewerAssignmentRow
      | undefined;
    return row === undefined ? null : parseProposalReviewerAssignmentRow(row);
  }
}

function buildPendingSummariesQuery(
  workspaceId: string,
  referenceTime: string,
  options: FindPendingSummariesOptions
): PendingSummariesQuery {
  const params: (string | number)[] = [referenceTime, workspaceId];
  const since = options.since ?? null;
  const limit = options.limit ?? null;
  let sql = `${PENDING_SUMMARIES_SELECT_SQL}
      WHERE p.workspace_id = ? AND p.resolution_state = 'pending'`;
  if (since !== null) {
    sql += " AND p.created_at > ?";
    params.push(since);
  }
  sql += " ORDER BY p.created_at DESC, p.proposal_id DESC";
  if (limit !== null) {
    sql += " LIMIT ?";
    params.push(limit);
  }
  return { sql, params };
}

const PENDING_SUMMARIES_SELECT_SQL = `
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
        ON a.proposal_id = p.proposal_id`;

function parsePendingProposalSummary(
  row: PendingProposalSummaryRow
): Readonly<PendingProposalSummary> {
  return deepFreeze({
    proposal_id: row.proposal_id,
    target_object_id: row.derived_from ?? row.runtime_id,
    target_object_kind: row.target_object_kind,
    created_at: row.created_at ?? row.last_updated_at,
    proposed_change_summary: row.proposed_change_summary,
    proposed_changes: parseProposedChanges(row.proposed_changes),
    assigned_reviewer_identity: row.assigned_reviewer_identity,
    assigned_at: row.assigned_at,
    deadline_at: row.deadline_at,
    is_overdue: row.is_overdue === 1
  });
}
