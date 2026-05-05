import {
  GardenRole,
  GardenTaskKind,
  GardenTier,
  HealthEventKind,
  MemoryGraphEdgeType,
  type GardenRoleValue,
  type GardenTaskDescriptor,
  type GardenTaskResult,
  type GardenTierValue,
  type HealthJournalRecordPort
} from "@do-soul/alaya-protocol";
import type { GraphEdgeCreationPort } from "./materialization-router.js";
import {
  PATH_PLASTICITY_TASK_DEFAULTS,
  resolvePathPlasticitySinceIso,
  resolvePathPlasticityUntilIso,
  runPathPlasticityWithinBudget,
  type PathPlasticityComputePort,
  type PathPlasticityPendingPort
} from "./path-plasticity-task.js";

export const LIBRARIAN_CONSTANTS = {
  MERGE_THRESHOLD: 0.85,
  TEMPLATE_MIN_CLUSTER_SIZE: 3,
  BATCH_SIZE: 10
} as const;

export interface MergeCandidate {
  readonly primary_id: string;
  readonly duplicate_ids: readonly string[];
  readonly object_kind: string;
  readonly similarity_score: number;
}

interface TemplateCluster {
  readonly representative_id: string;
  readonly member_ids: readonly string[];
  readonly pattern_description: string;
}

export interface LibrarianMergeDetectionPort {
  findMergeCandidates(workspaceId: string): Promise<readonly MergeCandidate[]>;
  hasPendingMergeProposal(primaryId: string): Promise<boolean>;
  createMergeProposal(workspaceId: string, candidate: MergeCandidate): Promise<{ readonly proposal_id: string }>;
  findTemplateClusters(workspaceId: string, minClusterSize: number): Promise<readonly TemplateCluster[]>;
  hasPendingTemplateProposal(representativeId: string): Promise<boolean>;
  createTemplateCandidate(
    workspaceId: string,
    cluster: TemplateCluster
  ): Promise<{ readonly candidate_id: string }>;
}

export interface NeighborGroup {
  readonly subject: string;
  readonly object_ids: readonly string[];
  readonly overlap_basis: string;
}

export interface LibrarianNeighborDetectionPort {
  findSubjectNeighbors(workspaceId: string): Promise<readonly NeighborGroup[]>;
}

export interface CompressionCandidate {
  readonly chain_start: string;
  readonly chain_end: string;
  readonly intermediate_ids: readonly string[];
}

export interface LibrarianPathCompressionPort {
  findCompressiblePaths(workspaceId: string): Promise<readonly CompressionCandidate[]>;
  createCompressionCandidate(
    workspaceId: string,
    candidate: CompressionCandidate
  ): Promise<{ readonly candidate_id: string }>;
}

interface SynthesisCandidateCluster {
  readonly subject: string;
  readonly evidence_ids: readonly string[];
}

export interface LibrarianSynthesisThrottlePort {
  findSynthesisCandidateClusters(workspaceId: string): Promise<readonly SynthesisCandidateCluster[]>;
  hasPendingSynthesisForSubject(workspaceId: string, subject: string): Promise<boolean>;
  createSynthesisReviewCandidate(
    workspaceId: string,
    subject: string,
    evidenceIds: readonly string[]
  ): Promise<{ readonly candidate_id: string }>;
}

export interface LibrarianSchedulerPort {
  reportCompletion(result: GardenTaskResult): Promise<void>;
}

export interface LibrarianDependencies {
  readonly mergePort: LibrarianMergeDetectionPort;
  readonly neighborPort: LibrarianNeighborDetectionPort;
  readonly compressionPort: LibrarianPathCompressionPort;
  readonly synthesisPort: LibrarianSynthesisThrottlePort;
  readonly scheduler: LibrarianSchedulerPort;
  readonly healthJournal?: HealthJournalRecordPort;
  readonly graphEdgePort?: GraphEdgeCreationPort;
  readonly pathPlasticityPort?: PathPlasticityComputePort;
  readonly pathPlasticityPendingPort?: PathPlasticityPendingPort;
  readonly pathPlasticityBudgetMs?: number;
  readonly now?: () => string;
}

