import { randomUUID } from "node:crypto";
import {
  EdgeProposalStatus,
  EdgeProposalTriggerSource,
  GraphAuditorEventType,
  MemoryGraphEdgeSchema,
  SoulGraphEdgeCreatedPayloadSchema,
  SoulGraphEdgeProposalCreatedPayloadSchema,
  SoulGraphEdgeProposalReviewedPayloadSchema,
  SoulBatchReviewEdgeProposalsResponseSchema,
  SoulListPendingEdgeProposalsResponseSchema,
  SoulProposeEdgeResponseSchema,
  type EdgeProposal,
  type EdgeProposalFilter,
  type EdgeProposalTriggerSourceValue,
  type MemoryGraphEdge,
  type MemoryGraphEdgeTypeValue,
  type SoulBatchReviewEdgeProposalsResponse,
  type SoulListPendingEdgeProposalsResponse,
  type SoulProposeEdgeResponse
} from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import type { EventPublisher, EventPublisherInput } from "./event-publisher.js";
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
  updateReview(input: {
    readonly proposalId: string;
    readonly status: "accepted" | "rejected" | "expired" | "auto_accepted";
    readonly reviewerIdentity: string | null;
    readonly reviewReason: string | null;
    readonly reviewedAt: string;
  }): EdgeProposal;
}

export interface EdgeProposalGraphPort {
  findBySourceAndTarget(
    sourceMemoryId: string,
    targetMemoryId: string,
    edgeType: MemoryGraphEdgeTypeValue,
    workspaceId: string
  ): Promise<Readonly<MemoryGraphEdge> | null>;
  create(edge: Readonly<MemoryGraphEdge>): Readonly<MemoryGraphEdge>;
}

export interface EdgeProposalServiceDependencies {
  readonly memoryRepo: EdgeProposalMemoryRepoPort;
  readonly proposalRepo: EdgeProposalRepoPort;
  readonly graphPort: EdgeProposalGraphPort;
  readonly eventPublisher: Pick<EventPublisher, "appendManyWithMutation">;
  readonly generateId?: () => string;
  readonly now?: () => string;
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
    const createInput = {
      proposal_id: `edge_prop_${this.generateId()}`,
      workspace_id: workspaceId,
      source_memory_id: sourceMemoryId,
      target_memory_id: targetMemoryId,
      edge_type: params.edgeType,
      trigger_source: params.triggerSource ?? EdgeProposalTriggerSource.EXPLICIT,
      confidence: params.confidence ?? 0.5,
      reason: params.reason ?? null,
      source_signal_id: params.sourceSignalId ?? null,
      run_id: params.runId ?? null,
      created_at: createdAt,
      expires_at: params.expiresAt ?? null
    };
    return await this.dependencies.eventPublisher.appendManyWithMutation(
      [buildProposalCreatedEvent(createInput)],
      () => this.dependencies.proposalRepo.create(createInput)
    );
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
        await this.acceptProposal(proposal, input.reviewerIdentity, input.reason, reviewedAt);
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
    const proposal = await this.proposeEdge({
      sourceMemoryId: input.sourceMemoryId,
      targetMemoryId: input.targetMemoryId,
      edgeType: input.edgeType,
      workspaceId: input.workspaceId,
      runId: input.runId,
      triggerSource: EdgeProposalTriggerSource.EXPLICIT,
      confidence: clampAgentReportedConfidence(input.confidence),
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
    reviewedAt: string
  ): Promise<void> {
    await this.requireMemoryInWorkspace(proposal.source_memory_id, "Source", proposal.workspace_id);
    await this.requireMemoryInWorkspace(proposal.target_memory_id, "Target", proposal.workspace_id);
    const existingEdge = await this.dependencies.graphPort.findBySourceAndTarget(
      proposal.source_memory_id,
      proposal.target_memory_id,
      proposal.edge_type,
      proposal.workspace_id
    );
    const edge =
      existingEdge === null
        ? MemoryGraphEdgeSchema.parse({
            edge_id: `edge_${this.generateId()}`,
            source_memory_id: proposal.source_memory_id,
            target_memory_id: proposal.target_memory_id,
            edge_type: proposal.edge_type,
            workspace_id: proposal.workspace_id,
            created_at: reviewedAt
          })
        : null;
    const events = [
      buildProposalReviewedEvent(proposal, EdgeProposalStatus.ACCEPTED, reviewerIdentity, reviewReason, reviewedAt),
      ...(edge === null ? [] : [buildGraphEdgeCreatedEvent(edge, proposal.run_id)])
    ];

    await this.dependencies.eventPublisher.appendManyWithMutation(events, () => {
      this.dependencies.proposalRepo.updateReview({
        proposalId: proposal.proposal_id,
        status: EdgeProposalStatus.ACCEPTED,
        reviewerIdentity,
        reviewReason,
        reviewedAt
      });
      if (edge !== null) {
        this.dependencies.graphPort.create(edge);
      }
    });
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
  status: typeof EdgeProposalStatus.ACCEPTED | typeof EdgeProposalStatus.REJECTED,
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

function buildGraphEdgeCreatedEvent(edge: MemoryGraphEdge, runId: string | null): EventPublisherInput {
  return {
    event_type: GraphAuditorEventType.SOUL_GRAPH_EDGE_CREATED,
    entity_type: "memory_graph_edge",
    entity_id: edge.edge_id,
    workspace_id: edge.workspace_id,
    run_id: runId,
    caused_by: "edge_proposal_accept",
    payload_json: SoulGraphEdgeCreatedPayloadSchema.parse({
      edge_id: edge.edge_id,
      source_memory_id: edge.source_memory_id,
      target_memory_id: edge.target_memory_id,
      edge_type: edge.edge_type,
      workspace_id: edge.workspace_id,
      occurred_at: edge.created_at
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
