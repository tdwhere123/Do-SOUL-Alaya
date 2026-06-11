import {
  EdgeProposalSchema,
  EdgeProposalStatus,
  EdgeProposalStatusSchema,
  EdgeProposalTriggerSourceSchema,
  MEMORY_GRAPH_EDGE_RECALL_WEIGHTS,
  MemoryGraphEdgeTypeSchema,
  type EdgeProposal,
  type EdgeProposalFilter,
  type EdgeProposalStatusValue
} from "@do-soul/alaya-protocol";
import type { StorageDatabase } from "../db.js";
import { StorageError } from "../errors.js";
import { deepFreeze } from "./shared/deep-freeze.js";
import {
  PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL,
  PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL
} from "./path-relation-repo.js";
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

// invariant: compensating transition out of the accepted-without-path state.
// fromStatus is CAS-gated so a concurrent decision is never clobbered: only a
// row still in the accept-just-committed status moves. toStatus is `pending`
// for a transient mint failure (retryable through the pending review surface)
// or `rejected` for a permanent anchor refusal (terminal, leaves the list).
// invariant: when toStatus is `pending` and a DUPLICATE pending row already
// holds this tuple (an auto-producer / soul.propose_edge re-proposal P2 minted
// while P1 sat accepted, because create dedups only vs status='pending'),
// reverting P1 to pending collides with idx_edge_proposals_pending_unique
// (migration 081). Rather than letting that SQLITE_CONSTRAINT roll back the
// caller's audit+reconcile transaction, the repo falls back to a TERMINAL
// `rejected` carrying supersededReviewReason — P2 carries the retry, so P1 has
// no owed-path obligation and the mint-failed audit still commits.
// see also: core/src/path-graph/edge-proposal-service.ts handleMintFailure.
export interface EdgeProposalMintFailureReconcileInput {
  readonly proposalId: string;
  readonly fromStatus: Extract<EdgeProposalStatusValue, "accepted" | "auto_accepted">;
  readonly toStatus: Extract<EdgeProposalStatusValue, "pending" | "rejected">;
  readonly reviewerIdentity: string | null;
  readonly reviewReason: string | null;
  readonly reviewedAt: string;
  // review_reason stamped on the terminal `rejected` fallback when a
  // revert-to-pending would collide with an existing pending duplicate.
  // Required only when toStatus is `pending`; ignored otherwise.
  readonly supersededReviewReason?: string | null;
  // reviewer_identity stamped on the superseded terminal fallback. A
  // revert-to-pending normally clears the reviewer (null); the superseded
  // fallback re-stamps it so the terminal rejection is attributable.
  readonly supersededReviewerIdentity?: string | null;
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
  // invariant: returns pending proposals whose expires_at is non-null AND has
  // passed nowIso, oldest-expiry-first and bounded by limit. The TTL sweep reads
  // these and flips each to `expired` through updateReview (CAS-gated on
  // status='pending'). A null expires_at is never selected — only proposals
  // born with a TTL are sweepable, so legacy/null-TTL rows are untouched.
  // see also: packages/core/src/path-graph/edge-proposal-service.ts sweepExpired
  // see also: apps/core-daemon/src/garden-runtime.ts sweepExpiredEdgeProposals
  listExpiredPending(workspaceId: string, nowIso: string, limit: number): readonly EdgeProposal[];
  // invariant: returns ONLY accepted / auto_accepted proposals that still owe a
  // path — a crash after the accept review row committed but before the mint
  // landed strands such a row with no path and invisible to listPending (which
  // filters status='pending'). Rows whose owed path already landed are filtered
  // against the mint's own anchor dedup, so a backlog of healthy
  // accepts can never exhaust `limit` and starve a genuine orphan behind them.
  // The daemon reconcile sweep reads these, oldest first, to re-drive the owed
  // mint idempotently. Returned rows are bounded by `limit`; accepted
  // candidates are paged through the status/time index until enough true
  // orphans are found or the accepted set is exhausted.
  // see also: core/src/path-graph/edge-proposal-service.ts reconcileStuckAccepts;
  //   path-relation-repo.ts PATH_RELATION_*_BACKING_OBJECT_ID_SQL (the await-path match).
  listAcceptedAwaitingPath(workspaceId: string, limit: number): readonly EdgeProposal[];
  updateReview(input: EdgeProposalReviewInput): EdgeProposal;
  reconcileAfterMintFailure(input: EdgeProposalMintFailureReconcileInput): EdgeProposal;
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

const POSITIVE_RECALLS_FAMILY_RELATION_KIND_SQL =
  "'recalls', 'co_recalled', 'shares_entity', 'signal_graph_ref'";
const POSITIVE_RECALLS_FAMILY_RELATION_KINDS = new Set([
  "recalls",
  "co_recalled",
  "shares_entity",
  "signal_graph_ref"
]);

type PathIdentitySign = "positive" | "negative" | "neutral";

export class SqliteEdgeProposalRepo implements EdgeProposalRepo {
  private readonly createStatement;
  private readonly findByIdStatement;
  private readonly findPendingDuplicateStatement;
  private readonly listAcceptedAwaitingPathStatement;
  private readonly acceptedPositiveRecallsPathExistsStatement;
  private readonly acceptedDirectionalPathExistsStatement;
  private readonly updateReviewStatement;
  private readonly reconcileAfterMintFailureStatement;

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
    // invariant: list accepted / auto_accepted candidates oldest-first, then
    // filter out rows whose owed path already landed through a separate
    // parameter-bound path-exists statement. Filtering in a correlated NOT
    // EXISTS looks compact, but SQLite cannot seek the expression index when
    // the backing-object expression is compared to an outer-column value; it
    // falls back to a per-proposal path_relations scan. Bound parameters make
    // the expression index probe a real SEARCH.
    // Without the path-exists filter the sweep selected every accepted row
    // oldest-first, so > limit healthy accepts (each already minted)
    // permanently hid a real crash-window orphan behind them: the per-pass cap
    // was exhausted re-minting healthy rows to already_present and the orphan
    // was never reached.
    // The path-exists predicate mirrors protocol pathRelationMatchesIdentity:
    // positive recalls-family paths are unordered across recalls/co_recalled/
    // shares_entity/signal_graph_ref, while every other relation/sign family is
    // directional and relation-kind/sign aware. This keeps the crash-window
    // repair list aligned with the accept re-mint's already_present decision.
    // invariant: the bidirectional match is split into a UNION ALL of two
    // single-orientation branches rather than one OR across two different
    // expression columns. A single OR mixing the source-backing and
    // target-backing expressions defeats the expression-index seek and
    // degrades to a workspace-scoped SCAN of path_relations per accepted
    // proposal. Each UNION ALL branch binds ONE orientation, so each rides its
    // own idx_path_relations_*_backing_object_id index seek. Semantics are
    // identical for the positive recalls-family case. Directional families use
    // only the source->target branch, by contract. INDEXED BY keeps this
    // reconcile path on the backing-object identity index when SQLite would
    // otherwise prefer the narrower anchor-key index.
    // invariant: the match is asymmetric-safe. A genuine orphan owns NO path, so
    // NO row matches and it is always included (never starved). A healthy accept
    // that some non-object-anchor producer satisfies is excluded here because
    // the backing object id, not the full anchor key, is the mint dedup key.
    // invariant: oldest-first so a backlog of stranded accepts drains FIFO
    // across passes; idx_edge_proposals_workspace_status(workspace_id, status,
    // created_at) covers the accepted-row predicate + ordering.
    // see also: core/src/path-graph/edge-proposal-service.ts reconcileStuckAccepts,
    //   mintAcceptedPath (object-anchor mint + idempotent dedup).
    // invariant: the backing-object SQL is spliced VERBATIM (unqualified
    // anchors_json) so its parse tree stays byte-identical to the migration-087
    // expression indexes and SQLite probes them.
    this.listAcceptedAwaitingPathStatement = db.connection.prepare(`
      SELECT *
      FROM edge_proposals
      WHERE workspace_id = ?
        AND status IN ('accepted', 'auto_accepted')
      ORDER BY created_at ASC, proposal_id ASC
      LIMIT ?
      OFFSET ?
    `);
    this.acceptedPositiveRecallsPathExistsStatement = db.connection.prepare(`
      SELECT 1
      FROM path_relations INDEXED BY idx_path_relations_source_backing_object_id
      WHERE workspace_id = ?
        AND ${PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL} = ?
        AND ${PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL} = ?
        AND json_extract(constitution_json, '$.relation_kind') IN (${POSITIVE_RECALLS_FAMILY_RELATION_KIND_SQL})
        AND json_extract(effect_vector_json, '$.recall_bias') > 0
      UNION ALL
      SELECT 1
      FROM path_relations INDEXED BY idx_path_relations_target_backing_object_id
      WHERE workspace_id = ?
        AND ${PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL} = ?
        AND ${PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL} = ?
        AND json_extract(constitution_json, '$.relation_kind') IN (${POSITIVE_RECALLS_FAMILY_RELATION_KIND_SQL})
        AND json_extract(effect_vector_json, '$.recall_bias') > 0
      LIMIT 1
    `);
    this.acceptedDirectionalPathExistsStatement = db.connection.prepare(`
      SELECT 1
      FROM path_relations INDEXED BY idx_path_relations_source_backing_object_id
      WHERE workspace_id = ?
        AND ${PATH_RELATION_SOURCE_BACKING_OBJECT_ID_SQL} = ?
        AND ${PATH_RELATION_TARGET_BACKING_OBJECT_ID_SQL} = ?
        AND json_extract(constitution_json, '$.relation_kind') = ?
        AND (
          (? = 'positive' AND json_extract(effect_vector_json, '$.recall_bias') > 0)
          OR (? = 'negative' AND json_extract(effect_vector_json, '$.recall_bias') < 0)
          OR (? = 'neutral' AND json_extract(effect_vector_json, '$.recall_bias') = 0)
        )
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
    // invariant: CAS-gated on the accept-just-committed status so a concurrent
    // decision is never clobbered; moves an accepted-without-path row to
    // pending (transient retry) or rejected (permanent terminal).
    this.reconcileAfterMintFailureStatement = db.connection.prepare(`
      UPDATE edge_proposals
      SET status = ?,
          reviewer_identity = ?,
          review_reason = ?,
          updated_at = ?
      WHERE proposal_id = ?
        AND status = ?
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
      return Object.freeze(rows.map((row) => parseRow(row)));
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
    try {
      const awaiting: EdgeProposalRow[] = [];
      const batchSize = Math.max(limit, 64);
      let offset = 0;

      while (awaiting.length < limit) {
        const rows = this.listAcceptedAwaitingPathStatement.all(
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

      return Object.freeze(awaiting.map((row) => parseRow(row)));
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

  public reconcileAfterMintFailure(input: EdgeProposalMintFailureReconcileInput): EdgeProposal {
    const proposalId = parseNonEmptyString(input.proposalId, "proposal id");
    const fromStatus = EdgeProposalStatusSchema.parse(input.fromStatus);
    const toStatus = EdgeProposalStatusSchema.parse(input.toStatus);
    const reviewerIdentity =
      input.reviewerIdentity === null ? null : parseNonEmptyString(input.reviewerIdentity, "reviewer identity");
    const reviewReason = input.reviewReason === null ? null : parseNonEmptyString(input.reviewReason, "review reason");
    const reviewedAt = parseTimestamp(input.reviewedAt);

    try {
      let result: { readonly changes: number };
      try {
        result = this.reconcileAfterMintFailureStatement.run(
          toStatus,
          reviewerIdentity,
          reviewReason,
          reviewedAt,
          proposalId,
          fromStatus
        );
      } catch (runError) {
        // invariant: a revert-to-pending collides with idx_edge_proposals_pending_unique
        // when a duplicate pending row (a re-proposal P2) already holds this tuple
        // — create dedups only against status='pending', so while P1 sat accepted
        // its pending slot was free for P2 to fill. Letting the SQLITE_CONSTRAINT
        // escape would roll back the caller's audit+reconcile transaction, leaving
        // P1 terminal accepted-without-path AND no mint-failed audit. better-sqlite3
        // aborts only the failed STATEMENT (not the enclosing transaction), so we
        // recover in-transaction: P2 carries the retry, so P1 has no owed path —
        // move it to terminal `rejected` (superseded) and let the audit commit.
        if (
          toStatus === EdgeProposalStatus.PENDING &&
          isUniqueConstraintError(runError)
        ) {
          return this.reconcileToSupersededRejected(
            proposalId,
            fromStatus,
            input.supersededReviewerIdentity ?? null,
            input.supersededReviewReason ?? null,
            reviewedAt
          );
        }
        throw runError;
      }
      if (result.changes === 0) {
        const existing = this.findById(proposalId);
        if (existing === null) {
          throw new StorageError("NOT_FOUND", `Edge proposal not found: ${proposalId}`);
        }
        // invariant: CAS lost. The row is no longer in `fromStatus` (a
        // concurrent decision moved it), so the compensating transition must
        // not overwrite that foreign state.
        throw new StorageError(
          "CONFLICT",
          `Edge proposal is not in ${fromStatus}: ${proposalId} (${existing.status})`
        );
      }
      return this.findRequired(proposalId);
    } catch (error) {
      if (error instanceof StorageError) {
        throw error;
      }
      throw new StorageError("QUERY_FAILED", `Failed to reconcile edge proposal ${proposalId}.`, error);
    }
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
    const result = this.reconcileAfterMintFailureStatement.run(
      EdgeProposalStatus.REJECTED,
      parsedReviewerIdentity,
      parsedReviewReason,
      reviewedAt,
      proposalId,
      fromStatus
    );
    if (result.changes === 0) {
      const existing = this.findById(proposalId);
      if (existing === null) {
        throw new StorageError("NOT_FOUND", `Edge proposal not found: ${proposalId}`);
      }
      throw new StorageError(
        "CONFLICT",
        `Edge proposal is not in ${fromStatus}: ${proposalId} (${existing.status})`
      );
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
    return (this.listAcceptedAwaitingPathStatement as { readonly source: string }).source;
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
      positiveRecalls: (this.acceptedPositiveRecallsPathExistsStatement as { readonly source: string }).source,
      directional: (this.acceptedDirectionalPathExistsStatement as { readonly source: string }).source
    });
  }

  private acceptedProposalHasPath(row: EdgeProposalRow): boolean {
    const identity = edgeProposalPathIdentity(row.edge_type);
    const existing = identity.isPositiveRecallsFamily
      ? this.acceptedPositiveRecallsPathExistsStatement.get(
          row.workspace_id,
          row.source_memory_id,
          row.target_memory_id,
          row.workspace_id,
          row.target_memory_id,
          row.source_memory_id
        )
      : this.acceptedDirectionalPathExistsStatement.get(
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

// better-sqlite3 surfaces a partial-unique-index collision as a code that
// starts with SQLITE_CONSTRAINT (e.g. SQLITE_CONSTRAINT_UNIQUE / _PRIMARYKEY);
// the cause walk handles later error-wrapping by upstream layers.
// see also: workspace-repo.ts / garden-task-repo.ts isUniqueConstraintError —
// those variants additionally match a qualified column to map a PK collision to
// DUPLICATE_KEY; here only the index-collision shape matters, so this is the
// column-agnostic form, kept local rather than exporting from a foreign repo.
// anti-patterns-lint-allow: column-agnostic variant; the qualified-column forms
// are not reusable for a partial-index-predicate collision check.
function isUniqueConstraintError(error: unknown): boolean {
  // anti-patterns-lint-allow: column-agnostic cause-walk; the qualified-column
  // forms in workspace-repo.ts / garden-task-repo.ts are not reusable for a
  // partial-index-predicate collision check that has no column to match.
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && current !== undefined; depth += 1) {
    const codeValue = (current as { readonly code?: unknown }).code;
    if (typeof codeValue === "string" && codeValue.startsWith("SQLITE_CONSTRAINT")) {
      return true;
    }
    const messageValue = (current as { readonly message?: unknown }).message;
    if (typeof messageValue === "string" && messageValue.includes("UNIQUE constraint failed")) {
      return true;
    }
    current = (current as { readonly cause?: unknown }).cause;
  }
  return false;
}

function edgeProposalPathIdentity(edgeTypeValue: string): {
  readonly relationKind: EdgeProposal["edge_type"];
  readonly sign: PathIdentitySign;
  readonly isPositiveRecallsFamily: boolean;
} {
  const relationKind = parseEdgeTypeForIdentity(edgeTypeValue);
  const weight = MEMORY_GRAPH_EDGE_RECALL_WEIGHTS[relationKind];
  const sign: PathIdentitySign = weight > 0 ? "positive" : weight < 0 ? "negative" : "neutral";

  return {
    relationKind,
    sign,
    isPositiveRecallsFamily: sign === "positive" && POSITIVE_RECALLS_FAMILY_RELATION_KINDS.has(relationKind)
  };
}

function parseEdgeTypeForIdentity(value: string): EdgeProposal["edge_type"] {
  try {
    return MemoryGraphEdgeTypeSchema.parse(value);
  } catch (error) {
    throw new StorageError("VALIDATION_FAILED", `Failed to validate edge proposal edge_type: ${value}`, error);
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
