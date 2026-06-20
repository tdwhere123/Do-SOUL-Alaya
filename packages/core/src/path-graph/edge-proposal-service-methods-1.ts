import { randomUUID } from "node:crypto";

import {
  EDGE_TYPE_RECALL_MODEL,
  EdgeProposalStatus,
  EdgeProposalTriggerSource,
  GraphAuditorEventType,
  SoulGraphEdgeProposalCreatedPayloadSchema,
  SoulGraphEdgeProposalPathMintFailedPayloadSchema,
  SoulGraphEdgeProposalReviewedPayloadSchema,
  SoulBatchReviewEdgeProposalsResponseSchema,
  SoulListPendingEdgeProposalsResponseSchema,
  SoulProposeEdgeResponseSchema,
  type EdgeProposal,
  type EdgeProposalFilter,
  type EdgeProposalTriggerSourceValue,
  type MemoryGraphEdgeTypeValue,
  type SoulBatchReviewEdgeProposalsResponse,
  type SoulListPendingEdgeProposalsResponse,
  type SoulProposeEdgeResponse
} from "@do-soul/alaya-protocol";
import { CoreError } from "../shared/errors.js";
import type { EventPublisher, EventPublisherInput } from "../runtime/event-publisher.js";
import type { PathCandidateSink } from "./path-candidate-sink.js";
import type { PathFailureHealthInboxPort } from "./path-failure-health-inbox.js";
import type { PathMintOutcome } from "./path-relation-proposal-service.js";
import { parseObjectId } from "../shared/validators.js";
type EdgeProposalServiceMethodOwner = {
  generateId: () => string;
  now: () => string;
  dependencies: EdgeProposalServiceDependencies;
  [key: string]: any;
};

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

type EdgeProposalCreateEventInput = Parameters<EdgeProposalRepoPort["create"]>[0];

function buildProposalCreatedEvent(proposal: EdgeProposalCreateEventInput): EventPublisherInput {
  return {
    event_type: GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_CREATED,
    entity_type: "edge_proposal",
    entity_id: proposal.proposal_id,
    workspace_id: proposal.workspace_id,
    run_id: proposal.run_id,
    caused_by: proposal.trigger_source,
    payload_json: SoulGraphEdgeProposalCreatedPayloadSchema.parse({
      proposal_id: proposal.proposal_id,
      source_memory_id: proposal.source_memory_id,
      target_memory_id: proposal.target_memory_id,
      edge_type: proposal.edge_type,
      trigger_source: proposal.trigger_source,
      confidence: proposal.confidence,
      reason: proposal.reason,
      source_signal_id: proposal.source_signal_id,
      workspace_id: proposal.workspace_id,
      occurred_at: proposal.created_at
    })
  };
}

// invariant: CONFLICT-coded error from either the CoreError path or the repo's
// StorageError, matched structurally so core never imports @do-soul/alaya-storage.
function isConflictError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { readonly code?: unknown }).code === "CONFLICT"
  );
}

function buildProposalReviewedEvent(
  proposal: EdgeProposal,
  status:
    | typeof EdgeProposalStatus.ACCEPTED
    | typeof EdgeProposalStatus.REJECTED
    | typeof EdgeProposalStatus.EXPIRED
    | typeof EdgeProposalStatus.AUTO_ACCEPTED,
  reviewerIdentity: string,
  reviewReason: string | null,
  reviewedAt: string
): EventPublisherInput {
  return {
    event_type: GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_REVIEWED,
    entity_type: "edge_proposal",
    entity_id: proposal.proposal_id,
    workspace_id: proposal.workspace_id,
    run_id: proposal.run_id,
    caused_by: reviewerIdentity,
    payload_json: SoulGraphEdgeProposalReviewedPayloadSchema.parse({
      proposal_id: proposal.proposal_id,
      status,
      reviewer_identity: reviewerIdentity,
      review_reason: reviewReason,
      workspace_id: proposal.workspace_id,
      occurred_at: reviewedAt
    })
  };
}

// invariant: BoundedReasonSchema bounds review-reason-class strings; keep the
// failure detail within the same bound so the payload parse never rejects a
// long underlying error message at the durable-emission boundary.
const PATH_MINT_FAILURE_DETAIL_MAX = 500;

function describeMintFailureCause(cause: unknown): string | null {
  if (cause === null || cause === undefined) {
    return null;
  }
  const detail = cause instanceof Error ? cause.message : String(cause);
  const trimmed = detail.trim();
  if (trimmed.length === 0) {
    return null;
  }
  return trimmed.slice(0, PATH_MINT_FAILURE_DETAIL_MAX);
}

function buildPathMintFailedEvent(
  proposal: EdgeProposal,
  reviewerIdentity: string,
  failureKind: "submit_returned_false" | "submit_threw",
  cause: unknown,
  occurredAt: string
): EventPublisherInput {
  return {
    event_type: GraphAuditorEventType.SOUL_GRAPH_EDGE_PROPOSAL_PATH_MINT_FAILED,
    entity_type: "edge_proposal",
    entity_id: proposal.proposal_id,
    workspace_id: proposal.workspace_id,
    run_id: proposal.run_id,
    caused_by: reviewerIdentity,
    payload_json: SoulGraphEdgeProposalPathMintFailedPayloadSchema.parse({
      proposal_id: proposal.proposal_id,
      source_memory_id: proposal.source_memory_id,
      target_memory_id: proposal.target_memory_id,
      edge_type: proposal.edge_type,
      reviewer_identity: reviewerIdentity,
      failure_kind: failureKind,
      failure_detail: describeMintFailureCause(cause),
      workspace_id: proposal.workspace_id,
      occurred_at: occurredAt
    })
  };
}

