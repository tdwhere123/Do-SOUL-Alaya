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
import { CoreError } from "./errors.js";
import type { EventPublisher, EventPublisherInput } from "./event-publisher.js";
import type { PathCandidateSink } from "./path-candidate-sink.js";
import type { PathMintOutcome } from "./path-relation-proposal-service.js";
import { parseObjectId } from "./shared/validators.js";

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
  private readonly generateId: () => string;
  private readonly now: () => string;

  public constructor(private readonly dependencies: EdgeProposalServiceDependencies) {
    this.generateId = dependencies.generateId ?? randomUUID;
    this.now = dependencies.now ?? (() => new Date().toISOString());
  }

  public async proposeEdge(params: EdgeProposalCreateParams): Promise<Readonly<EdgeProposal>> {
    const sourceMemoryId = parseObjectId(params.sourceMemoryId);
    const targetMemoryId = parseObjectId(params.targetMemoryId);
    const workspaceId = parseObjectId(params.workspaceId);
    if (sourceMemoryId === targetMemoryId) {
      throw new CoreError("VALIDATION", "Source and target memory must be different.");
    }
    await this.requireMemoryInWorkspace(sourceMemoryId, "Source", workspaceId);
    await this.requireMemoryInWorkspace(targetMemoryId, "Target", workspaceId);

    const duplicate = this.dependencies.proposalRepo.findPendingDuplicate({
      workspaceId,
      sourceMemoryId,
      targetMemoryId,
      edgeType: params.edgeType
    });
    if (duplicate !== null) {
      return duplicate;
    }

    const createdAt = this.now();
    const triggerSource = params.triggerSource ?? EdgeProposalTriggerSource.EXPLICIT;
    const requestedConfidence = params.confidence ?? 0.5;
    // invariant: agent-reported confidence is policy-clamped at the
    // service core, not at any surface wrapper. EXPLICIT proposals come
    // from attached MCP agents whose self-reported confidence is not
    // trusted; ceiling is 0.5 so reviewer judgement remains decisive.
    const confidence =
      triggerSource === EdgeProposalTriggerSource.EXPLICIT
        ? clampAgentReportedConfidence(requestedConfidence)
        : requestedConfidence;
    const createInput = {
      proposal_id: `edge_prop_${this.generateId()}`,
      workspace_id: workspaceId,
      source_memory_id: sourceMemoryId,
      target_memory_id: targetMemoryId,
      edge_type: params.edgeType,
      trigger_source: triggerSource,
      confidence,
      reason: params.reason ?? null,
      source_signal_id: params.sourceSignalId ?? null,
      run_id: params.runId ?? null,
      created_at: createdAt,
      expires_at: params.expiresAt ?? null
    };
    const created = await this.dependencies.eventPublisher.appendManyWithMutation(
      [buildProposalCreatedEvent(createInput)],
      () => this.dependencies.proposalRepo.create(createInput)
    );
    // invariant: auto-accept evaluation runs AFTER the proposal is durably
    // written so the auto-accepted state always has a SOUL_GRAPH_EDGE_PROPOSAL_CREATED
    // ancestor event. EXPLICIT and any trigger absent from the floor table
    // are short-circuited to pending — never auto-accepted.
    if (this.shouldAutoAccept(triggerSource, confidence)) {
      const reviewedAt = this.now();
      return await this.acceptProposal(
        created,
        AUTO_ACCEPT_REVIEWER_IDENTITY,
        AUTO_ACCEPT_REVIEW_REASON,
        reviewedAt,
        EdgeProposalStatus.AUTO_ACCEPTED
      );
    }
    return created;
  }

  // invariant: EXPLICIT and CANDIDATE_SIGNAL_REF never auto-accept — they
  // are agent-driven and a human reviewer must remain decisive. SYSTEM and
  // BENCH_SEED are also absent from the floor table; if a caller wants
  // auto-accept they must use one of the floor-mapped trigger sources.
  private shouldAutoAccept(
    triggerSource: EdgeProposalTriggerSourceValue,
    confidence: number
  ): boolean {
    if (triggerSource === EdgeProposalTriggerSource.EXPLICIT) {
      return false;
    }
    const floor = AUTO_ACCEPT_FLOOR_BY_TRIGGER[triggerSource];
    if (floor === undefined) {
      return false;
    }
    return confidence >= floor;
  }

  public listPending(workspaceId: string, filter: EdgeProposalFilter = {}): SoulListPendingEdgeProposalsResponse {
    const proposals = this.dependencies.proposalRepo.listPending(parseObjectId(workspaceId), filter);
    return SoulListPendingEdgeProposalsResponseSchema.parse({
      proposals: proposals.map(toPendingSummary),
      total_count: proposals.length
    });
  }

  public async batchReview(input: {
    readonly workspaceId: string;
    readonly verdict: "accept" | "reject";
    readonly filter: EdgeProposalFilter;
    readonly reason: string | null;
    readonly reviewerIdentity: string;
  }): Promise<SoulBatchReviewEdgeProposalsResponse> {
    const workspaceId = parseObjectId(input.workspaceId);
    const proposals = this.dependencies.proposalRepo.listPending(workspaceId, input.filter);
    this.requireExplicitProposalIdsSelected(input.filter, proposals);
    const reviewedProposalIds: string[] = [];
    let acceptedCount = 0;
    let rejectedCount = 0;
    const reviewedAt = this.now();

    for (const proposal of proposals) {
      if (input.verdict === "accept") {
        await this.acceptProposal(
          proposal,
          input.reviewerIdentity,
          input.reason,
          reviewedAt,
          EdgeProposalStatus.ACCEPTED
        );
        acceptedCount += 1;
      } else {
        await this.rejectProposal(proposal, input.reviewerIdentity, input.reason, reviewedAt);
        rejectedCount += 1;
      }
      reviewedProposalIds.push(proposal.proposal_id);
    }

    return SoulBatchReviewEdgeProposalsResponseSchema.parse({
      accepted_count: acceptedCount,
      rejected_count: rejectedCount,
      reviewed_proposal_ids: reviewedProposalIds
    });
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
    // confidence clamp now lives in `proposeEdge` (keyed on
    // triggerSource === EXPLICIT) so any future caller invoking the
    // core path with EXPLICIT also gets the agent self-report ceiling.
    const proposal = await this.proposeEdge({
      sourceMemoryId: input.sourceMemoryId,
      targetMemoryId: input.targetMemoryId,
      edgeType: input.edgeType,
      workspaceId: input.workspaceId,
      runId: input.runId,
      triggerSource: EdgeProposalTriggerSource.EXPLICIT,
      confidence: input.confidence,
      reason: input.reason
    });
    return SoulProposeEdgeResponseSchema.parse({
      proposal_id: proposal.proposal_id,
      status: proposal.status
    });
  }

  private async requireMemoryInWorkspace(memoryId: string, label: string, workspaceId: string): Promise<void> {
    const memory = await this.dependencies.memoryRepo.findById(memoryId);
    if (memory === null) {
      throw new CoreError("NOT_FOUND", `${label} memory not found: ${memoryId}`);
    }
    if (memory.workspace_id !== workspaceId) {
      throw new CoreError("VALIDATION", `${label} memory does not belong to workspace ${workspaceId}: ${memoryId}`);
    }
  }

  private requireExplicitProposalIdsSelected(
    filter: EdgeProposalFilter,
    proposals: readonly EdgeProposal[]
  ): void {
    if (filter.proposal_ids === undefined) {
      return;
    }
    const selectedProposalIds = new Set(proposals.map((proposal) => proposal.proposal_id));
    const missingProposalId = filter.proposal_ids.find((proposalId) => !selectedProposalIds.has(proposalId));
    if (missingProposalId !== undefined) {
      throw new CoreError(
        "CONFLICT",
        `Edge proposal is not pending or does not match review filter: ${missingProposalId}`
      );
    }
  }

  private async acceptProposal(
    proposal: EdgeProposal,
    reviewerIdentity: string,
    reviewReason: string | null,
    reviewedAt: string,
    acceptedStatus: typeof EdgeProposalStatus.ACCEPTED | typeof EdgeProposalStatus.AUTO_ACCEPTED
  ): Promise<EdgeProposal> {
    await this.requireMemoryInWorkspace(proposal.source_memory_id, "Source", proposal.workspace_id);
    await this.requireMemoryInWorkspace(proposal.target_memory_id, "Target", proposal.workspace_id);

    let reviewed: EdgeProposal = proposal;
    await this.dependencies.eventPublisher.appendManyWithMutation(
      [buildProposalReviewedEvent(proposal, acceptedStatus, reviewerIdentity, reviewReason, reviewedAt)],
      () => {
        reviewed = this.dependencies.proposalRepo.updateReview({
          proposalId: proposal.proposal_id,
          status: acceptedStatus,
          reviewerIdentity,
          reviewReason,
          reviewedAt
        });
      }
    );

    // invariant: under the single-plane model the minted path is the ONLY
    // durable landing for an accepted proposal. applied / already_present mean
    // the owed path exists, so the accepted review row stands. A "failed" or
    // "rejected" outcome means the review row committed ACCEPTED/AUTO_ACCEPTED
    // with no path, which must never be silent: handleMintFailure emits a
    // durable SOUL_GRAPH_EDGE_PROPOSAL_PATH_MINT_FAILED record keyed on
    // proposal_id AND compensates the review row OUT of the
    // accepted-without-path state, and the OBLIGATION_VIOLATION throw stays
    // loud at call time.
    const outcome = await this.mintAcceptedPath(proposal, reviewerIdentity, acceptedStatus);
    if (outcome === "failed" || outcome === "rejected") {
      throw new CoreError(
        "OBLIGATION_VIOLATION",
        `Edge proposal accepted but path mint failed: ${proposal.proposal_id}`
      );
    }
    return reviewed;
  }

  // invariant: the shared accept->mint step. Computes the minted path's birth
  // band, submits the candidate, and on a non-success outcome emits the durable
  // mint-failed audit AND compensates the review row OUT of the
  // accepted-without-path state (handleMintFailure), then returns the outcome so
  // the caller decides whether to throw. Used by acceptProposal (throws on
  // failure) and reconcileStuckAccepts (logs, idempotent re-drive).
  //   governance ruling on the minted path's birth band:
  //   - A human ACCEPTED accept is a trust verdict: the minted path is born
  //     recall_allowed for either sign. For a negative-family edge that is
  //     human-vetted suppression (a legitimate trusted-verdict origin).
  //   - A system-policy AUTO_ACCEPTED accept is NOT a trust verdict — it is
  //     a confidence-floor rule firing. A rule/floor-detected NEGATIVE must
  //     therefore be born attention_only, not recall_allowed: it cannot
  //     suppress (isPathGovernedForSuppression requires recall_allowed) and
  //     cannot climb to recall_allowed later (negative governance promotion
  //     is sign-guarded off in path-manifestation-policy.evolveGovernanceClass).
  //     This keeps the Wave-1 invariant intact: a negative path reaches
  //     recall_allowed ONLY via a trusted llm-verdict birth seed (the
  //     conflict-detection-service.ts submitCandidate path, a different code
  //     path this does not touch) or an explicit human governance decision.
  //   - Positive (sign >= 0) auto-accepts stay recall_allowed; positive
  //     recall_allowed only nudges recall and never suppresses.
  // submitCandidate emits its own PATH_RELATION_CREATED audit row + durable
  // dedup; it is invoked after the review row commits so the accepted state
  // always has its reviewed ancestor. Outcome contract:
  //   - "failed": transient (materialize threw / event-publisher throw;
  //     materialize dedups via findByAnchorMemoryId so re-mint is idempotent).
  //     reconciles to pending -> retryable through the existing pending list.
  //   - "rejected": permanent anchor refusal (missing / foreign source or
  //     target memory) that retry can never fix. reconciles to terminal
  //     rejected -> leaves the pending list, never a retry poison pill. The
  //     path service emits its own path.relation_rejected audit on rejection.
  // see also: path-relation-proposal-service.ts (isPathGovernedForSuppression),
  //   path-manifestation-policy.ts evolveGovernanceClass (negative sign guard),
  //   conflict-detection-service.ts (the llm-verdict negative recall_allowed path).
  private async mintAcceptedPath(
    proposal: EdgeProposal,
    reviewerIdentity: string,
    acceptedStatus: typeof EdgeProposalStatus.ACCEPTED | typeof EdgeProposalStatus.AUTO_ACCEPTED
  ): Promise<PathMintOutcome> {
    const sign = edgeTypeToRecallBiasSign(proposal.edge_type);
    const magnitude = Math.abs(EDGE_TYPE_RECALL_MODEL[proposal.edge_type].contribution_weight);
    const governanceClass =
      sign < 0 && acceptedStatus === EdgeProposalStatus.AUTO_ACCEPTED
        ? "attention_only"
        : "recall_allowed";
    let outcome: PathMintOutcome;
    try {
      outcome = await this.dependencies.pathCandidatePort.submitCandidate({
        workspaceId: proposal.workspace_id,
        sourceAnchor: { kind: "object", object_id: proposal.source_memory_id },
        targetAnchor: { kind: "object", object_id: proposal.target_memory_id },
        relationKind: proposal.edge_type,
        initialStrength: Math.max(ACCEPT_PATH_STRENGTH_FLOOR, magnitude),
        governanceClass,
        evidenceBasis: [`edge_proposal_accept:${proposal.proposal_id}`],
        recallBiasSign: sign,
        recallBiasMagnitude: magnitude,
        why: [`edge proposal ${proposal.proposal_id} accepted by ${reviewerIdentity}`],
        runId: proposal.run_id
      });
    } catch (mintError) {
      // invariant: submitCandidate is contracted to catch its own materialize
      // errors and return a discriminated outcome; a thrown error is classed
      // transient ("failed", never a DECIDED rejection) and so reconciles to
      // pending for operator retry.
      await this.handleMintFailure(proposal, acceptedStatus, reviewerIdentity, "submit_threw", "failed", mintError);
      return "failed";
    }
    if (outcome === "failed" || outcome === "rejected") {
      await this.handleMintFailure(proposal, acceptedStatus, reviewerIdentity, "submit_returned_false", outcome);
    }
    return outcome;
  }

  // invariant: accept->mint is a two-step non-atomic handoff (review row commits
  // in txn1, then mintAcceptedPath mints separately). A crash between them
  // strands the proposal accepted/auto_accepted with no path, invisible to
  // listPending (status='pending' filter). This bounded sweep re-drives the
  // owed mint for up to `limit` such rows (oldest-first) and is the recovery
  // route for that crash-window orphan; the daemon GardenScheduler tick drives
  // it next to the other reclaim passes.
  // invariant: re-drive is idempotent. The path service dedups via
  // findByAnchorMemoryId, so a healthy accept whose path exists -> already_present
  // (no duplicate); permanent rejection -> terminal rejected; transient failure
  // -> pending (mintAcceptedPath/handleMintFailure). A repeat pass once every
  // owed path has landed is a no-op (all already_present).
  // invariant: returns a per-outcome tally so the caller LOGs what it reconciled
  // (no silent cap).
  // see also: edge-proposal-repo.ts listAcceptedAwaitingPath; apps/core-daemon
  //   garden-runtime.ts (reclaim passes); handleMintFailure (the compensating write).
  public async reconcileStuckAccepts(input: {
    readonly workspaceId: string;
    readonly limit: number;
  }): Promise<EdgeProposalReconcileSweepResult> {
    const workspaceId = parseObjectId(input.workspaceId);
    const stranded = this.dependencies.proposalRepo.listAcceptedAwaitingPath(workspaceId, input.limit);
    let alreadyPresent = 0;
    let reminted = 0;
    let rejected = 0;
    let transientFailed = 0;
    for (const proposal of stranded) {
      const acceptedStatus =
        proposal.status === EdgeProposalStatus.AUTO_ACCEPTED
          ? EdgeProposalStatus.AUTO_ACCEPTED
          : EdgeProposalStatus.ACCEPTED;
      // The original reviewer is preserved on the durable row; the re-drive is
      // attributed to its recorded identity (or the auto-accept policy identity
      // when the row carries none).
      const reviewerIdentity = proposal.reviewer_identity ?? AUTO_ACCEPT_REVIEWER_IDENTITY;
      const outcome = await this.mintAcceptedPath(proposal, reviewerIdentity, acceptedStatus);
      if (outcome === "applied") {
        reminted += 1;
      } else if (outcome === "already_present") {
        alreadyPresent += 1;
      } else if (outcome === "rejected") {
        rejected += 1;
      } else {
        transientFailed += 1;
      }
    }
    return {
      scanned: stranded.length,
      reminted,
      already_present: alreadyPresent,
      rejected,
      transient_failed: transientFailed
    };
  }

  // invariant: emit the durable owed-path obligation AND compensate the review
  // row in ONE transaction before the caller's OBLIGATION_VIOLATION throw
  // propagates. The accept just committed ACCEPTED/AUTO_ACCEPTED, so the
  // SOUL_GRAPH_EDGE_PROPOSAL_PATH_MINT_FAILED event keyed on proposal_id is the
  // queryable trace an operator can reconcile against PATH_RELATION_CREATED; the
  // throw alone reaches a different session (auto-accept = the propose_edge
  // caller) and leaves no durable record. reconcileAfterMintFailure runs as this
  // event's mutation so audit + row transition land atomically (crash-mid-write
  // cannot leave an audit without its reconciliation or vice versa).
  // invariant: mintOutcome decides the reconcile target.
  //   - "failed" (transient) -> back to pending: re-selectable through the
  //     existing pending review surface, no new verb. A re-accept re-mints; the
  //     path service dedups via findByAnchorMemoryId so at most one path lands.
  //   - "rejected" (permanent anchor refusal) -> terminal rejected: leaves the
  //     pending list, carries the mint-failure review_reason, never a poison
  //     pill. A re-list does not resurface it for futile retry.
  // see also: edge-proposal-repo.ts reconcileAfterMintFailure (CAS-gated write).
  private async handleMintFailure(
    proposal: EdgeProposal,
    acceptedStatus: typeof EdgeProposalStatus.ACCEPTED | typeof EdgeProposalStatus.AUTO_ACCEPTED,
    reviewerIdentity: string,
    failureKind: "submit_returned_false" | "submit_threw",
    mintOutcome: "failed" | "rejected",
    cause: unknown = null
  ): Promise<void> {
    const reviewedAt = this.now();
    const toStatus = mintOutcome === "rejected" ? EdgeProposalStatus.REJECTED : EdgeProposalStatus.PENDING;
    const reviewReason =
      mintOutcome === "rejected"
        ? `auto-rejected: owed path mint permanently refused (${PATH_MINT_FAILED_REVIEW_REASON})`
        : null;
    await this.dependencies.eventPublisher.appendManyWithMutation(
      [buildPathMintFailedEvent(proposal, reviewerIdentity, failureKind, cause, reviewedAt)],
      () => {
        this.dependencies.proposalRepo.reconcileAfterMintFailure({
          proposalId: proposal.proposal_id,
          fromStatus: acceptedStatus,
          toStatus,
          reviewerIdentity: mintOutcome === "rejected" ? reviewerIdentity : null,
          reviewReason,
          reviewedAt,
          // invariant: only the revert-to-pending path can collide with the
          // pending-unique index; the repo uses these to move the row to
          // terminal rejected instead of rolling back this audit transaction.
          supersededReviewerIdentity: PATH_MINT_SUPERSEDED_REVIEWER_IDENTITY,
          supersededReviewReason: PATH_MINT_SUPERSEDED_REVIEW_REASON
        });
      }
    );
  }

  private async rejectProposal(
    proposal: EdgeProposal,
    reviewerIdentity: string,
    reviewReason: string | null,
    reviewedAt: string
  ): Promise<void> {
    await this.dependencies.eventPublisher.appendManyWithMutation(
      [buildProposalReviewedEvent(proposal, EdgeProposalStatus.REJECTED, reviewerIdentity, reviewReason, reviewedAt)],
      () => {
        this.dependencies.proposalRepo.updateReview({
          proposalId: proposal.proposal_id,
          status: EdgeProposalStatus.REJECTED,
          reviewerIdentity,
          reviewReason,
          reviewedAt
        });
      }
    );
  }
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

function buildProposalReviewedEvent(
  proposal: EdgeProposal,
  status:
    | typeof EdgeProposalStatus.ACCEPTED
    | typeof EdgeProposalStatus.REJECTED
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