export class Librarian {
  public readonly role: GardenRoleValue = GardenRole.LIBRARIAN;
  public readonly tier: GardenTierValue = GardenTier.TIER_2;

  private readonly mergePort: LibrarianMergeDetectionPort;
  private readonly neighborPort: LibrarianNeighborDetectionPort;
  private readonly compressionPort: LibrarianPathCompressionPort;
  private readonly synthesisPort: LibrarianSynthesisThrottlePort;
  private readonly scheduler: LibrarianSchedulerPort;
  private readonly healthJournal: HealthJournalRecordPort | null;
  private readonly graphEdgePort: GraphEdgeCreationPort | null;
  private readonly pathPlasticityPort: PathPlasticityComputePort | null;
  private readonly pathPlasticityPendingPort: PathPlasticityPendingPort | null;
  private readonly pathPlasticityBudgetMs: number;
  private readonly now: () => string;

  public constructor(deps: LibrarianDependencies) {
    this.mergePort = deps.mergePort;
    this.neighborPort = deps.neighborPort;
    this.compressionPort = deps.compressionPort;
    this.synthesisPort = deps.synthesisPort;
    this.scheduler = deps.scheduler;
    this.healthJournal = deps.healthJournal ?? null;
    this.graphEdgePort = deps.graphEdgePort ?? null;
    this.pathPlasticityPort = deps.pathPlasticityPort ?? null;
    this.pathPlasticityPendingPort = deps.pathPlasticityPendingPort ?? null;
    this.pathPlasticityBudgetMs =
      deps.pathPlasticityBudgetMs ?? PATH_PLASTICITY_TASK_DEFAULTS.MAX_EXECUTION_MS;
    this.now = deps.now ?? (() => new Date().toISOString());
  }

  public async run(task: GardenTaskDescriptor): Promise<GardenTaskResult> {
    const completedAt = this.now();

    try {
      switch (task.task_kind) {
        case GardenTaskKind.MERGE_PROPOSAL:
          return await this.executeMergeProposal(task, completedAt);
        case GardenTaskKind.SUBJECT_NEIGHBOR_DETECT:
          return await this.executeSubjectNeighborDetect(task, completedAt);
        case GardenTaskKind.PATH_COMPRESSION:
          return await this.executePathCompression(task, completedAt);
        case GardenTaskKind.TEMPLATE_CANDIDATE:
          return await this.executeTemplateCandidate(task, completedAt);
        case GardenTaskKind.SYNTHESIS_REVIEW:
          return await this.executeSynthesisReview(task, completedAt);
        case GardenTaskKind.PATH_PLASTICITY_UPDATE:
          return await this.executePathPlasticityUpdate(task, completedAt);
        default:
          throw new Error(`Librarian does not handle task kind: ${task.task_kind}`);
      }
    } catch (error) {
      const result = this.createFailureResult(task, completedAt, error);
      await this.scheduler.reportCompletion(result);
      return result;
    }
  }

  private async executeMergeProposal(task: GardenTaskDescriptor, completedAt: string): Promise<GardenTaskResult> {
    const candidates = await this.mergePort.findMergeCandidates(task.workspace_id);
    const eligibleCandidates = candidates
      .filter((candidate) => candidate.similarity_score >= LIBRARIAN_CONSTANTS.MERGE_THRESHOLD)
      .slice(0, LIBRARIAN_CONSTANTS.BATCH_SIZE);
    let createdProposalIds: readonly string[] = [];

    for (const candidate of eligibleCandidates) {
      const hasPending = await this.mergePort.hasPendingMergeProposal(candidate.primary_id);
      if (hasPending) {
        continue;
      }

      const proposal = await this.mergePort.createMergeProposal(task.workspace_id, candidate);
      createdProposalIds = [...createdProposalIds, proposal.proposal_id];
    }

    const result = this.createSuccessResult(task, completedAt, createdProposalIds, [
      `merge_proposal: created ${createdProposalIds.length} merge proposals`
    ]);
    await this.scheduler.reportCompletion(result);
    return result;
  }

