import { randomUUID } from "node:crypto";
import {
  EDGE_TYPE_RECALL_MODEL,
  EdgeProposalStatus,
  EdgeProposalTriggerSource,
  type EdgeProposal,
  type EdgeProposalFilter,
  type EdgeProposalTriggerSourceValue,
  type MemoryGraphEdgeTypeValue,
  type SoulBatchReviewEdgeProposalsResponse,
  type SoulListPendingEdgeProposalsResponse,
  type SoulProposeEdgeResponse
} from "@do-soul/alaya-protocol";
import type { EventPublisher } from "../runtime/event-publisher.js";
import type { PathCandidateSink } from "./path-candidate-sink.js";
import type { PathFailureHealthInboxPort } from "./path-failure-health-inbox.js";
import type { PathMintOutcome } from "./path-relation-proposal-service.js";

import { edgeProposalServiceProposeEdge, edgeProposalServiceShouldAutoAccept, edgeProposalServiceListPending } from "./edge-proposal-service-methods-1.js";
import { edgeProposalServiceBatchReview, edgeProposalServiceProposeExplicitEdge, edgeProposalServiceRequireMemoryInWorkspace } from "./edge-proposal-service-methods-2.js";
import { edgeProposalServiceRequireExplicitProposalIdsSelected, edgeProposalServiceAcceptProposal, edgeProposalServiceMintAcceptedPath } from "./edge-proposal-service-methods-3.js";
import { edgeProposalServiceReconcileStuckAccepts, edgeProposalServiceDefaultExpiresAt } from "./edge-proposal-service-methods-4.js";
import { edgeProposalServiceSweepExpired, edgeProposalServiceHandleMintFailure } from "./edge-proposal-service-methods-5.js";
import { edgeProposalServiceRecordPathFailureToInbox, edgeProposalServiceRejectProposal } from "./edge-proposal-service-methods-6.js";

export interface EdgeProposalMemoryRepoPort {
  findById(objectId: string): Promise<{ readonly object_id: string; readonly workspace_id: string } | null>;
}

export interface EdgeProposalRepoPort {
  create(input: {
    readonly proposal_id: string;
    readonly workspace_id: string;
    readonly source_memory_id: string;
    readonly target_memory_id: string;
    readonly edge_type: MemoryGraphEdgeTypeValue;
    readonly trigger_source: EdgeProposalTriggerSourceValue;
    readonly confidence: number;
    readonly reason: string | null;
    readonly source_signal_id: string | null;
    readonly run_id: string | null;
    readonly created_at: string;
    readonly expires_at: string | null;
  }): EdgeProposal;
  findPendingDuplicate(input: {
    readonly workspaceId: string;
    readonly sourceMemoryId: string;
    readonly targetMemoryId: string;
    readonly edgeType: MemoryGraphEdgeTypeValue;
  }): EdgeProposal | null;
  listPending(workspaceId: string, filter?: EdgeProposalFilter): readonly EdgeProposal[];
  // invariant: pending proposals past their non-null expires_at, oldest-expiry
  // first, bounded by limit. The TTL sweep flips each to `expired`. A null
  // expires_at is never returned. see also: sweepExpired.
  listExpiredPending(workspaceId: string, nowIso: string, limit: number): readonly EdgeProposal[];
  // invariant: accepted / auto_accepted proposals owe a minted path. The
  // daemon reconcile sweep reads these (oldest first, bounded) to recover a
  // crash-window orphan — an accept whose review row committed but whose mint
  // never landed (and so is invisible to listPending). re-driving the mint is
  // idempotent (path dedup -> already_present).
  // see also: edge-proposal-repo.ts listAcceptedAwaitingPath, reconcileStuckAccepts.
  listAcceptedAwaitingPath(workspaceId: string, limit: number): readonly EdgeProposal[];
  updateReview(input: {
    readonly proposalId: string;
    readonly status: "accepted" | "rejected" | "expired" | "auto_accepted";
    readonly reviewerIdentity: string | null;
    readonly reviewReason: string | null;
    readonly reviewedAt: string;
  }): EdgeProposal;
  // invariant: compensating transition out of the just-committed accepted
  // state when the owed path never minted. CAS-gated on `fromStatus` (the
  // accepted/auto_accepted the accept just wrote) so a concurrent decision
  // cannot be clobbered. A transient mint failure reverts the row to
  // `pending` (retryable through the existing pending review surface); a
  // permanent anchor rejection reverts it to terminal `rejected` so it leaves
  // the pending list and cannot become a retry poison pill.
  // see also: edge-proposal-repo.ts SqliteEdgeProposalRepo.reconcileAfterMintFailure.
  reconcileAfterMintFailure(input: {
    readonly proposalId: string;
    readonly fromStatus: "accepted" | "auto_accepted";
    readonly toStatus: "pending" | "rejected";
    readonly reviewerIdentity: string | null;
    readonly reviewReason: string | null;
    readonly reviewedAt: string;
    // invariant: terminal fallback stamped when a revert-to-pending would
    // collide with a duplicate pending re-proposal (the pending-unique index).
    // The repo moves the row to terminal `rejected` with these instead of
    // letting the SQLITE_CONSTRAINT roll back the caller's audit transaction.
    // see also: edge-proposal-repo.ts reconcileAfterMintFailure (collision fallback).
    readonly supersededReviewerIdentity?: string | null;
    readonly supersededReviewReason?: string | null;
  }): EdgeProposal;
}

