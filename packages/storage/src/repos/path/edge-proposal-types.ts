import type {
  EdgeProposal,
  EdgeProposalFilter,
  EdgeProposalStatusValue
} from "@do-soul/alaya-protocol";

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
