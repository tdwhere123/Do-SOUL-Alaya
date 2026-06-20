import { clamp01 } from "../shared/clamp.js";
import {
  EdgeProposalTriggerSource,
  MemoryGraphEdgeType,
  getPathAnchorBackingObjectId,
  type EdgeClassifyVerdict,
  type EdgeProposalTriggerSourceValue,
  type MemoryEntry,
  type MemoryGraphEdgeTypeValue,
  type PathRelation
} from "@do-soul/alaya-protocol";
import type {
  EdgeAutoProducerLlmDecision,
  EdgeAutoProducerLlmPort
} from "./edge-auto-producer-llm-port.js";
import {
  DERIVES_FROM_SEED_PROFILE,
  SUPPORTS_SEED_PROFILE,
  type PathSeedProfile
} from "./path-relation-proposal-service.js";
import type { PathCandidateSink } from "./path-candidate-sink.js";
import { CoreError } from "../shared/errors.js";
import { parseObjectId } from "../shared/validators.js";
import type {
  EdgeAutoDecision,
  EdgeAutoProducerInput,
  EdgeAutoProducerServiceDependencies
} from "./edge-auto-producer-types.js";
import {
  LLM_CONFIDENCE_FLOOR,
  MAX_EDGE_PROPOSALS_PER_MEMORY,
  NEIGHBOR_SEARCH_LIMIT,
  classifyNeighbor,
  errorMessage,
  isEligibleNeighbor,
  passesLlmPregate,
  round2,
  seedProfileForEdgeType
} from "./edge-auto-producer-heuristics.js";
export type {
  EdgeAutoDecision,
  EdgeAutoProducerInput,
  EdgeAutoProducerMemoryRepoPort,
  EdgeAutoProducerMemorySearchHit,
  EdgeAutoProducerServiceDependencies,
  EdgeClassifyExistingPathReaderPort,
  EdgeClassifyQueuePort
} from "./edge-auto-producer-types.js";

export class EdgeAutoProducerService {
  public constructor(private readonly deps: EdgeAutoProducerServiceDependencies) {}

  public async produceForNewMemory(input: EdgeAutoProducerInput): Promise<void> {
    const { workspaceId, newMemory } = await this.loadValidatedNewMemory(input);
    const orderedNeighbors = await this.loadOrderedNeighbors(workspaceId, newMemory);
    if (orderedNeighbors.length === 0) {
      return;
    }
    const transientFailures = await this.submitNeighborProposals({
      orderedNeighbors,
      newMemory,
      input,
      workspaceId
    });
    this.throwTransientProposalFailures(transientFailures, newMemory.object_id);
  }

  // The inline heuristic always runs; queue/LLM refinement only adds stronger pair classification when eligible.
  private async decideForNeighbor(
    newMemory: Readonly<MemoryEntry>,
    neighbor: Readonly<MemoryEntry>,
    input: EdgeAutoProducerInput
  ): Promise<EdgeAutoDecision | null> {
    if (!isEligibleNeighbor(newMemory, neighbor)) {
      return null;
    }
    if (this.deps.edgeClassifyQueue !== undefined) {
      if (passesLlmPregate(newMemory, neighbor)) {
        await this.deferEdgeClassify(newMemory, neighbor, input);
      }
      return classifyNeighbor(newMemory, neighbor);
    }
    if (this.deps.llmPort !== undefined && passesLlmPregate(newMemory, neighbor)) {
      const llmDecision = await this.tryLlmDecision(newMemory, neighbor);
      if (llmDecision !== null) {
        return llmDecision;
      }
    }
    return classifyNeighbor(newMemory, neighbor);
  }