  private async executeSubjectNeighborDetect(
    task: GardenTaskDescriptor,
    completedAt: string
  ): Promise<GardenTaskResult> {
    const groups = await this.neighborPort.findSubjectNeighbors(task.workspace_id);

    if (groups.length > 0) {
      await this.healthJournal?.record({
        event_kind: HealthEventKind.GARDEN_BACKLOG,
        workspace_id: task.workspace_id,
        run_id: task.run_id,
        summary: `Subject neighbor detection: ${groups.length} overlapping subject groups found`,
        detail_json: {
          group_count: groups.length,
          sample_groups: groups.slice(0, 3).map((group) => ({
            subject: group.subject,
            object_count: group.object_ids.length,
            overlap_basis: group.overlap_basis
          }))
        }
      });

      // Connect structurally related memories with recalls edges.
      // Errors are silently swallowed — edge creation must not block the task.
      if (this.graphEdgePort !== null) {
        for (const group of groups) {
          if (group.object_ids.length < 2) {
            continue;
          }

          const [anchor, ...rest] = group.object_ids;
          for (const neighborId of rest) {
            try {
              await this.graphEdgePort.createEdge({
                sourceMemoryId: anchor,
                targetMemoryId: neighborId,
                edgeType: MemoryGraphEdgeType.RECALLS,
                workspaceId: task.workspace_id,
                runId: task.run_id
              });
            } catch {
              // Fire-and-forget: edges are supplementary metadata, not critical.
            }
          }
        }
      }
    }

    const affectedObjectIds = Array.from(new Set(groups.flatMap((group) => group.object_ids)));
    const result = this.createSuccessResult(task, completedAt, affectedObjectIds, [
      `subject_neighbor_detect: detected ${groups.length} overlapping subject groups`
    ]);
    await this.scheduler.reportCompletion(result);
    return result;
  }

  private async executePathCompression(
    task: GardenTaskDescriptor,
    completedAt: string
  ): Promise<GardenTaskResult> {
    const candidates = await this.compressionPort.findCompressiblePaths(task.workspace_id);
    let createdCandidateIds: readonly string[] = [];

    for (const candidate of candidates.slice(0, LIBRARIAN_CONSTANTS.BATCH_SIZE)) {
      const created = await this.compressionPort.createCompressionCandidate(task.workspace_id, candidate);
      createdCandidateIds = [...createdCandidateIds, created.candidate_id];
    }

    const result = this.createSuccessResult(task, completedAt, createdCandidateIds, [
      `path_compression: created ${createdCandidateIds.length} compression candidates`
    ]);
    await this.scheduler.reportCompletion(result);
    return result;
  }

  private async executeTemplateCandidate(
    task: GardenTaskDescriptor,
    completedAt: string
  ): Promise<GardenTaskResult> {
    const clusters = await this.mergePort.findTemplateClusters(
      task.workspace_id,
      LIBRARIAN_CONSTANTS.TEMPLATE_MIN_CLUSTER_SIZE
    );
    let createdCandidateIds: readonly string[] = [];

    for (const cluster of clusters.slice(0, LIBRARIAN_CONSTANTS.BATCH_SIZE)) {
      const hasPending = await this.mergePort.hasPendingTemplateProposal(cluster.representative_id);
      if (hasPending) {
        continue;
      }

      const created = await this.mergePort.createTemplateCandidate(task.workspace_id, cluster);
      createdCandidateIds = [...createdCandidateIds, created.candidate_id];
    }

    const result = this.createSuccessResult(task, completedAt, createdCandidateIds, [
      `template_candidate: created ${createdCandidateIds.length} template candidates`
    ]);
    await this.scheduler.reportCompletion(result);
    return result;
  }

