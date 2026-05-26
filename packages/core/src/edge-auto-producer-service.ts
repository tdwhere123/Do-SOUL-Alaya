import {
  EdgeProposalTriggerSource,
  MemoryGraphEdgeType,
  type EdgeProposalTriggerSourceValue,
  type MemoryEntry,
  type MemoryGraphEdgeTypeValue
} from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import { parseObjectId } from "./shared/validators.js";

const NEIGHBOR_SEARCH_LIMIT = 12;
const MAX_EDGE_PROPOSALS_PER_MEMORY = 5;
const SUPPORTS_TOKEN_JACCARD_MIN = 0.45;
const DERIVES_TOKEN_JACCARD_MIN = 0.28;
const SUPERSEDES_TOKEN_JACCARD_MIN = 0.5;
const STRONG_TAG_OVERLAP_MIN = 0.5;

const DERIVATION_CUES = [
  "based on",
  "because",
  "therefore",
  "derived from",
  "as a result",
  "follows from",
  "inferred from",
  "基于",
  "因此",
  "所以",
  "由此"
];

const REPLACEMENT_CUES = [
  "instead of",
  "replaces",
  "replace",
  "supersedes",
  "no longer",
  "deprecated",
  "rather than",
  "must not",
  "should not",
  "do not",
  "don't",
  "替代",
  "取代",
  "不再",
  "废弃",
  "改为",
  "改成",
  "不要",
  "禁止"
];

const STOPWORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "be",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "of",
  "on",
  "or",
  "the",
  "this",
  "to",
  "use",
  "uses",
  "with"
]);

export interface EdgeAutoProducerMemorySearchHit {
  readonly object_id: string;
  readonly normalized_rank?: number;
}

export interface EdgeAutoProducerMemoryRepoPort {
  findById(objectId: string): Promise<Readonly<MemoryEntry> | null>;
  searchByKeyword(
    workspaceId: string,
    queryText: string,
    limit: number
  ): Promise<readonly EdgeAutoProducerMemorySearchHit[]>;
  findByIds(objectIds: readonly string[]): Promise<readonly Readonly<MemoryEntry>[]>;
}

export interface EdgeAutoProducerGraphEdgePort {
  createEdge(params: {
    readonly sourceMemoryId: string;
    readonly targetMemoryId: string;
    readonly edgeType: MemoryGraphEdgeTypeValue;
    readonly workspaceId: string;
    readonly runId?: string | null;
    readonly triggerSource?: EdgeProposalTriggerSourceValue;
    readonly confidence?: number;
    readonly reason?: string | null;
    readonly sourceSignalId?: string | null;
  }): Promise<void>;
}

export interface EdgeAutoProducerServiceDependencies {
  readonly memoryRepo: EdgeAutoProducerMemoryRepoPort;
  readonly graphEdgePort: EdgeAutoProducerGraphEdgePort;
}

export interface EdgeAutoProducerInput {
  readonly newMemoryId: string;
  readonly workspaceId: string;
  readonly runId: string;
  readonly sourceSignalId: string;
}

interface EdgeAutoDecision {
  readonly edgeType: MemoryGraphEdgeTypeValue;
  readonly confidence: number;
  readonly reason: string;
  // invariant: trigger_source must be one of the local_* rule-heuristic
  // enum values (or llm_supports once Phase B B-2 lands). Routing back
  // through SYSTEM here would collapse KPI K3.2 per-trigger breakdown.
  readonly triggerSource: EdgeProposalTriggerSourceValue;
}

interface SimilarityFeatures {
  readonly tokenJaccard: number;
  readonly tagOverlap: number;
  readonly strongTagOverlap: boolean;
}

export class EdgeAutoProducerService {
  public constructor(private readonly deps: EdgeAutoProducerServiceDependencies) {}

