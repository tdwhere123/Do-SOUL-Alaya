import {
  EdgeProposalTriggerSource,
  MemoryGraphEdgeType,
  type EdgeProposalTriggerSourceValue,
  type MemoryEntry,
  type MemoryGraphEdgeTypeValue
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
import { CoreError } from "./errors.js";
import { parseObjectId } from "./shared/validators.js";

const NEIGHBOR_SEARCH_LIMIT = 12;
const MAX_EDGE_PROPOSALS_PER_MEMORY = 5;
const SUPPORTS_TOKEN_JACCARD_MIN = 0.45;
const DERIVES_TOKEN_JACCARD_MIN = 0.28;
const SUPERSEDES_TOKEN_JACCARD_MIN = 0.5;
const STRONG_TAG_OVERLAP_MIN = 0.5;
// invariant: LLM pair-classifier verdicts MUST clear this confidence
// floor to enter the proposal queue. A below-floor verdict is dropped
// (the service then falls back to the local heuristic for that
// neighbor) so a noisy garden response cannot inject low-quality
// supports/derives_from proposals into the queue.
const LLM_CONFIDENCE_FLOOR = 0.85;
// invariant: LLM-pregate floor. A pair below this token-Jaccard +
// tag-overlap threshold cannot meaningfully clear DERIVES_TOKEN_JACCARD_MIN
// (0.28) for the local heuristic either, so we skip the garden round-trip
// and fall straight back to the (likely-null) local classifier. The
// threshold is intentionally below the heuristic's DERIVES floor (the
// loosest of the three classifier paths) so the LLM still gets to see
// the "borderline" pair-space where its judgement matters most. A pair
// with zero token overlap AND zero tag overlap is the obvious-non-pair
// the pregate is meant to drop.
const LLM_PREGATE_TOKEN_JACCARD_MIN = 0.2;

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

// invariant: edge auto-producer sink is the governed path candidate
// intake (PathCandidateSink), not memory_graph_edges. A supports/
// derives_from candidate is born a weak attention_only path (recall_bias
// +) that earns recall eligibility only through PathPlasticityService
// reinforcement; it is never auto-accepted into a permanent edge.
// see also: path-candidate-sink.ts PathCandidateSink — the shared port.
export interface EdgeAutoProducerServiceDependencies {
  readonly memoryRepo: EdgeAutoProducerMemoryRepoPort;
  readonly pathCandidatePort: PathCandidateSink;
  /**
   * Optional pair classifier port. When present the service asks the
   * port for a supports / derives_from verdict before running the
   * local heuristic; a verdict >= LLM_CONFIDENCE_FLOOR is emitted with
   * trigger_source = "llm_supports". A null / failing / below-floor
   * verdict triggers the local-heuristic fallback for that neighbor.
   * Adapter failures are observable via the optional warn callback;
   * they never abort proposal production for the new memory.
   */
  readonly llmPort?: EdgeAutoProducerLlmPort;
  readonly warn?: (message: string, meta: Record<string, unknown>) => void;
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
  // enum values, or llm_supports for LLM-port verdicts. Routing back
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
      const decision = await this.decideForNeighbor(newMemory, neighbor);
      if (decision === null) {
        continue;
      }
      const profile = seedProfileForEdgeType(decision.edgeType);
      await this.deps.pathCandidatePort.submitCandidate({
        workspaceId,
        sourceAnchor: { kind: "object", object_id: newMemory.object_id },
        targetAnchor: { kind: "object", object_id: neighbor.object_id },
        relationKind: profile.relationKind,
        initialStrength: profile.initialStrength,
        governanceClass: profile.governanceClass,
        evidenceBasis: profile.evidenceBasis,
        recallBiasSign: profile.recallBiasSign,
        recallBiasMagnitude: profile.recallBiasMagnitude,
        why: [
          `${decision.triggerSource}: ${decision.reason}`,
          `source_signal=${input.sourceSignalId} run=${input.runId}`
        ]
      });
      proposalCount += 1;
    }
  }

  /**
   * LLM port runs first for the supports / derives_from universe. A
   * null / failing / below-floor verdict falls back to the deterministic
   * local heuristic, so a degraded garden never blocks proposal
   * generation. The eligibility prefilter (same workspace, dimension,
   * scope, lifecycle=active) is shared with the heuristic to spare the
   * LLM obvious non-pairs. A second, content-similarity pregate
   * (token-Jaccard + tag-overlap) runs before the LLM call so a fan-out
   * of 12 structurally-eligible-but-unrelated neighbors does not fire
   * 12 garden round-trips per new memory.
   * see also: passesLlmPregate, LLM_PREGATE_TOKEN_JACCARD_MIN.
   */
  private async decideForNeighbor(
    newMemory: Readonly<MemoryEntry>,
    neighbor: Readonly<MemoryEntry>
  ): Promise<EdgeAutoDecision | null> {
    if (!isEligibleNeighbor(newMemory, neighbor)) {
      return null;
    }
    if (this.deps.llmPort !== undefined && passesLlmPregate(newMemory, neighbor)) {
      const llmDecision = await this.tryLlmDecision(newMemory, neighbor);
      if (llmDecision !== null) {
        return llmDecision;
      }
    }
    return classifyNeighbor(newMemory, neighbor);
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
      // Adapter failure must not block proposal production for the new
      // memory; the local heuristic still runs for this neighbor and the
      // operator gets a single observable event.
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
      // invariant: trigger_source = llm_supports for BOTH supports and
      // derives_from when sourced from the LLM port. Reuses a single
      // per-trigger KPI bucket for the pair classifier so K3.2 does not
      // need two LLM rows.
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

// invariant: a local heuristic / LLM supersedes verdict is a weak claim,
// not a system-derived conflict ruling. It seeds attention_only at a low
// strength (recall_bias - kept so plasticity classifies it as a negative
// lifecycle path) and must earn recall eligibility through
// PathPlasticityService reinforcement — it never mints a recall_allowed
// negative path. This deliberately diverges from the shared
// SUPERSEDES_SEED_PROFILE (recall_allowed/0.9), which is reserved for
// SYSTEM-derived negatives produced by ConflictDetectionService.
// see also: packages/core/src/conflict-detection-service.ts — SYSTEM negatives.
const LOCAL_SUPERSEDES_SEED_PROFILE: PathSeedProfile = Object.freeze({
  relationKind: "supersedes",
  initialStrength: 0.5,
  governanceClass: "attention_only",
  recallBiasSign: -1,
  recallBiasMagnitude: 0.5,
  evidenceBasis: Object.freeze(["supersession_evidence"]) as readonly string[]
});

// invariant: maps the producer's edge-type verdict to the path seed
// profile that carries its initial strength / governance / recall_bias
// sign. supports + derives_from are positive associative profiles; the
// local supersedes heuristic is a weak negative lifecycle profile
// (recall_bias -, attention_only). The producer never mints exception_to.
function seedProfileForEdgeType(edgeType: MemoryGraphEdgeTypeValue): PathSeedProfile {
  switch (edgeType) {
    case MemoryGraphEdgeType.DERIVES_FROM:
      return DERIVES_FROM_SEED_PROFILE;
    case MemoryGraphEdgeType.SUPERSEDES:
      return LOCAL_SUPERSEDES_SEED_PROFILE;
    case MemoryGraphEdgeType.SUPPORTS:
    default:
      return SUPPORTS_SEED_PROFILE;
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

/**
 * LLM cost pregate. A pair must clear EITHER a small token-Jaccard
 * floor OR a non-empty tag-overlap signal before the LLM port is
 * consulted. The intent is to drop the "structurally eligible but
 * obviously unrelated" pairs (same workspace + dimension + scope but
 * zero shared lexical content) that would otherwise fan out to
 * NEIGHBOR_SEARCH_LIMIT garden calls per new memory under a full bench.
 *
 * The token-Jaccard floor (0.2) is intentionally below the local
 * heuristic's DERIVES_TOKEN_JACCARD_MIN (0.28) so the LLM still gets
 * the borderline pair-space where its judgement is most valuable;
 * pairs the heuristic could already classify deterministically are not
 * locked out, they just route through the LLM first as today.
 */
function passesLlmPregate(
  newMemory: Readonly<MemoryEntry>,
  neighbor: Readonly<MemoryEntry>
): boolean {
  const features = computeSimilarity(newMemory, neighbor);
  return features.tokenJaccard >= LLM_PREGATE_TOKEN_JACCARD_MIN || features.tagOverlap > 0;
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

function clamp01(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value < 0) {
    return 0;
  }
  if (value > 1) {
    return 1;
  }
  return value;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
