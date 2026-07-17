import {
  EdgeProposalStatus,
  EdgeProposalStatusSchema,
  EdgeProposalTriggerSourceSchema,
  MemoryGraphEdgeTypeSchema,
  type EdgeProposal,
  type EdgeProposalFilter,
  type EdgeProposalStatusValue
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../../sqlite/db.js";
import { assertLegacyPathRelationReadAllowed } from "../../sqlite/temporal-projection-selection.js";
import { StorageError } from "../../shared/errors.js";
import {
  edgeProposalPathIdentity,
  isUniqueConstraintError,
  parseCreateInput,
  parseEdgeProposalRow,
  type EdgeProposalRow
} from "./edge-proposal-rows.js";
import {
  prepareEdgeProposalStatements,
  type EdgeProposalStatements
} from "./edge-proposal-statements.js";
import {
  type EdgeProposalCreateInput,
  type EdgeProposalMintFailureReconcileInput,
  type EdgeProposalRepo,
  type EdgeProposalReviewInput
} from "./edge-proposal-types.js";
import { parseNonEmptyString, parseTimestamp } from "../shared/validators.js";

export type {
  EdgeProposalCreateInput,
  EdgeProposalMintFailureReconcileInput,
  EdgeProposalRepo,
  EdgeProposalReviewInput
} from "./edge-proposal-types.js";

interface ParsedMintFailureReconcileInput {
  readonly proposalId: string;
  readonly fromStatus: EdgeProposalStatusValue;
  readonly toStatus: EdgeProposalStatusValue;
  readonly reviewerIdentity: string | null;
  readonly reviewReason: string | null;
  readonly supersededReviewerIdentity: string | null;
  readonly supersededReviewReason: string | null;
  readonly reviewedAt: string;
}

export class SqliteEdgeProposalRepo implements EdgeProposalRepo {
  private readonly statements: EdgeProposalStatements;

  public constructor(private readonly db: StorageDatabase) {
    this.statements = prepareEdgeProposalStatements(db);
  }

  public create(input: EdgeProposalCreateInput): EdgeProposal {
    const parsed = parseCreateInput(input);

    try {
      this.statements.createStatement.run(
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
      const row = this.statements.findByIdStatement.get(parsedProposalId) as EdgeProposalRow | undefined;
      return row === undefined ? null : parseEdgeProposalRow(row);
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
      const row = this.statements.findPendingDuplicateStatement.get(
        workspaceId,
        sourceMemoryId,
        targetMemoryId,
        edgeType
      ) as EdgeProposalRow | undefined;
      return row === undefined ? null : parseEdgeProposalRow(row);
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
      return Object.freeze(rows.map((row) => parseEdgeProposalRow(row)));
    } catch (error) {
      throw new StorageError("QUERY_FAILED", `Failed to list edge proposals for workspace ${parsedWorkspaceId}.`, error);
    }
  }

  public listExpiredPending(workspaceId: string, nowIso: string, limit: number): readonly EdgeProposal[] {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    const now = parseTimestamp(nowIso);
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new StorageError("VALIDATION_FAILED", `listExpiredPending limit must be a positive integer: ${limit}`);
    }
    try {
      const rows = this.db.connection
        .prepare(
          `SELECT *
           FROM edge_proposals
           WHERE workspace_id = ?
             AND status = 'pending'
             AND expires_at IS NOT NULL
             AND expires_at < ?
           ORDER BY expires_at ASC, proposal_id ASC
           LIMIT ?`
        )
        .all(parsedWorkspaceId, now, limit) as EdgeProposalRow[];
      return Object.freeze(rows.map((row) => parseEdgeProposalRow(row)));
    } catch (error) {
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list expired pending edge proposals for workspace ${parsedWorkspaceId}.`,
        error
      );
    }
  }

  public listAcceptedAwaitingPath(workspaceId: string, limit: number): readonly EdgeProposal[] {
    const parsedWorkspaceId = parseNonEmptyString(workspaceId, "workspace id");
    if (!Number.isInteger(limit) || limit <= 0) {
      throw new StorageError("VALIDATION_FAILED", `listAcceptedAwaitingPath limit must be a positive integer: ${limit}`);
    }
    assertLegacyPathRelationReadAllowed(this.db.connection);
    try {
      const awaiting: EdgeProposalRow[] = [];
      const batchSize = Math.max(limit, 64);
      let offset = 0;

      while (awaiting.length < limit) {
        const rows = this.statements.listAcceptedAwaitingPathStatement.all(
          parsedWorkspaceId,
          batchSize,
          offset
        ) as EdgeProposalRow[];
        if (rows.length === 0) {
          break;
        }

        for (const row of rows) {
          if (!this.acceptedProposalHasPath(row)) {
            awaiting.push(row);
            if (awaiting.length === limit) {
              break;
            }
          }
        }

        offset += rows.length;
        if (rows.length < batchSize) {
          break;
        }
      }

      return Object.freeze(awaiting.map((row) => parseEdgeProposalRow(row)));
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError(
        "QUERY_FAILED",
        `Failed to list accepted edge proposals awaiting path for workspace ${parsedWorkspaceId}.`,
        error
      );
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
      const result = this.statements.updateReviewStatement.run(status, reviewerIdentity, reviewReason, reviewedAt, proposalId);
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

  public reconcileAfterMintFailure(input: EdgeProposalMintFailureReconcileInput): EdgeProposal {
    const parsed = parseMintFailureReconcileInput(input);

    try {
      const fallback = this.applyMintFailureReconcile(parsed);
      if (fallback !== null) {
        return fallback;
      }
      return this.findRequired(parsed.proposalId);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("QUERY_FAILED", `Failed to reconcile edge proposal ${parsed.proposalId}.`, error);
    }
  }

  private applyMintFailureReconcile(parsed: ParsedMintFailureReconcileInput): EdgeProposal | null {
    try {
      const result = this.runMintFailureReconcileUpdate(parsed);
      if (result.changes === 0) {
        this.throwReconcileConflict(parsed.proposalId, parsed.fromStatus);
      }
      return null;
    } catch (error) {
      if (shouldSupersedeMintFailureReconcile(parsed, error)) {
        return this.reconcileToSupersededRejected(
          parsed.proposalId,
          parsed.fromStatus,
          parsed.supersededReviewerIdentity,
          parsed.supersededReviewReason,
          parsed.reviewedAt
        );
      }
      throw error;
    }
  }

  private runMintFailureReconcileUpdate(parsed: ParsedMintFailureReconcileInput): { readonly changes: number } {
    return this.statements.reconcileAfterMintFailureStatement.run(
      parsed.toStatus,
      parsed.reviewerIdentity,
      parsed.reviewReason,
      parsed.reviewedAt,
      parsed.proposalId,
      parsed.fromStatus
    );
  }

  private throwReconcileConflict(proposalId: string, fromStatus: EdgeProposalStatusValue): never {
    const existing = this.findById(proposalId);
    if (existing === null) {
      throw new StorageError("NOT_FOUND", `Edge proposal not found: ${proposalId}`);
    }
    throw new StorageError(
      "CONFLICT",
      `Edge proposal is not in ${fromStatus}: ${proposalId} (${existing.status})`
    );
  }

  // invariant: terminal fallback for a revert-to-pending that hit the
  // pending-unique collision. `rejected` is not under the partial index
  // (predicate is status='pending'), so this UPDATE never collides. CAS-gated on
  // fromStatus exactly like the primary reconcile so a concurrent decision is
  // still never clobbered.
  private reconcileToSupersededRejected(
    proposalId: string,
    fromStatus: EdgeProposalStatusValue,
    reviewerIdentity: string | null,
    reviewReason: string | null,
    reviewedAt: string
  ): EdgeProposal {
    const parsedReviewerIdentity =
      reviewerIdentity === null ? null : parseNonEmptyString(reviewerIdentity, "reviewer identity");
    const parsedReviewReason =
      reviewReason === null ? null : parseNonEmptyString(reviewReason, "review reason");
    const result = this.statements.reconcileAfterMintFailureStatement.run(
      EdgeProposalStatus.REJECTED,
      parsedReviewerIdentity,
      parsedReviewReason,
      reviewedAt,
      proposalId,
      fromStatus
    );
    if (result.changes === 0) {
      this.throwReconcileConflict(proposalId, fromStatus);
    }
    return this.findRequired(proposalId);
  }

  // Test-only seam: the SQL text the repo actually prepared for the await-path
  // sweep. Returning .source from the live prepared statement lets the EXPLAIN
  // QUERY PLAN guard prove the planner rides the migration 048 anchor-key
  // expression indexes against the REAL statement, not a reconstruction that
  // could silently drift from it.
  // cross-file ref: packages/storage/src/__tests__/edge-proposal-repo.test.ts
  public __awaitingPathSqlForTest(): string {
    return (this.statements.listAcceptedAwaitingPathStatement as { readonly source: string }).source;
  }

  // Test-only seam: the SQL text for the parameter-bound path-exists probe.
  // This is the query whose planner contract matters for path_relations:
  // SEARCH the migration 087 backing-object expression indexes, never SCAN.
  // cross-file ref: packages/storage/src/__tests__/edge-proposal-repo.test.ts
  public __pathExistsSqlForTest(): Readonly<{
    readonly positiveRecalls: string;
    readonly directional: string;
  }> {
    return Object.freeze({
      positiveRecalls: (this.statements.acceptedPositiveRecallsPathExistsStatement as { readonly source: string }).source,
      directional: (this.statements.acceptedDirectionalPathExistsStatement as { readonly source: string }).source
    });
  }

  private acceptedProposalHasPath(row: EdgeProposalRow): boolean {
    const identity = edgeProposalPathIdentity(row.edge_type);
    const existing = identity.isPositiveRecallsFamily
      ? this.statements.acceptedPositiveRecallsPathExistsStatement.get(
          row.workspace_id,
          row.source_memory_id,
          row.target_memory_id,
          row.workspace_id,
          row.target_memory_id,
          row.source_memory_id
        )
      : this.statements.acceptedDirectionalPathExistsStatement.get(
          row.workspace_id,
          row.source_memory_id,
          row.target_memory_id,
          identity.relationKind,
          identity.sign,
          identity.sign,
          identity.sign
        );
    return existing !== undefined;
  }

  private findRequired(proposalId: string): EdgeProposal {
    const proposal = this.findById(proposalId);
    if (proposal === null) {
      throw new StorageError("NOT_FOUND", `Edge proposal not found after write: ${proposalId}`);
    }
    return proposal;
  }
}

function parseMintFailureReconcileInput(input: EdgeProposalMintFailureReconcileInput): ParsedMintFailureReconcileInput {
  return {
    proposalId: parseNonEmptyString(input.proposalId, "proposal id"),
    fromStatus: EdgeProposalStatusSchema.parse(input.fromStatus),
    toStatus: EdgeProposalStatusSchema.parse(input.toStatus),
    reviewerIdentity: parseNullableNonEmptyString(input.reviewerIdentity, "reviewer identity"),
    reviewReason: parseNullableNonEmptyString(input.reviewReason, "review reason"),
    supersededReviewerIdentity: parseNullableNonEmptyString(
      input.supersededReviewerIdentity ?? null,
      "superseded reviewer identity"
    ),
    supersededReviewReason: parseNullableNonEmptyString(
      input.supersededReviewReason ?? null,
      "superseded review reason"
    ),
    reviewedAt: parseTimestamp(input.reviewedAt)
  };
}

function parseNullableNonEmptyString(value: string | null, fieldName: string): string | null {
  return value === null ? null : parseNonEmptyString(value, fieldName);
}

function shouldSupersedeMintFailureReconcile(parsed: ParsedMintFailureReconcileInput, error: unknown): boolean {
  return parsed.toStatus === EdgeProposalStatus.PENDING && isUniqueConstraintError(error);
}

export const EDGE_PROPOSAL_PENDING_STATUS = EdgeProposalStatus.PENDING;