function clampAgentReportedConfidence(confidence: number): number {
  return Math.min(confidence, 0.5);
}

function toPendingSummary(proposal: EdgeProposal) {
  return {
    proposal_id: proposal.proposal_id,
    source_memory_id: proposal.source_memory_id,
    target_memory_id: proposal.target_memory_id,
    edge_type: proposal.edge_type,
    trigger_source: proposal.trigger_source,
    confidence: proposal.confidence,
    reason: proposal.reason,
    source_signal_id: proposal.source_signal_id,
    run_id: proposal.run_id,
    created_at: proposal.created_at,
    expires_at: proposal.expires_at
  };
}

export async function edgeProposalServiceProposeEdge(owner: EdgeProposalServiceMethodOwner, params: EdgeProposalCreateParams): Promise<Readonly<EdgeProposal>> {
  const ids = parseEdgeProposalObjectIds(params);
  await assertDistinctProposalMemories(owner, ids);
  const duplicate = owner.dependencies.proposalRepo.findPendingDuplicate({
    workspaceId: ids.workspaceId,
    sourceMemoryId: ids.sourceMemoryId,
    targetMemoryId: ids.targetMemoryId,
    edgeType: params.edgeType
  });
  if (duplicate !== null) {
    return duplicate;
  }
  const createInput = buildEdgeProposalCreateInput(owner, params, ids);
  const created = await owner.dependencies.eventPublisher.appendManyWithMutation(
    [buildProposalCreatedEvent(createInput)],
    () => owner.dependencies.proposalRepo.create(createInput)
  );
  return maybeAutoAcceptEdgeProposal(owner, created, createInput.trigger_source, createInput.confidence);
}

function parseEdgeProposalObjectIds(params: EdgeProposalCreateParams): Readonly<{
  readonly sourceMemoryId: string;
  readonly targetMemoryId: string;
  readonly workspaceId: string;
}> {
  return Object.freeze({
    sourceMemoryId: parseObjectId(params.sourceMemoryId),
    targetMemoryId: parseObjectId(params.targetMemoryId),
    workspaceId: parseObjectId(params.workspaceId)
  });
}

async function assertDistinctProposalMemories(
  owner: EdgeProposalServiceMethodOwner,
  ids: Readonly<{ readonly sourceMemoryId: string; readonly targetMemoryId: string; readonly workspaceId: string }>
): Promise<void> {
  if (ids.sourceMemoryId === ids.targetMemoryId) {
    throw new CoreError("VALIDATION", "Source and target memory must be different.");
  }
  await owner.requireMemoryInWorkspace(ids.sourceMemoryId, "Source", ids.workspaceId);
  await owner.requireMemoryInWorkspace(ids.targetMemoryId, "Target", ids.workspaceId);
}

function buildEdgeProposalCreateInput(
  owner: EdgeProposalServiceMethodOwner,
  params: EdgeProposalCreateParams,
  ids: Readonly<{ readonly sourceMemoryId: string; readonly targetMemoryId: string; readonly workspaceId: string }>
): EdgeProposalCreateEventInput {
  const createdAt = owner.now();
  const triggerSource = params.triggerSource ?? EdgeProposalTriggerSource.EXPLICIT;
  const requestedConfidence = params.confidence ?? 0.5;
  const confidence =
    triggerSource === EdgeProposalTriggerSource.EXPLICIT
      ? clampAgentReportedConfidence(requestedConfidence)
      : requestedConfidence;
  return {
    proposal_id: `edge_prop_${owner.generateId()}`,
    workspace_id: ids.workspaceId,
    source_memory_id: ids.sourceMemoryId,
    target_memory_id: ids.targetMemoryId,
    edge_type: params.edgeType,
    trigger_source: triggerSource,
    confidence,
    reason: params.reason ?? null,
    source_signal_id: params.sourceSignalId ?? null,
    run_id: params.runId ?? null,
    created_at: createdAt,
    expires_at: params.expiresAt ?? owner.defaultExpiresAt(createdAt)
  };
}

async function maybeAutoAcceptEdgeProposal(
  owner: EdgeProposalServiceMethodOwner,
  created: Readonly<EdgeProposal>,
  triggerSource: EdgeProposalTriggerSourceValue,
  confidence: number
): Promise<Readonly<EdgeProposal>> {
  if (!owner.shouldAutoAccept(triggerSource, confidence)) {
    return created;
  }
  return owner.acceptProposal(
    created,
    AUTO_ACCEPT_REVIEWER_IDENTITY,
    AUTO_ACCEPT_REVIEW_REASON,
    owner.now(),
    EdgeProposalStatus.AUTO_ACCEPTED
  );
}

export function edgeProposalServiceShouldAutoAccept(owner: EdgeProposalServiceMethodOwner, triggerSource: EdgeProposalTriggerSourceValue, confidence: number): boolean {
    if (triggerSource === EdgeProposalTriggerSource.EXPLICIT) {
      return false;
    }
    const floor = AUTO_ACCEPT_FLOOR_BY_TRIGGER[triggerSource];
    if (floor === undefined) {
      return false;
    }
    return confidence >= floor;
  }

export function edgeProposalServiceListPending(owner: EdgeProposalServiceMethodOwner, workspaceId: string, filter: EdgeProposalFilter = {}): SoulListPendingEdgeProposalsResponse {
    const proposals = owner.dependencies.proposalRepo.listPending(parseObjectId(workspaceId), filter);
    return SoulListPendingEdgeProposalsResponseSchema.parse({
      proposals: proposals.map(toPendingSummary),
      total_count: proposals.length
    });
  }