  public async produceForNewMemory(input: EdgeAutoProducerInput): Promise<void> {
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

    const neighborIds = await this.collectNeighborIds(workspaceId, newMemory);
    if (neighborIds.length === 0) {
      return;
    }
    const neighbors = await this.deps.memoryRepo.findByIds(neighborIds);
    const rankById = new Map(neighborIds.map((objectId, index) => [objectId, index]));
    const orderedNeighbors = [...neighbors].sort(
      (left, right) =>
        (rankById.get(left.object_id) ?? Number.MAX_SAFE_INTEGER) -
        (rankById.get(right.object_id) ?? Number.MAX_SAFE_INTEGER)
    );

    let proposalCount = 0;
    for (const neighbor of orderedNeighbors) {
      if (proposalCount >= MAX_EDGE_PROPOSALS_PER_MEMORY) {
        break;
      }
      const decision = classifyNeighbor(newMemory, neighbor);
      if (decision === null) {
        continue;
      }
      await this.deps.graphEdgePort.createEdge({
        sourceMemoryId: newMemory.object_id,
        targetMemoryId: neighbor.object_id,
        edgeType: decision.edgeType,
        workspaceId,
        runId: input.runId,
        triggerSource: decision.triggerSource,
        confidence: decision.confidence,
        reason: decision.reason,
        sourceSignalId: input.sourceSignalId
      });
      proposalCount += 1;
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
}

function classifyNeighbor(
  newMemory: Readonly<MemoryEntry>,
  neighbor: Readonly<MemoryEntry>
): EdgeAutoDecision | null {
  if (!isEligibleNeighbor(newMemory, neighbor)) {
    return null;
  }
  const features = computeSimilarity(newMemory, neighbor);
  if (!features.strongTagOverlap) {
    return null;
  }
  if (isSupersedesCandidate(newMemory, neighbor, features)) {
    return {
      edgeType: MemoryGraphEdgeType.SUPERSEDES,
      confidence: confidence(0.55, features, 0.05, 0.85),
      reason: describeDecision("B-3 local supersedes heuristic", features),
      triggerSource: EdgeProposalTriggerSource.LOCAL_SUPERSEDES
    };
  }
  if (isDerivesFromCandidate(newMemory, features)) {
    return {
      edgeType: MemoryGraphEdgeType.DERIVES_FROM,
      confidence: confidence(0.55, features, 0, 0.8),
      reason: describeDecision("B-2 local derives_from heuristic", features),
      triggerSource: EdgeProposalTriggerSource.LOCAL_DERIVES_FROM
    };
  }
  if (features.tokenJaccard >= SUPPORTS_TOKEN_JACCARD_MIN) {
    return {
      edgeType: MemoryGraphEdgeType.SUPPORTS,
      confidence: confidence(0.55, features, 0, 0.8),
      reason: describeDecision("B-2 local supports heuristic", features),
      triggerSource: EdgeProposalTriggerSource.LOCAL_SUPPORTS
    };
  }
  return null;
}

function isEligibleNeighbor(newMemory: Readonly<MemoryEntry>, neighbor: Readonly<MemoryEntry>): boolean {
  return (
    neighbor.object_id !== newMemory.object_id &&
    neighbor.lifecycle_state === "active" &&
    neighbor.workspace_id === newMemory.workspace_id &&
    neighbor.dimension === newMemory.dimension &&
    neighbor.scope_class === newMemory.scope_class
  );
}

function isSupersedesCandidate(
  newMemory: Readonly<MemoryEntry>,
  neighbor: Readonly<MemoryEntry>,
  features: SimilarityFeatures
): boolean {
  return (
    newMemory.created_at > neighbor.created_at &&
    features.tokenJaccard >= SUPERSEDES_TOKEN_JACCARD_MIN &&
    hasAnyCue(newMemory.content, REPLACEMENT_CUES)
  );
}

function isDerivesFromCandidate(
  newMemory: Readonly<MemoryEntry>,
  features: SimilarityFeatures
): boolean {
  return (
    features.tokenJaccard >= DERIVES_TOKEN_JACCARD_MIN &&
    (newMemory.formation_kind === "derived" || hasAnyCue(newMemory.content, DERIVATION_CUES))
  );
}

function computeSimilarity(
  newMemory: Readonly<MemoryEntry>,
  neighbor: Readonly<MemoryEntry>
): SimilarityFeatures {
  const tokenJaccard = jaccard(tokenize(newMemory.content), tokenize(neighbor.content));
  const tagOverlap = overlapRatio(normalizeLabels(newMemory.domain_tags), normalizeLabels(neighbor.domain_tags));
  return {
    tokenJaccard,
    tagOverlap,
    strongTagOverlap: tagOverlap >= STRONG_TAG_OVERLAP_MIN
  };
}

function tokenize(content: string): readonly string[] {
  return Array.from(
    new Set(
      content
        .normalize("NFKC")
        .toLowerCase()
        .match(/[\p{L}\p{N}_-]+/gu)
        ?.filter((token) => token.length > 1 && !STOPWORDS.has(token)) ?? []
    )
  );
}

function normalizeLabels(labels: readonly string[]): readonly string[] {
  return Array.from(new Set(labels.map((label) => label.normalize("NFKC").toLowerCase().trim()).filter(Boolean)));
}

function jaccard(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  const intersection = left.filter((token) => rightSet.has(token)).length;
  const union = new Set([...left, ...right]).size;
  return union === 0 ? 0 : intersection / union;
}

function overlapRatio(left: readonly string[], right: readonly string[]): number {
  if (left.length === 0 || right.length === 0) {
    return 0;
  }
  const rightSet = new Set(right);
  const intersection = left.filter((tag) => rightSet.has(tag)).length;
  return intersection / Math.min(left.length, right.length);
}

function hasAnyCue(content: string, cues: readonly string[]): boolean {
  const normalized = content.normalize("NFKC").toLowerCase();
  return cues.some((cue) => normalized.includes(cue));
}

function confidence(
  base: number,
  features: SimilarityFeatures,
  bonus: number,
  max: number
): number {
  const value = base + features.tokenJaccard * 0.2 + features.tagOverlap * 0.1 + bonus;
  return round2(Math.min(max, Math.max(0.55, value)));
}

function describeDecision(label: string, features: SimilarityFeatures): string {
  return `${label}: token_jaccard=${round2(features.tokenJaccard)}, tag_overlap=${round2(features.tagOverlap)}`;
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}