  private async executeSynthesisReview(
    task: GardenTaskDescriptor,
    completedAt: string
  ): Promise<GardenTaskResult> {
    const clusters = await this.synthesisPort.findSynthesisCandidateClusters(task.workspace_id);
    let createdCandidateIds: readonly string[] = [];

    for (const cluster of clusters.slice(0, LIBRARIAN_CONSTANTS.BATCH_SIZE)) {
      const hasPending = await this.synthesisPort.hasPendingSynthesisForSubject(
        task.workspace_id,
        cluster.subject
      );
      if (hasPending) {
        continue;
      }

      const created = await this.synthesisPort.createSynthesisReviewCandidate(
        task.workspace_id,
        cluster.subject,
        cluster.evidence_ids
      );
      createdCandidateIds = [...createdCandidateIds, created.candidate_id];
    }

    const result = this.createSuccessResult(task, completedAt, createdCandidateIds, [
      `synthesis_review: created ${createdCandidateIds.length} synthesis review candidates`
    ]);
    await this.scheduler.reportCompletion(result);
    return result;
  }

  private async executePathPlasticityUpdate(
    task: GardenTaskDescriptor,
    completedAt: string
  ): Promise<GardenTaskResult> {
    try {
      const pathPlasticityPort = this.pathPlasticityPort;

      if (pathPlasticityPort === null) {
        const result = this.createSuccessResult(task, completedAt, [], [
          "path_plasticity_update: skipped because path plasticity port is not configured"
        ]);
        await this.scheduler.reportCompletion(result);
        return result;
      }

      const sinceIso = resolvePathPlasticitySinceIso(task.target_object_refs, completedAt);
      const untilIso = resolvePathPlasticityUntilIso(task.target_object_refs, completedAt);
      const computed = await runPathPlasticityWithinBudget(
        (abortSignal, onMutationBoundaryEntered) => pathPlasticityPort.computeAndApplyPlasticity({
          workspaceId: task.workspace_id,
          sinceIso,
          untilIso,
          abortSignal,
          onMutationBoundaryEntered
        }),
        this.pathPlasticityBudgetMs,
        "path_plasticity_update"
      );
      await pathPlasticityPort.markProcessed?.({
        workspaceId: task.workspace_id,
        processedThroughIso: untilIso,
        processedAuditEventId: null
      });

      const result = this.createSuccessResult(task, completedAt, computed.affectedPathIds, [
        `path_plasticity_update: reinforced=${computed.reinforced} weakened=${computed.weakened} retired=${computed.retired} since=${sinceIso} until=${untilIso} budget_ms=${this.pathPlasticityBudgetMs}`
      ]);
      await this.scheduler.reportCompletion(result);
      return result;
    } finally {
      await this.pathPlasticityPendingPort?.clearPendingWorkspace(task.workspace_id);
    }
  }

  private createSuccessResult(
    task: GardenTaskDescriptor,
    completedAt: string,
    objectIds: readonly string[],
    auditEntries: readonly string[]
  ): GardenTaskResult {
    return {
      task_id: task.task_id,
      task_kind: task.task_kind,
      role: this.role,
      tier: this.tier,
      workspace_id: task.workspace_id,
      success: true,
      objects_affected: [...objectIds],
      audit_entries: [...auditEntries],
      error_message: null,
      completed_at: completedAt
    };
  }

  private createFailureResult(
    task: GardenTaskDescriptor,
    completedAt: string,
    error: unknown
  ): GardenTaskResult {
    return {
      task_id: task.task_id,
      task_kind: task.task_kind,
      role: this.role,
      tier: this.tier,
      workspace_id: task.workspace_id,
      success: false,
      objects_affected: [],
      audit_entries: [],
      error_message: error instanceof Error ? error.message : String(error),
      completed_at: completedAt
    };
  }
}