export interface EdgeProposalServiceDependencies {
  readonly memoryRepo: EdgeProposalMemoryRepoPort;
  readonly proposalRepo: EdgeProposalRepoPort;
  // invariant: edge-proposal accept mints a governed PathRelation on the
  // unified path plane; it never creates a memory_graph_edges row. The
  // review gate is independent of the landing target: proposals stay
  // pending -> accept/reject. submitCandidate applies the path governance
  // clamp, durable dedup, and the PATH_RELATION_CREATED audit row.
  // see also: path-candidate-sink.ts PathCandidateSink.
  readonly pathCandidatePort: PathCandidateSink;
  readonly eventPublisher: Pick<EventPublisher, "appendManyWithMutation">;
  // invariant: D-EDGEAUDIT operator-triage surface. When wired, an accept-owed
  // path mint failure ALSO upserts a `path_relation_failure` health_inbox group
  // (in addition to the durable SOUL_GRAPH_EDGE_PROPOSAL_PATH_MINT_FAILED event)
  // so the failure is visible in the Inspector inbox, not only by forensic
  // EventLog scan. Optional: when absent the EventLog audit stands alone.
  // Best-effort — a port throw must never break the accept path.
  // see also: path-relation-proposal-service.ts (the mint-side failure twin);
  //   protocol HealthIssueCauseKind.PATH_RELATION_FAILURE.
  readonly healthInboxPort?: PathFailureHealthInboxPort;
  readonly generateId?: () => string;
  readonly now?: () => string;
}

// invariant: edge_type -> path seed mapping for accept-minted relations.
// relation_kind == edge_type so soul.explore_graph projects it back without
// loss; recall_bias = sign x magnitude is anchored to
// EDGE_TYPE_RECALL_MODEL.contribution_weight so an accept-minted path's
// graph_support contribution is zero-drift vs a same-mapped-edge-type
// auto-producer path (graph_support weights by mapped edge_type, not by
// recall_bias). The paths are NOT otherwise numerically identical: auto-producer
// seed profiles differ on recall_bias magnitude, strength, governance_class,
// and relation_kind.
// initial strength = |contribution_weight| clamped to a non-zero floor so a
// neutral marker (exception_to, weight 0) is still a live, dedup-able path
// row rather than a dead zero-strength relation.
const ACCEPT_PATH_STRENGTH_FLOOR = 0.3;

function edgeTypeToRecallBiasSign(edgeType: MemoryGraphEdgeTypeValue): 1 | 0 | -1 {
  const weight = EDGE_TYPE_RECALL_MODEL[edgeType].contribution_weight;
  if (weight > 0) {
    return 1;
  }
  if (weight < 0) {
    return -1;
  }
  return 0;
}

// invariant: auto-accept floor table by trigger_source. This file is
// the single source of truth for the mapping; no producer may inline its
// own magic constant — always read from this table.
//
// invariant: only triggers that actually reach proposeEdge belong here.
// proposeEdge has exactly three production sources: proposeExplicitEdge
// (EXPLICIT), graphEdgePort.createEdge from the MCP report_context_usage
// cross-link (RECALL_CROSS_LINK), and graphEdgePort.createEdge from the
// librarian subject-neighbor pass (SYSTEM). RECALL_CROSS_LINK is the only
// one that may auto-accept; EXPLICIT is agent-self-reported (clamped to
// 0.5 in proposeEdge, human reviewer stays decisive) and SYSTEM keeps a
// human in the loop, so both are intentionally absent. The LLM/local
// rule triggers (LLM_SUPPORTS, LOCAL_SUPPORTS, LOCAL_DERIVES_FROM,
// LOCAL_SUPERSEDES) and CONFLICT_DETECTION never reach proposeEdge —
// EdgeAutoProducerService and ConflictDetectionService submit straight to
// PathCandidateSink in a governed birth band (rule verdict / positive
// auto-build -> attention_only; the CONFLICT_DETECTION LLM verdict ->
// recall_allowed), so a floor row for them would be dead config.
// see also: apps/core-daemon/src/index.ts (graphEdgePort.createEdge ->
//   proposeEdge wiring; EdgeAutoProducerService / ConflictDetectionService
//   wired to pathCandidatePort), docs/handbook/runtime-status.md.
export const AUTO_ACCEPT_FLOOR_BY_TRIGGER: Readonly<
  Partial<Record<EdgeProposalTriggerSourceValue, number>>