  // Queue failure is observable but non-fatal because the inline heuristic verdict already stands.
  private async deferEdgeClassify(
    newMemory: Readonly<MemoryEntry>,
    neighbor: Readonly<MemoryEntry>,
    input: EdgeAutoProducerInput
  ): Promise<void> {
    const queue = this.deps.edgeClassifyQueue;
    if (queue === undefined) {
      return;
    }
    try {
      await queue.enqueueEdgeClassify({
        workspaceId: input.workspaceId,
        runId: input.runId,
        sourceSignalId: input.sourceSignalId,
        dimension: newMemory.dimension,
        scopeClass: newMemory.scope_class,
        source: {
          object_id: newMemory.object_id,
          content: newMemory.content,
          domainTags: newMemory.domain_tags
        },
        neighbor: {
          object_id: neighbor.object_id,
          content: neighbor.content,
          domainTags: neighbor.domain_tags
        }
      });
    } catch (err) {
      this.warn("edge auto producer edge-classify enqueue failed", {
        new_memory_id: newMemory.object_id,
        neighbor_memory_id: neighbor.object_id,
        error: errorMessage(err)
      });
    }
  }

  // Host-worker verdicts refine or add positive paths, but never remove the inline heuristic edge.
  public async applyVerdict(input: {
    readonly workspaceId: string;
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
    readonly verdict: EdgeClassifyVerdict;
  }): Promise<string | null> {
    const workspaceId = parseObjectId(input.workspaceId);
    const sourceId = parseObjectId(input.verdict.source_object_id);
    const targetId = parseObjectId(input.verdict.neighbor_object_id);
    const decision = this.resolveHostVerdictDecision(input.verdict);
    if (decision === null) {
      return null;
    }
    if (await this.positiveAssociativePathExists(workspaceId, sourceId, targetId)) {
      return "already_present";
    }
    const outcome = await this.submitHostVerdict({
      workspaceId,
      sourceId,
      targetId,
      runId: input.runId,
      sourceSignalId: input.sourceSignalId,
      decision
    });
    this.warnFailedHostVerdictMint(outcome, sourceId, targetId, input.verdict.edge_type);
    return outcome;
  }

  // Reader failures fall back to sink-level dedup rather than blocking verdict submission.
  private async positiveAssociativePathExists(
    workspaceId: string,
    sourceId: string,
    targetId: string
  ): Promise<boolean> {
    const reader = this.deps.existingPathReader;
    if (reader === undefined) {
      return false;
    }
    let existing: readonly Readonly<PathRelation>[];
    try {
      existing = await reader.findByBackingObjectId(workspaceId, sourceId);
    } catch (err) {
      this.warn("edge auto producer existing-path lookup failed", {
        source_object_id: sourceId,
        neighbor_object_id: targetId,
        error: errorMessage(err)
      });
      return false;
    }
    return existing.some((relation) => {
      if (relation.effect_vector.recall_bias <= 0) {
        return false;
      }
      if (relation.lifecycle.status !== "active") {
        return false;
      }
      const relationSource = getPathAnchorBackingObjectId(relation.anchors.source_anchor);
      const relationTarget = getPathAnchorBackingObjectId(relation.anchors.target_anchor);
      return relationSource === sourceId && relationTarget === targetId;
    });
  }

  private async tryLlmDecision(
    newMemory: Readonly<MemoryEntry>,
    neighbor: Readonly<MemoryEntry>
  ): Promise<EdgeAutoDecision | null> {
    const port = this.deps.llmPort;
    if (port === undefined) {
      return null;
    }
    let verdict: EdgeAutoProducerLlmDecision | null;
    try {
      verdict = await port.classifyPair({ newMemory, neighbor });
    } catch (err) {
      this.warn("edge auto producer llm port classify failed", {
        new_memory_id: newMemory.object_id,
        neighbor_memory_id: neighbor.object_id,
        error: errorMessage(err)
      });
      return null;
    }
    if (verdict === null) {
      return null;
    }
    const clampedConfidence = clamp01(verdict.confidence);
    if (clampedConfidence < LLM_CONFIDENCE_FLOOR) {
      return null;
    }
    const edgeType =
      verdict.edgeType === "supports"
        ? MemoryGraphEdgeType.SUPPORTS
        : MemoryGraphEdgeType.DERIVES_FROM;
    const rationale = verdict.rationale.trim();
    return {
      edgeType,
      confidence: round2(clampedConfidence),
      triggerSource: EdgeProposalTriggerSource.LLM_SUPPORTS,
      reason: rationale.length === 0
        ? `B-2 llm pair classifier: ${verdict.edgeType}`
        : `B-2 llm pair classifier: ${verdict.edgeType} (${rationale})`
    };
  }

