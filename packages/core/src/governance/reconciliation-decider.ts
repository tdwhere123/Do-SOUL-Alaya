import {
  addDecision,
  errorMessage,
  jaccardIndex,
  normalizeForIdentity,
  tokenize,
  type MemoryEntry,
  type ReconciliationDecision,
  type ReconciliationInput,
  type ReconciliationLlmDecisionPort
} from "./reconciliation-service-internal.js";
import type {
  PreWriteCandidateNeighbor,
  PreWriteCandidateFamily,
  PreWriteRecallPort
} from "./pre-write-recall-service.js";

const LLM_CANDIDATE_FAMILY_ORDER: readonly PreWriteCandidateFamily[] = [
  "typed_slot",
  "canonical_entity",
  "temporal",
  "lexical",
  "domain_tag"
];

interface NeighborCandidate {
  readonly neighbor: PreWriteCandidateNeighbor;
  readonly similarity: number;
}

interface NeighborAnalysis {
  readonly best: NeighborCandidate | null;
  readonly identical: Readonly<MemoryEntry> | null;
  readonly sawConflictNeighbor: boolean;
  readonly ambiguous: NeighborCandidate[];
}

export interface ReconciliationDeciderDependencies {
  readonly preWriteRecall: PreWriteRecallPort;
  readonly llmDecision: ReconciliationLlmDecisionPort;
  readonly similarityFloor: number;
  readonly conflictTagOverlapThreshold: number;
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

    const recall = await this.retrievePreWriteRecall(input);
    if (recall.candidates.length === 0) {
      return addDecision(0, false, "pre-write recall found no related existing memory");
    }

    const analysis = this.analyzeNeighbors(input, incomingContent, recall.candidates);

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

  private async retrievePreWriteRecall(input: ReconciliationInput): Promise<Awaited<ReturnType<PreWriteRecallPort["recall"]>>> {
    try {
      return await this.deps.preWriteRecall.recall(input);
    } catch (error) {
      this.deps.warn("pre-write recall failed", {
        workspace_id: input.workspaceId,
        signal_id: input.signalId,
        error: errorMessage(error)
      });
      return { candidates: [], uncertainty: 1, auditFeatures: { failed: true } };
    }
  }

  private analyzeNeighbors(
    input: ReconciliationInput,
    incomingContent: string,
    neighbors: readonly PreWriteCandidateNeighbor[]
  ): NeighborAnalysis {
    const incomingTokens = tokenize(incomingContent);
    const incomingTagSet = new Set(input.incomingDomainTags);
    const incomingIdentityKey = normalizeForIdentity(incomingContent);
    let best: NeighborCandidate | null = null;
    let identical: Readonly<MemoryEntry> | null = null;
    let sawConflictNeighbor = false;
    const ambiguous: NeighborCandidate[] = [];

    for (const neighbor of neighbors) {
      const lexicalSimilarity = jaccardIndex(incomingTokens, tokenize(neighbor.entry.content));
      const similarity = Math.max(lexicalSimilarity, neighbor.structuralScore);
      best = best === null || similarity > best.similarity ? { neighbor, similarity } : best;
      if (identical === null && normalizeForIdentity(neighbor.entry.content) === incomingIdentityKey) {
        identical = neighbor.entry;
      }
      if (similarity >= this.deps.similarityFloor) {
        ambiguous.push({ neighbor, similarity });
      }
      if (this.isConflictNeighbor(lexicalSimilarity, incomingTagSet, neighbor.entry.domain_tags, neighbor)) {
        sawConflictNeighbor = true;
      }
    }

    return { best, identical, sawConflictNeighbor, ambiguous };
  }

  private isConflictNeighbor(
    similarity: number,
    incomingTagSet: ReadonlySet<string>,
    domainTags: readonly string[],
    neighbor: PreWriteCandidateNeighbor
  ): boolean {
    return (
      (similarity < this.deps.similarityFloor &&
        jaccardIndex(incomingTagSet, new Set(domainTags)) >= this.deps.conflictTagOverlapThreshold) ||
      neighbor.relationPosteriors.some(
        (posterior) => posterior.relation === "contradicts" && posterior.probability >= 0.4
      )
    );
  }

  private async decideWithAmbiguousNeighbors(
    input: ReconciliationInput,
    incomingContent: string,
    analysis: NeighborAnalysis
  ): Promise<ReconciliationDecision> {
    analysis.ambiguous.sort(
      (left, right) =>
        right.similarity - left.similarity ||
        right.neighbor.lexicalScore - left.neighbor.lexicalScore ||
        right.neighbor.families.length - left.neighbor.families.length
    );
    const candidates = selectLlmCandidates(analysis.ambiguous, this.deps.maxLlmCandidates)
      .map((item) => ({ objectId: item.neighbor.entry.object_id, content: item.neighbor.entry.content }));
    return await this.decideWithLlm(
      input,
      incomingContent,
      candidates,
      analysis.best!.similarity,
      analysis.sawConflictNeighbor
    );
  }

  private async decideWithLlm(
    input: ReconciliationInput,
    incomingContent: string,
    candidates: readonly { readonly objectId: string; readonly content: string }[],
    bestSimilarity: number,
    runConflictScanOnAdd: boolean
  ): Promise<ReconciliationDecision> {
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
        return addDecision(
          bestSimilarity,
          runConflictScanOnAdd,
          verdict.reason ?? "LLM judged the fact distinct"
        );
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

function selectLlmCandidates(
  ambiguous: readonly NeighborCandidate[],
  maxCandidates: number
): readonly NeighborCandidate[] {
  const limit = Math.max(0, maxCandidates);
  if (limit === 0) {
    return [];
  }
  const selected = new Map<string, NeighborCandidate>();
  for (const family of LLM_CANDIDATE_FAMILY_ORDER) {
    const match = ambiguous.find((item) => item.neighbor.families.includes(family));
    if (match !== undefined) {
      selected.set(match.neighbor.entry.object_id, match);
    }
    if (selected.size >= limit) {
      return [...selected.values()];
    }
  }
  for (const item of ambiguous) {
    selected.set(item.neighbor.entry.object_id, item);
    if (selected.size >= limit) {
      break;
    }
  }
  return [...selected.values()];
}

function isValidTarget(
  candidateIds: ReadonlySet<string>,
  targetId: string | undefined
): targetId is string {
  return targetId !== undefined && candidateIds.has(targetId);
}