> = Object.freeze({
  [EdgeProposalTriggerSource.RECALL_CROSS_LINK]: 0.8
});

// invariant: system-policy auto-accept emits SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED
// with this reviewer_identity so KPI K3.4 (auto_accept rate) can attribute
// the decision and so audit-trail consumers can distinguish auto vs human.
export const AUTO_ACCEPT_REVIEWER_IDENTITY = "system:auto_accept_policy";

const AUTO_ACCEPT_REVIEW_REASON = "auto-accepted by trigger floor policy";

// invariant: default pending-proposal TTL. proposeEdge stamps
// expires_at = created_at + this TTL when no caller value is given, so the
// `expired` status + expires_at column are a live feature (producer here,
// sweeper in sweepExpired) rather than dead schema. 30 days is conservative:
// long enough for a human/agent reviewer, short enough that a stale
// auto-produced proposal cannot pile up unbounded on a no-reviewer deployment.
// An explicit caller expiresAt overrides this default.
export const EDGE_PROPOSAL_DEFAULT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

// invariant: reviewer_identity + review_reason stamped on a proposal the TTL
// sweep moves pending -> expired. Distinguishes a policy expiry from a human
// reject in the durable review columns so KPI attribution stays unambiguous.
export const TTL_EXPIRY_REVIEWER_IDENTITY = "system:edge_proposal_ttl_policy";

const TTL_EXPIRY_REVIEW_REASON = "auto-expired: pending proposal outlived its TTL with no review";

// invariant: per-pass tally the TTL sweep returns so the daemon can LOG what it
// expired (no silent cap). `scanned` rows examined; `expired` flipped to
// terminal expired; `skipped` rows whose CAS lost (a concurrent decision moved
// them off pending between list and updateReview).
export interface EdgeProposalExpirySweepResult {
  readonly scanned: number;
  readonly expired: number;
  readonly skipped: number;
}

// invariant: review_reason stamped on a proposal auto-rejected because its owed
// path mint was permanently refused (a missing / foreign source or target
// memory anchor). Distinguishes a mint-failure terminal rejection from an
// operator/auto verdict rejection in the durable review_reason column.
const PATH_MINT_FAILED_REVIEW_REASON = "permanent path-anchor refusal on accept";

// invariant: review_reason stamped when a transient-mint-failed proposal cannot
// revert to pending because a duplicate pending re-proposal already holds its
// tuple (the pending-unique index). The re-proposal carries the retry, so this
// row is reconciled to terminal rejected instead of being left stuck
// accepted-without-path. see also: edge-proposal-repo.ts reconcileAfterMintFailure.
const PATH_MINT_SUPERSEDED_REVIEW_REASON =
  "auto-rejected: owed path mint failed transiently and a duplicate pending re-proposal supersedes the retry";

// reviewer_identity stamped on the superseded terminal fallback so the
// rejection is attributable to the mint-reconcile policy rather than an
// operator verdict.
const PATH_MINT_SUPERSEDED_REVIEWER_IDENTITY = "system:edge_proposal_mint_reconcile";

// invariant: per-outcome tally the crash-window reconcile sweep returns so the
// daemon can LOG what it reconciled (no silent cap). `reminted` paths that
// genuinely landed this pass; `already_present` healthy accepts whose path
// already existed (the steady-state no-op); `rejected` permanent anchor
// refusals moved terminal; `transient_failed` reverted to pending for a later
// retry. see also: reconcileStuckAccepts.
export interface EdgeProposalReconcileSweepResult {
  readonly scanned: number;
  readonly reminted: number;
  readonly already_present: number;
  readonly rejected: number;
  readonly transient_failed: number;
}

export interface EdgeProposalCreateParams {
  readonly sourceMemoryId: string;
  readonly targetMemoryId: string;
  readonly edgeType: MemoryGraphEdgeTypeValue;
  readonly workspaceId: string;
  readonly runId?: string | null;
  readonly triggerSource?: EdgeProposalTriggerSourceValue;
  readonly confidence?: number;
  readonly reason?: string | null;
  readonly sourceSignalId?: string | null;
  readonly expiresAt?: string | null;
}