  private warn(message: string, meta: Record<string, unknown>): void {
    if (this.deps.warn !== undefined) {
      this.deps.warn(message, meta);
    }
  }

  private async loadValidatedNewMemory(input: EdgeAutoProducerInput): Promise<Readonly<{
    readonly workspaceId: string;
    readonly newMemory: Readonly<MemoryEntry>;
  }>> {
    const newMemoryId = parseObjectId(input.newMemoryId);
    const workspaceId = parseObjectId(input.workspaceId);
    const newMemory = await this.deps.memoryRepo.findById(newMemoryId);
    if (newMemory === null) {
      throw new CoreError("NOT_FOUND", `New memory not found for edge auto-producer: ${newMemoryId}`);
    }
    if (newMemory.workspace_id !== workspaceId) {
      throw new CoreError(
        "VALIDATION",
        `New memory does not belong to workspace ${workspaceId}: ${newMemoryId}`
      );
    }
    return Object.freeze({ workspaceId, newMemory });
  }

  private async loadOrderedNeighbors(
    workspaceId: string,
    newMemory: Readonly<MemoryEntry>
  ): Promise<readonly Readonly<MemoryEntry>[]> {
    const neighborIds = await this.collectNeighborIds(workspaceId, newMemory);
    const neighbors = await this.deps.memoryRepo.findByIds(neighborIds);
    const rankById = new Map(neighborIds.map((objectId, index) => [objectId, index]));
    return [...neighbors].sort(
      (left, right) =>
        (rankById.get(left.object_id) ?? Number.MAX_SAFE_INTEGER) -
        (rankById.get(right.object_id) ?? Number.MAX_SAFE_INTEGER)
    );
  }

  // Transient submitCandidate failures must escape so the bulk-enrich worker retries the memory claim.
  private async submitNeighborProposals(params: Readonly<{
    readonly orderedNeighbors: readonly Readonly<MemoryEntry>[];
    readonly newMemory: Readonly<MemoryEntry>;
    readonly input: EdgeAutoProducerInput;
    readonly workspaceId: string;
  }>): Promise<number> {
    let proposalCount = 0;
    let transientFailures = 0;
    for (const neighbor of params.orderedNeighbors) {
      if (proposalCount >= MAX_EDGE_PROPOSALS_PER_MEMORY) {
        break;
      }
      const outcome = await this.submitNeighborDecision(params, neighbor);
      if (outcome === "applied") {
        proposalCount += 1;
      } else if (outcome === "failed") {
        transientFailures += 1;
      }
    }
    return transientFailures;
  }

  private async submitNeighborDecision(
    params: Readonly<{
      readonly newMemory: Readonly<MemoryEntry>;
      readonly input: EdgeAutoProducerInput;
      readonly workspaceId: string;
    }>,
    neighbor: Readonly<MemoryEntry>
  ): Promise<string | null> {
    const decision = await this.decideForNeighbor(params.newMemory, neighbor, params.input);
    if (decision === null) {
      return null;
    }
    const profile = seedProfileForEdgeType(decision.edgeType);
    return this.deps.pathCandidatePort.submitCandidate({
      workspaceId: params.workspaceId,
      sourceAnchor: { kind: "object", object_id: params.newMemory.object_id },
      targetAnchor: { kind: "object", object_id: neighbor.object_id },
      relationKind: profile.relationKind,
      initialStrength: profile.initialStrength,
      governanceClass: profile.governanceClass,
      evidenceBasis: profile.evidenceBasis,
      recallBiasSign: profile.recallBiasSign,
      recallBiasMagnitude: profile.recallBiasMagnitude,
      why: [
        `${decision.triggerSource}: ${decision.reason}`,
        `source_signal=${params.input.sourceSignalId} run=${params.input.runId}`
      ],
      runId: params.input.runId
    });
  }

