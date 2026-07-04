import { randomUUID } from "node:crypto";
import {
  EdgeProposalStatus,
  EdgeProposalTriggerSource,
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
import { CoreError } from "../../shared/errors.js";
import { parseObjectId } from "../../shared/validators.js";
import { buildProposalCreatedEvent, buildProposalReviewedEvent } from "./edge-proposal-events.js";
import { EdgeProposalMinter } from "./edge-proposal-minter.js";
import { EdgeProposalReviewer } from "./edge-proposal-reviewer.js";
import {
  AUTO_ACCEPT_REVIEWER_IDENTITY,
  AUTO_ACCEPT_REVIEW_REASON,
  EDGE_PROPOSAL_DEFAULT_TTL_MS,
  TTL_EXPIRY_REVIEWER_IDENTITY,
  TTL_EXPIRY_REVIEW_REASON,
  clampAgentReportedConfidence,
  isConflictError,
  toPendingSummary,
  type EdgeProposalCreateEventInput,
  type EdgeProposalCreateParams,
  type EdgeProposalExpirySweepResult,
  type EdgeProposalReconcileSweepResult,
  type EdgeProposalServiceDependencies
} from "./edge-proposal-service-ports.js";

export type {
  EdgeProposalCreateParams,
  EdgeProposalExpirySweepResult,
  EdgeProposalMemoryRepoPort,
  EdgeProposalReconcileSweepResult,
  EdgeProposalRepoPort,
  EdgeProposalServiceDependencies
} from "./edge-proposal-service-ports.js";
export {
  AUTO_ACCEPT_REVIEWER_IDENTITY,
  EDGE_PROPOSAL_DEFAULT_TTL_MS,
  TTL_EXPIRY_REVIEWER_IDENTITY
} from "./edge-proposal-service-ports.js";

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

type DistinctMemoryIds = Readonly<{
  readonly sourceMemoryId: string;
  readonly targetMemoryId: string;
  readonly workspaceId: string;
}>;

export class EdgeProposalService {
  public readonly generateId: () => string;

  public readonly now: () => string;

  private readonly minter: EdgeProposalMinter;

  private readonly reviewer: EdgeProposalReviewer;

  public constructor(public readonly dependencies: EdgeProposalServiceDependencies) {
    this.generateId = dependencies.generateId ?? randomUUID;
    this.now = dependencies.now ?? (() => new Date().toISOString());
    this.minter = new EdgeProposalMinter({
      proposalRepo: dependencies.proposalRepo,
      pathCandidatePort: dependencies.pathCandidatePort,
      eventPublisher: dependencies.eventPublisher,
      healthInboxPort: dependencies.healthInboxPort,
      now: this.now
    });
    this.reviewer = new EdgeProposalReviewer({
      memoryRepo: dependencies.memoryRepo,
      proposalRepo: dependencies.proposalRepo,
      eventPublisher: dependencies.eventPublisher,
      minter: this.minter,
      now: this.now
    });
  }

  public async proposeEdge(params: EdgeProposalCreateParams): Promise<Readonly<EdgeProposal>> {
    const ids = this.parseEdgeProposalObjectIds(params);
    await this.assertDistinctProposalMemories(ids);
    const duplicate = this.dependencies.proposalRepo.findPendingDuplicate({
      workspaceId: ids.workspaceId,
      sourceMemoryId: ids.sourceMemoryId,
      targetMemoryId: ids.targetMemoryId,
      edgeType: params.edgeType
    });
    if (duplicate !== null) {
      return duplicate;
    }
    const createInput = this.buildEdgeProposalCreateInput(params, ids);
    const created = await this.dependencies.eventPublisher.appendManyWithMutation(
      [buildProposalCreatedEvent(createInput)],
      () => this.dependencies.proposalRepo.create(createInput)
    );
    return this.maybeAutoAcceptEdgeProposal(created, createInput.trigger_source, createInput.confidence);
  }

  private parseEdgeProposalObjectIds(params: EdgeProposalCreateParams): DistinctMemoryIds {
    return Object.freeze({
      sourceMemoryId: parseObjectId(params.sourceMemoryId),
      targetMemoryId: parseObjectId(params.targetMemoryId),
      workspaceId: parseObjectId(params.workspaceId)
    });
  }

  private async assertDistinctProposalMemories(ids: DistinctMemoryIds): Promise<void> {
    if (ids.sourceMemoryId === ids.targetMemoryId) {
      throw new CoreError("VALIDATION", "Source and target memory must be different.");
    }
    await this.reviewer.requireMemoryInWorkspace(ids.sourceMemoryId, "Source", ids.workspaceId);
    await this.reviewer.requireMemoryInWorkspace(ids.targetMemoryId, "Target", ids.workspaceId);
  }

  private buildEdgeProposalCreateInput(
    params: EdgeProposalCreateParams,
    ids: DistinctMemoryIds
  ): EdgeProposalCreateEventInput {
    const createdAt = this.now();
    const triggerSource = params.triggerSource ?? EdgeProposalTriggerSource.EXPLICIT;
    const requestedConfidence = params.confidence ?? 0.5;
    const confidence =
      triggerSource === EdgeProposalTriggerSource.EXPLICIT
        ? clampAgentReportedConfidence(requestedConfidence)
        : requestedConfidence;
    return {
      proposal_id: `edge_prop_${this.generateId()}`,
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
      expires_at: params.expiresAt ?? this.defaultExpiresAt(createdAt)
    };
  }

  private async maybeAutoAcceptEdgeProposal(
    created: Readonly<EdgeProposal>,
    triggerSource: EdgeProposalTriggerSourceValue,
    confidence: number
  ): Promise<Readonly<EdgeProposal>> {
    if (!this.shouldAutoAccept(triggerSource, confidence)) {
      return created;
    }
    return this.reviewer.acceptProposal(
      created,
      AUTO_ACCEPT_REVIEWER_IDENTITY,
      AUTO_ACCEPT_REVIEW_REASON,
      this.now(),
      EdgeProposalStatus.AUTO_ACCEPTED
    );
  }

  private shouldAutoAccept(triggerSource: EdgeProposalTriggerSourceValue, confidence: number): boolean {
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
        await this.reviewer.acceptProposal(
          proposal,
          input.reviewerIdentity,
          input.reason,
          reviewedAt,
          EdgeProposalStatus.ACCEPTED
        );
        acceptedCount += 1;
      } else {
        await this.reviewer.rejectProposal(proposal, input.reviewerIdentity, input.reason, reviewedAt);
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

  private requireExplicitProposalIdsSelected(filter: EdgeProposalFilter, proposals: readonly EdgeProposal[]): void {
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
      const outcome = await this.minter.mintAcceptedPath(proposal, reviewerIdentity, acceptedStatus);
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

  private defaultExpiresAt(createdAt: string): string {
    return new Date(new Date(createdAt).getTime() + EDGE_PROPOSAL_DEFAULT_TTL_MS).toISOString();
  }

  public async sweepExpired(input: {
    readonly workspaceId: string;
    readonly limit: number;
  }): Promise<EdgeProposalExpirySweepResult> {
    const workspaceId = parseObjectId(input.workspaceId);
    const nowIso = this.now();
    const candidates = this.dependencies.proposalRepo.listExpiredPending(workspaceId, nowIso, input.limit);
    let expired = 0;
    let skipped = 0;
    for (const proposal of candidates) {
      const reviewedAt = this.now();
      try {
        await this.dependencies.eventPublisher.appendManyWithMutation(
          [
            buildProposalReviewedEvent(
              proposal,
              EdgeProposalStatus.EXPIRED,
              TTL_EXPIRY_REVIEWER_IDENTITY,
              TTL_EXPIRY_REVIEW_REASON,
              reviewedAt
            )
          ],
          () => {
            this.dependencies.proposalRepo.updateReview({
              proposalId: proposal.proposal_id,
              status: EdgeProposalStatus.EXPIRED,
              reviewerIdentity: TTL_EXPIRY_REVIEWER_IDENTITY,
              reviewReason: TTL_EXPIRY_REVIEW_REASON,
              reviewedAt
            });
          }
        );
        expired += 1;
      } catch (error) {
        // invariant: CAS lost -> the row is no longer pending (a concurrent
        // accept/reject won). updateReview is CAS-gated on status='pending' and
        // raises a CONFLICT-coded error (CoreError or the repo's StorageError)
        // when the predicate matches no row. The audit append + updateReview run
        // in one txn, so the CONFLICT rolled the audit back too; nothing was
        // written. Treat as skipped, not fatal, so one raced row never aborts the
        // whole sweep. Duck-typed on `code` to avoid a core->storage import.
        if (isConflictError(error)) {
          skipped += 1;
          continue;
        }
        throw error;
      }
    }
    return { scanned: candidates.length, expired, skipped };
  }
}