export class EdgeProposalService {
public readonly generateId: () => string;

public readonly now: () => string;

public constructor(public readonly dependencies: EdgeProposalServiceDependencies) {
    this.generateId = dependencies.generateId ?? randomUUID;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async proposeEdge(params: EdgeProposalCreateParams): Promise<Readonly<EdgeProposal>> {
    return edgeProposalServiceProposeEdge(this, params);
  }

  private shouldAutoAccept(triggerSource: EdgeProposalTriggerSourceValue, confidence: number): boolean {
    return edgeProposalServiceShouldAutoAccept(this, triggerSource, confidence);
  }

  public listPending(workspaceId: string, filter: EdgeProposalFilter = {}): SoulListPendingEdgeProposalsResponse {
    return edgeProposalServiceListPending(this, workspaceId, filter);
  }

  public async batchReview(input: {
    readonly workspaceId: string;
    readonly verdict: "accept" | "reject";
    readonly filter: EdgeProposalFilter;
    readonly reason: string | null;
    readonly reviewerIdentity: string;
  }): Promise<SoulBatchReviewEdgeProposalsResponse> {
    return edgeProposalServiceBatchReview(this, input);
  }

  public async proposeExplicitEdge(input: {
    readonly sourceMemoryId: string;
    readonly targetMemoryId: string;
    readonly edgeType: MemoryGraphEdgeTypeValue;
    readonly confidence: number;
    readonly reason: string | null;
    readonly workspaceId: string;
    readonly runId: string | null;
  }): Promise<SoulProposeEdgeResponse> {
    return edgeProposalServiceProposeExplicitEdge(this, input);
  }

  private async requireMemoryInWorkspace(memoryId: string, label: string, workspaceId: string): Promise<void> {
    return edgeProposalServiceRequireMemoryInWorkspace(this, memoryId, label, workspaceId);
  }

  private requireExplicitProposalIdsSelected(filter: EdgeProposalFilter, proposals: readonly EdgeProposal[]): void {
    return edgeProposalServiceRequireExplicitProposalIdsSelected(this, filter, proposals);
  }

  private async acceptProposal(proposal: EdgeProposal, reviewerIdentity: string, reviewReason: string | null, reviewedAt: string, acceptedStatus: typeof EdgeProposalStatus.ACCEPTED | typeof EdgeProposalStatus.AUTO_ACCEPTED): Promise<EdgeProposal> {
    return edgeProposalServiceAcceptProposal(this, proposal, reviewerIdentity, reviewReason, reviewedAt, acceptedStatus);
  }

  private async mintAcceptedPath(proposal: EdgeProposal, reviewerIdentity: string, acceptedStatus: typeof EdgeProposalStatus.ACCEPTED | typeof EdgeProposalStatus.AUTO_ACCEPTED): Promise<PathMintOutcome> {
    return edgeProposalServiceMintAcceptedPath(this, proposal, reviewerIdentity, acceptedStatus);
  }

  public async reconcileStuckAccepts(input: {
    readonly workspaceId: string;
    readonly limit: number;
  }): Promise<EdgeProposalReconcileSweepResult> {
    return edgeProposalServiceReconcileStuckAccepts(this, input);
  }

  private defaultExpiresAt(createdAt: string): string {
    return edgeProposalServiceDefaultExpiresAt(this, createdAt);
  }

  public async sweepExpired(input: {
    readonly workspaceId: string;
    readonly limit: number;
  }): Promise<EdgeProposalExpirySweepResult> {
    return edgeProposalServiceSweepExpired(this, input);
  }

  private async handleMintFailure(proposal: EdgeProposal, acceptedStatus: typeof EdgeProposalStatus.ACCEPTED | typeof EdgeProposalStatus.AUTO_ACCEPTED, reviewerIdentity: string, failureKind: "submit_returned_false" | "submit_threw", mintOutcome: "failed" | "rejected", cause: unknown = null): Promise<void> {
    return edgeProposalServiceHandleMintFailure(this, proposal, acceptedStatus, reviewerIdentity, failureKind, mintOutcome, cause);
  }

  private async recordPathFailureToInbox(workspaceId: string, targetObjectId: string): Promise<void> {
    return edgeProposalServiceRecordPathFailureToInbox(this, workspaceId, targetObjectId);
  }

  private async rejectProposal(proposal: EdgeProposal, reviewerIdentity: string, reviewReason: string | null, reviewedAt: string): Promise<void> {
    return edgeProposalServiceRejectProposal(this, proposal, reviewerIdentity, reviewReason, reviewedAt);
  }
}