  private throwTransientProposalFailures(transientFailures: number, newMemoryId: string): void {
    if (transientFailures > 0) {
      throw new CoreError(
        "OBLIGATION_VIOLATION",
        `Edge auto-producer: ${transientFailures} path candidate(s) failed transiently for ${newMemoryId}`
      );
    }
  }

  private async collectNeighborIds(
    workspaceId: string,
    newMemory: Readonly<MemoryEntry>
  ): Promise<readonly string[]> {
    const hits = await this.deps.memoryRepo.searchByKeyword(
      workspaceId,
      newMemory.content,
      NEIGHBOR_SEARCH_LIMIT
    );
    const ids: string[] = [];
    const seen = new Set<string>([newMemory.object_id]);
    for (const hit of hits) {
      if (seen.has(hit.object_id)) {
        continue;
      }
      seen.add(hit.object_id);
      ids.push(hit.object_id);
      if (ids.length >= NEIGHBOR_SEARCH_LIMIT) {
        break;
      }
    }
    return ids;
  }

  private resolveHostVerdictDecision(
    verdict: EdgeClassifyVerdict
  ): Readonly<{
    readonly edgeType: MemoryGraphEdgeTypeValue;
    readonly profile: PathSeedProfile;
    readonly rationale: string;
  }> | null {
    if (verdict.edge_type === "none" || clamp01(verdict.confidence) < LLM_CONFIDENCE_FLOOR) {
      return null;
    }
    const edgeType =
      verdict.edge_type === "supports"
        ? MemoryGraphEdgeType.SUPPORTS
        : MemoryGraphEdgeType.DERIVES_FROM;
    return Object.freeze({
      edgeType,
      profile: seedProfileForEdgeType(edgeType),
      rationale: verdict.rationale.trim()
    });
  }

  // The host-worker classifier shares the llm_supports trigger bucket with the in-process LLM path.
  private async submitHostVerdict(params: Readonly<{
    readonly workspaceId: string;
    readonly sourceId: string;
    readonly targetId: string;
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
    readonly decision: Readonly<{
      readonly edgeType: MemoryGraphEdgeTypeValue;
      readonly profile: PathSeedProfile;
      readonly rationale: string;
    }>;
  }>): Promise<string> {
    return this.deps.pathCandidatePort.submitCandidate({
      workspaceId: params.workspaceId,
      sourceAnchor: { kind: "object", object_id: params.sourceId },
      targetAnchor: { kind: "object", object_id: params.targetId },
      relationKind: params.decision.profile.relationKind,
      initialStrength: params.decision.profile.initialStrength,
      governanceClass: params.decision.profile.governanceClass,
      evidenceBasis: params.decision.profile.evidenceBasis,
      recallBiasSign: params.decision.profile.recallBiasSign,
      recallBiasMagnitude: params.decision.profile.recallBiasMagnitude,
      why: this.buildHostVerdictWhy(params),
      runId: params.runId
    });
  }

  private buildHostVerdictWhy(params: Readonly<{
    readonly sourceId: string;
    readonly runId: string | null;
    readonly sourceSignalId: string | null;
    readonly decision: Readonly<{
      readonly edgeType: MemoryGraphEdgeTypeValue;
      readonly rationale: string;
    }>;
  }>): readonly string[] {
    return [
      `${EdgeProposalTriggerSource.LLM_SUPPORTS}: B-2 host-worker pair classifier: ${params.decision.edgeType}${
        params.decision.rationale.length === 0 ? "" : ` (${params.decision.rationale})`
      }`,
      `source_signal=${params.sourceSignalId ?? params.sourceId} run=${params.runId ?? "unattributed"}`
    ];
  }

  private warnFailedHostVerdictMint(
    outcome: string,
    sourceId: string,
    targetId: string,
    edgeType: EdgeClassifyVerdict["edge_type"]
  ): void {
    if (outcome === "failed") {
      this.warn("edge auto producer host verdict mint failed transiently", {
        source_object_id: sourceId,
        neighbor_object_id: targetId,
        edge_type: edgeType
      });
    }
  }
}
