import {
  addDecision,
  jaccardIndex,
  normalizeForIdentity,
  tokenize,
  type MemoryEntry,
  type ReconciliationDecision,
  type ReconciliationInput,
  type ReconciliationServiceMethodOwner
} from "./reconciliation-service-internal.js";
import { reconciliationServiceDecideWithLlm } from "./reconciliation-service-methods-4.js";
import { reconciliationServiceRetrieveNeighbors } from "./reconciliation-service-methods-5.js";

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

export async function reconciliationServiceDecide(owner: ReconciliationServiceMethodOwner, input: ReconciliationInput): Promise<ReconciliationDecision> {
    const incomingContent = input.incomingContent.trim();
    if (incomingContent.length === 0) {
      return addDecision(0, false, "empty incoming content — no reconciliation");
    }

    const neighbors = await reconciliationServiceRetrieveNeighbors(owner, input.workspaceId, incomingContent);
    if (neighbors.length === 0) {
      return addDecision(0, false, "no lexically-similar existing memory");
    }

    const analysis = analyzeNeighbors(owner, input, incomingContent, neighbors);

    if (analysis.best === null) {
      return addDecision(0, analysis.sawConflictNeighbor, "no comparable neighbor content");
    }

    // Band 3: a normalized-string-identical neighbor carries no new
    // information — NOOP with zero LLM. Jaccard is deliberately not the
    // gate here (see the loop comment above).
    if (analysis.identical !== null) {
      return buildIdenticalDecision(analysis.identical, analysis.best.similarity);
    }

    // Band 2: any non-identical neighbor at or above the floor — the LLM
    // is the semantic judge of refines vs distinct. An LLM failure
    // degrades to ADD (never lose a fact) and flags the conflict scan so
    // the divergence is still resolved by ConflictDetectionService.
    if (analysis.ambiguous.length > 0) {
      return await decideWithAmbiguousNeighbors(owner, input, incomingContent, analysis);
    }

    // Band 1: nothing close enough — ADD, zero LLM.
    return addDecision(
      analysis.best.similarity,
      analysis.sawConflictNeighbor,
      analysis.sawConflictNeighbor
        ? "distinct fact with a same-topic divergent neighbor"
        : "distinct fact"
    );
  }

function analyzeNeighbors(
  owner: ReconciliationServiceMethodOwner,
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
    if (similarity >= owner.similarityFloor) {
      ambiguous.push({ entry: neighbor, similarity });
    }
    if (isConflictNeighbor(owner, similarity, incomingTagSet, neighbor.domain_tags)) {
      sawConflictNeighbor = true;
    }
  }

  return { best, identical, sawConflictNeighbor, ambiguous };
}

function isConflictNeighbor(
  owner: ReconciliationServiceMethodOwner,
  similarity: number,
  incomingTagSet: ReadonlySet<string>,
  domainTags: readonly string[]
): boolean {
  return (
    similarity < owner.similarityFloor &&
    jaccardIndex(incomingTagSet, new Set(domainTags)) >= owner.conflictTagOverlapThreshold
  );
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

async function decideWithAmbiguousNeighbors(
  owner: ReconciliationServiceMethodOwner,
  input: ReconciliationInput,
  incomingContent: string,
  analysis: NeighborAnalysis
): Promise<ReconciliationDecision> {
  analysis.ambiguous.sort((left, right) => right.similarity - left.similarity);
  const candidates = analysis.ambiguous
    .slice(0, owner.maxLlmCandidates)
    .map((item) => ({ objectId: item.entry.object_id, content: item.entry.content }));
  return await reconciliationServiceDecideWithLlm(
    owner,
    input,
    incomingContent,
    candidates,
    analysis.best!.similarity
  );
}
