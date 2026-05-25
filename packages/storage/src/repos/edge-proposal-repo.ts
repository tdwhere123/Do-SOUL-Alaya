import {
  EdgeProposalSchema,
  EdgeProposalStatus,
  EdgeProposalStatusSchema,
  EdgeProposalTriggerSourceSchema,
  MemoryGraphEdgeTypeSchema,
  type EdgeProposal,
  type EdgeProposalFilter,
  type EdgeProposalStatusValue
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import { parseNonEmptyString, parseTimestamp } from "./shared/validators.js";

export interface EdgeProposalCreateInput {
  readonly proposal_id: string;
  readonly workspace_id: string;
  readonly source_memory_id: string;
  readonly target_memory_id: string;
  readonly edge_type: EdgeProposal["edge_type"];
  readonly trigger_source: EdgeProposal["trigger_source"];
  readonly confidence: number;
  readonly reason: string | null;
  readonly source_signal_id: string | null;
  readonly run_id: string | null;
  readonly created_at: string;
  readonly expires_at: string | null;
}

export interface EdgeProposalReviewInput {
  readonly proposalId: string;
  readonly status: Extract<EdgeProposalStatusValue, "accepted" | "rejected" | "expired" | "auto_accepted">;
  readonly reviewerIdentity: string | null;
  readonly reviewReason: string | null;
  readonly reviewedAt: string;
}

export interface EdgeProposalRepo {
  create(input: EdgeProposalCreateInput): EdgeProposal;
  findById(proposalId: string): EdgeProposal | null;
  findPendingDuplicate(input: {
    readonly workspaceId: string;
    readonly sourceMemoryId: string;
    readonly targetMemoryId: string;
    readonly edgeType: EdgeProposal["edge_type"];
  }): EdgeProposal | null;
  listPending(workspaceId: string, filter?: EdgeProposalFilter): readonly EdgeProposal[];
  updateReview(input: EdgeProposalReviewInput): EdgeProposal;
}

interface EdgeProposalRow {
  readonly proposal_id: string;
  readonly workspace_id: string;
  readonly source_memory_id: string;
  readonly target_memory_id: string;
  readonly edge_type: string;
  readonly trigger_source: string;
  readonly confidence: number;
  readonly reason: string | null;
  readonly source_signal_id: string | null;
  readonly run_id: string | null;
  readonly status: string;
  readonly reviewer_identity: string | null;
  readonly review_reason: string | null;
  readonly created_at: string;
  readonly updated_at: string;
  readonly expires_at: string | null;
}

export class SqliteEdgeProposalRepo implements EdgeProposalRepo {
  private readonly createStatement;
  private readonly findByIdStatement;
  private readonly findPendingDuplicateStatement;
  private readonly updateReviewStatement;

  public constructor(private readonly db: StorageDatabase) {
    this.createStatement = db.connection.prepare(`
      INSERT INTO edge_proposals (
        proposal_id,
        workspace_id,
        source_memory_id,
        target_memory_id,
        edge_type,
        trigger_source,
        confidence,
        reason,
        source_signal_id,
        run_id,
        status,
        reviewer_identity,
        review_reason,
        created_at,
        updated_at,
        expires_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', NULL, NULL, ?, ?, ?)
    `);
    this.findByIdStatement = db.connection.prepare(`
      SELECT *
      FROM edge_proposals
      WHERE proposal_id = ?
      LIMIT 1
    `);
    this.findPendingDuplicateStatement = db.connection.prepare(`
      SELECT *
      FROM edge_proposals
      WHERE workspace_id = ?
        AND source_memory_id = ?
        AND target_memory_id = ?
        AND edge_type = ?
        AND status = 'pending'
      LIMIT 1
    `);
    this.updateReviewStatement = db.connection.prepare(`
      UPDATE edge_proposals
      SET status = ?,
          reviewer_identity = ?,
          review_reason = ?,
          updated_at = ?
      WHERE proposal_id = ?
        AND status = 'pending'
    `);
  }

  public create(input: EdgeProposalCreateInput): EdgeProposal {
    const parsed = parseCreateInput(input);

    try {
      this.createStatement.run(
        parsed.proposal_id,
        parsed.workspace_id,
        parsed.source_memory_id,
        parsed.target_memory_id,
        parsed.edge_type,
        parsed.trigger_source,
        parsed.confidence,
        parsed.reason,
        parsed.source_signal_id,
        parsed.run_id,
        parsed.created_at,
        parsed.created_at,
        parsed.expires_at
      );
      return this.findRequired(parsed.proposal_id);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to create edge proposal ${parsed.proposal_id}.`, error);
    }
  }

  public findById(proposalId: string): EdgeProposal | null {
    const parsedProposalId = parseNonEmptyString(proposalId, "proposal id");
    try {
      const row = this.findByIdStatement.get(parsedProposalId) as EdgeProposalRow | undefined;
      return row === undefined ? null : parseRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to load edge proposal ${parsedProposalId}.`, error);
    }
  }

  public findPendingDuplicate(input: {
    readonly workspaceId: string;
    readonly sourceMemoryId: string;
    readonly targetMemoryId: string;
    readonly edgeType: EdgeProposal["edge_type"];
  }): EdgeProposal | null {
    const workspaceId = parseNonEmptyString(input.workspaceId, "workspace id");
    const sourceMemoryId = parseNonEmptyString(input.sourceMemoryId, "source memory id");
    const targetMemoryId = parseNonEmptyString(input.targetMemoryId, "target memory id");
    const edgeType = MemoryGraphEdgeTypeSchema.parse(input.edgeType);
    try {
      const row = this.findPendingDuplicateStatement.get(
        workspaceId,
        sourceMemoryId,
        targetMemoryId,
        edgeType
      ) as EdgeProposalRow | undefined;
      return row === undefined ? null : parseRow(row);
    } catch (error) {
      throw new StorageError("QUERY_FAILED", "Failed to load duplicate edge proposal.", error);
    }
  }

  public listPending(workspaceId: string, filter: EdgeProposalFilter = {}): readonly EdgeProposal[] {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const conditions = ["workspace_id = ?", "status = 'pending'"];
    const args: unknown[] = [parsedWorkspaceId];

    if (filter.edge_type !== undefined) {
      conditions.push("edge_type = ?");
      args.push(MemoryGraphEdgeTypeSchema.parse(filter.edge_type));
    }
    if (filter.trigger_source !== undefined) {
      conditions.push("trigger_source = ?");
      args.push(EdgeProposalTriggerSourceSchema.parse(filter.trigger_source));
    }
    if (filter.min_confidence !== undefined) {
      conditions.push("confidence >= ?");
      args.push(filter.min_confidence);
    }
    if (filter.since !== undefined && filter.since !== null) {
      conditions.push("created_at >= ?");
      args.push(parseTimestamp(filter.since));
    }
    if (filter.proposal_ids !== undefined) {
      const ids = filter.proposal_ids.map((id) => parseNonEmptyString(id, "proposal id"));
      conditions.push(`proposal_id IN (${ids.map(() => "?").join(", ")})`);
      args.push(...ids);
    }
    const limit = filter.limit ?? 100;

    try {
      const rows = this.db.connection
        .prepare(
          `SELECT *
           FROM edge_proposals
           WHERE ${conditions.join(" AND ")}
           ORDER BY created_at ASC, proposal_id ASC
           LIMIT ?`
        )
        .all(...args, limit) as EdgeProposalRow[];
      return Object.freeze(rows.map((row) => parseRow(row)));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to list edge proposals for workspace ${parsedWorkspaceId}.`, error);
    }
  }

  public updateReview(input: EdgeProposalReviewInput): EdgeProposal {
    const proposalId = parseNonEmptyString(input.proposalId, "proposal id");
    const status = EdgeProposalStatusSchema.parse(input.status);
    const reviewerIdentity =
      input.reviewerIdentity === null ? null : parseNonEmptyString(input.reviewerIdentity, "reviewer identity");
    const reviewReason = input.reviewReason === null ? null : parseNonEmptyString(input.reviewReason, "review reason");
    const reviewedAt = parseTimestamp(input.reviewedAt);

    try {
      const result = this.updateReviewStatement.run(status, reviewerIdentity, reviewReason, reviewedAt, proposalId);
      if (result.changes === 0) {
        const existing = this.findById(proposalId);
        if (existing === null) {
          throw new StorageError("NOT_FOUND", `Edge proposal not found: ${proposalId}`);
        }
        throw new StorageError(
          "CONFLICT",
          `Edge proposal is not pending: ${proposalId} (${existing.status})`
        );
      }
      return this.findRequired(proposalId);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("QUERY_FAILED", `Failed to review edge proposal ${proposalId}.`, error);
    }
  }

  private findRequired(proposalId: string): EdgeProposal {
    const proposal = this.findById(proposalId);
    if (proposal === null) {
      throw new StorageError("NOT_FOUND", `Edge proposal not found after write: ${proposalId}`);
    }
    return proposal;
  }
}

function parseCreateInput(input: EdgeProposalCreateInput): EdgeProposalCreateInput {
  return {
    proposal_id: parseNonEmptyString(input.proposal_id, "proposal id"),
    workspace_id: parseNonEmptyString(input.workspace_id, "workspace id"),
    source_memory_id: parseNonEmptyString(input.source_memory_id, "source memory id"),
    target_memory_id: parseNonEmptyString(input.target_memory_id, "target memory id"),
    edge_type: MemoryGraphEdgeTypeSchema.parse(input.edge_type),
    trigger_source: EdgeProposalTriggerSourceSchema.parse(input.trigger_source),
    confidence: input.confidence,
    reason: input.reason === null ? null : parseNonEmptyString(input.reason, "reason"),
    source_signal_id: input.source_signal_id === null ? null : parseNonEmptyString(input.source_signal_id, "source signal id"),
    run_id: input.run_id === null ? null : parseNonEmptyString(input.run_id, "run id"),
    created_at: parseTimestamp(input.created_at),
    expires_at: input.expires_at === null ? null : parseTimestamp(input.expires_at)
  };
}

function parseRow(row: EdgeProposalRow): EdgeProposal {
  return deepFreeze(
    EdgeProposalSchema.parse({
      proposal_id: row.proposal_id,
      workspace_id: row.workspace_id,
      source_memory_id: row.source_memory_id,
      target_memory_id: row.target_memory_id,
      edge_type: row.edge_type,
      trigger_source: row.trigger_source,
      confidence: row.confidence,
      reason: row.reason,
      source_signal_id: row.source_signal_id,
      run_id: row.run_id,
      status: row.status,
      reviewer_identity: row.reviewer_identity,
      review_reason: row.review_reason,
      created_at: row.created_at,
      updated_at: row.updated_at,
      expires_at: row.expires_at
    })
  );
}

export const EDGE_PROPOSAL_PENDING_STATUS = EdgeProposalStatus.PENDING;
