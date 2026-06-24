import {
  addDecision,
  errorMessage,
  jaccardIndex,
  normalizeForIdentity,
  tokenize,
  type MemoryEntry,
  type ReconciliationDecision,
  type ReconciliationInput,
  type ReconciliationKeywordSearchPort,
  type ReconciliationLlmDecisionPort,
  type ReconciliationMemoryRepoPort
} from "./reconciliation-service-internal.js";

interface NeighborCandidate {
  readonly entry: Readonly<MemoryEntry>;
  readonly similarity: number;
}

interface NeighborAnalysis {
  readonly best: NeighborCandidate | null;
  readonly identical: Readonly<MemoryEntry> | null;
  readonly sawConflictNeighbor: boolean;
  readonly ambiguous: NeighborCandidate[];
}

export interface ReconciliationDeciderDependencies {
  readonly keywordSearch: ReconciliationKeywordSearchPort;
  readonly memoryRepo: ReconciliationMemoryRepoPort;
  readonly llmDecision: ReconciliationLlmDecisionPort;
  readonly similarityFloor: number;
  readonly conflictTagOverlapThreshold: number;
  readonly topK: number;
  readonly maxLlmCandidates: number;
  readonly warn: (message: string, meta: Record<string, unknown>) => void;
}

export class ReconciliationDecider {
  public constructor(private readonly deps: ReconciliationDeciderDependencies) {}

  public async decide(input: ReconciliationInput): Promise<ReconciliationDecision> {
    const incomingContent = input.incomingContent.trim();
    if (incomingContent.length === 0) {
      return addDecision(0, false, "empty incoming content — no reconciliation");
    }

    const neighbors = await this.retrieveNeighbors(input.workspaceId, incomingContent);
    if (neighbors.length === 0) {
      return addDecision(0, false, "no lexically-similar existing memory");
    }

    const analysis = this.analyzeNeighbors(input, incomingContent, neighbors);

    if (analysis.best === null) {
      return addDecision(0, analysis.sawConflictNeighbor, "no comparable neighbor content");
    }

    if (analysis.identical !== null) {
      return buildIdenticalDecision(analysis.identical, analysis.best.similarity);
    }

    if (analysis.ambiguous.length > 0) {
      return await this.decideWithAmbiguousNeighbors(input, incomingContent, analysis);
    }

    return addDecision(
      analysis.best.similarity,
      analysis.sawConflictNeighbor,
      analysis.sawConflictNeighbor
        ? "distinct fact with a same-topic divergent neighbor"
        : "distinct fact"
    );
  }

  private async retrieveNeighbors(workspaceId: string, incomingContent: string): Promise<readonly Readonly<MemoryEntry>[]> {
    let hits: readonly { readonly object_id: string }[];
    try {
      hits = await this.deps.keywordSearch.searchByKeyword(
        workspaceId,
        incomingContent,
        this.deps.topK
      );
    } catch (error) {
      this.deps.warn("reconciliation keyword search failed", {
        workspace_id: workspaceId,
        error: errorMessage(error)
      });
      return [];
    }
    if (hits.length === 0) {
      return [];
    }
    try {
      const entries = await this.deps.memoryRepo.findByIds(
        workspaceId,
        hits.map((hit) => hit.object_id)
      );
      return entries.filter((entry) => entry.lifecycle_state !== "archived");
    } catch (error) {
      this.deps.warn("reconciliation neighbor fetch failed", {
        workspace_id: workspaceId,
        error: errorMessage(error)
      });
      return [];
    }
  }

  private analyzeNeighbors(
    input: ReconciliationInput,
    incomingContent: string,
    neighbors: readonly Readonly<MemoryEntry>[]
  ): NeighborAnalysis {
    const incomingTokens = tokenize(incomingContent);
    const incomingTagSet = new Set(input.incomingDomainTags);
    const incomingIdentityKey = normalizeForIdentity(incomingContent);
    let best: NeighborCandidate | null = null;
    let identical: Readonly<MemoryEntry> | null = null;
    let sawConflictNeighbor = false;
    const ambiguous: NeighborCandidate[] = [];

    for (const neighbor of neighbors) {
      const similarity = jaccardIndex(incomingTokens, tokenize(neighbor.content));
      best = best === null || similarity > best.similarity ? { entry: neighbor, similarity } : best;
      if (identical === null && normalizeForIdentity(neighbor.content) === incomingIdentityKey) {
        identical = neighbor;
      }
      if (similarity >= this.deps.similarityFloor) {
        ambiguous.push({ entry: neighbor, similarity });
      }
      if (this.isConflictNeighbor(similarity, incomingTagSet, neighbor.domain_tags)) {
        sawConflictNeighbor = true;
      }
    }

    return { best, identical, sawConflictNeighbor, ambiguous };
  }

  private isConflictNeighbor(
    similarity: number,
    incomingTagSet: ReadonlySet<string>,
    domainTags: readonly string[]
  ): boolean {
    return (
      similarity < this.deps.similarityFloor &&
      jaccardIndex(incomingTagSet, new Set(domainTags)) >= this.deps.conflictTagOverlapThreshold
    );
  }

  private async decideWithAmbiguousNeighbors(
    input: ReconciliationInput,
    incomingContent: string,
    analysis: NeighborAnalysis
  ): Promise<ReconciliationDecision> {
    analysis.ambiguous.sort((left, right) => right.similarity - left.similarity);
    const candidates = analysis.ambiguous
      .slice(0, this.deps.maxLlmCandidates)
      .map((item) => ({ objectId: item.entry.object_id, content: item.entry.content }));
    return await this.decideWithLlm(
      input,
      incomingContent,
      candidates,
      analysis.best!.similarity
    );
  }

  private async decideWithLlm(input: ReconciliationInput, incomingContent: string, candidates: readonly { readonly objectId: string; readonly content: string }[], bestSimilarity: number): Promise<ReconciliationDecision> {
    let verdict: Awaited<ReturnType<ReconciliationLlmDecisionPort["decide"]>>;
    try {
      verdict = await this.deps.llmDecision.decide({ incomingContent, candidates });
    } catch (error) {
      this.deps.warn("reconciliation LLM decision failed — degrading to ADD", {
        signal_id: input.signalId,
        error: errorMessage(error)
      });
      return addDecision(bestSimilarity, true, "LLM decision unavailable — added with conflict scan");
    }

    const candidateIds = new Set(candidates.map((candidate) => candidate.objectId));
    switch (verdict.kind) {
      case "update":
        return this.buildUpdateDecision(input, verdict, candidateIds, bestSimilarity);
      case "noop":
        return this.buildNoopDecision(input, verdict, candidateIds, bestSimilarity);
      case "add":
        return addDecision(bestSimilarity, false, verdict.reason ?? "LLM judged the fact distinct");
    }
  }

  private buildUpdateDecision(
    input: ReconciliationInput,
    verdict: Awaited<ReturnType<ReconciliationLlmDecisionPort["decide"]>>,
    candidateIds: ReadonlySet<string>,
    bestSimilarity: number
  ): ReconciliationDecision {
    const targetId = verdict.targetObjectId;
    if (!isValidTarget(candidateIds, targetId)) {
      this.warnInvalidTarget(input.signalId, "UPDATE", targetId);
      return addDecision(bestSimilarity, true, "LLM UPDATE target invalid — added with conflict scan");
    }
    return {
      kind: "update",
      survivingObjectId: targetId,
      targetObjectId: targetId,
      runConflictScan: false,
      reason: verdict.reason ?? `LLM judged a refinement of ${targetId}`,
      bestSimilarity
    };
  }

  private buildNoopDecision(
    input: ReconciliationInput,
    verdict: Awaited<ReturnType<ReconciliationLlmDecisionPort["decide"]>>,
    candidateIds: ReadonlySet<string>,
    bestSimilarity: number
  ): ReconciliationDecision {
    const targetId = verdict.targetObjectId;
    if (!isValidTarget(candidateIds, targetId)) {
      this.warnInvalidTarget(input.signalId, "NOOP", targetId);
      return addDecision(bestSimilarity, false, "LLM NOOP target invalid — added");
    }
    return {
      kind: "noop",
      survivingObjectId: targetId,
      targetObjectId: targetId,
      runConflictScan: false,
      reason: verdict.reason ?? `LLM judged a duplicate of ${targetId}`,
      bestSimilarity
    };
  }

  private warnInvalidTarget(
    signalId: string,
    verdictKind: "UPDATE" | "NOOP",
    targetId: string | undefined
  ): void {
    this.deps.warn(
      `reconciliation LLM returned ${verdictKind} without a valid target — degrading to ADD`,
      {
        signal_id: signalId,
        target_object_id: targetId ?? null
      }
    );
  }
}

function buildIdenticalDecision(
  identical: Readonly<MemoryEntry>,
  bestSimilarity: number
): ReconciliationDecision {
  return {
    kind: "noop",
    survivingObjectId: identical.object_id,
    targetObjectId: identical.object_id,
    runConflictScan: false,
    reason: `normalized-string-identical duplicate of ${identical.object_id}`,
    bestSimilarity
  };
}

function isValidTarget(
  candidateIds: ReadonlySet<string>,
  targetId: string | undefined
): targetId is string {
  return targetId !== undefined && candidateIds.has(targetId);
}
