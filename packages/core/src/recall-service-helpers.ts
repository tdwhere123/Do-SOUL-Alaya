import {
  BankruptcyKind,
  DYNAMICS_CONSTANTS,
  MemoryDimension,
  ProjectMappingState,
  RecallCandidateSchema,
  ScopeClass,
  type BudgetSnapshot,
  type FineAssessmentConfig,
  type ManifestationState,
  type MemoryDimension as MemoryDimensionType,
  type MemoryEntry,
  type ProjectMappingAnchor,
  type RecallCandidate,
  type RecallOriginPlane,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { CoreError } from "./errors.js";
import type { CoarseRecallCandidate, RecallServiceProjectMappingPort } from "./recall-service-types.js";

const CLAIM_LIKE_DIMENSIONS = new Set<MemoryDimensionType>([
  MemoryDimension.CONSTRAINT,
  MemoryDimension.PREFERENCE,
  MemoryDimension.PROCEDURE
]);
// Minimum local recall payload before lower tiers are worth scanning.
export const MIN_RECALL_RESULTS = 5;
// WARM memories are still useful but should rank below equally relevant HOT entries.
export const WARM_CASCADE_DECAY = 0.7;
// COLD memories are cold-start fallback only and receive a stronger freshness penalty.
export const COLD_CASCADE_DECAY = 0.45;
export const EMBEDDING_SIMILARITY_WEIGHT = 0.8;
/**
 * Additive weight applied to PathPlasticityState.strength inside the
 * fine-assessment score. Plasticity is a recall *supplement*: it can boost a
 * memory's relevance, but the overall score is still clamped to [0, 1] and
 * the base lexical/FTS rank still drives ordering when two candidates have
 * similar plasticity. Mirrors the "embedding is supplement, never oracle"
 * pattern.
 *
 * Sized at 0.15 so a fully-plastic boost (1.0 * 0.15 = 0.15) cannot close a
 * typical adjacent-rank gap from base activation: e.g. 0.55 vs 0.50 yields
 * baseline contributions of ~0.55*0.7=0.385 vs 0.50*0.7=0.35 — a 0.035 gap
 * that a 0.15 boost on the lower side could overcome only by a wide margin.
 * The locking test (`recall-service.test.ts: respects close-tie ordering
 * when only plasticity differs`) pins this property.
 */
export const PATH_PLASTICITY_WEIGHT = 0.15;


export function buildRecallCandidateDedupeKey(candidate: Readonly<CoarseRecallCandidate>): string {
  return `${candidate.originPlane ?? "workspace_local"}:${candidate.entry.object_id}`;
}

export function parseEmbeddingPrecheckReason(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("reason" in error)) {
    return null;
  }

  return typeof error.reason === "string" && error.reason.trim().length > 0
    ? error.reason
    : null;
}

export function compareMemoryEntries(left: Readonly<MemoryEntry>, right: Readonly<MemoryEntry>): number {
  const activationDelta = normalizeActivationScore(right.activation_score) - normalizeActivationScore(left.activation_score);

  if (activationDelta !== 0) {
    return activationDelta;
  }

  const createdAtComparison = left.created_at.localeCompare(right.created_at);
  if (createdAtComparison !== 0) {
    return createdAtComparison;
  }

  return left.object_id.localeCompare(right.object_id);
}

export function compareEffectiveScores(
  left: Readonly<CoarseRecallCandidate & { effectiveScore: number }>,
  right: Readonly<CoarseRecallCandidate & { effectiveScore: number }>
): number {
  const scoreDelta = left.effectiveScore - right.effectiveScore;

  if (scoreDelta !== 0) {
    return scoreDelta;
  }

  return compareMemoryEntries(right.entry, left.entry);
}

export function compareRecallCandidates(
  left: Readonly<RecallCandidate>,
  right: Readonly<RecallCandidate>
): number {
  const relevanceDelta = right.relevance_score - left.relevance_score;
  if (relevanceDelta !== 0) {
    return relevanceDelta;
  }

  const activationDelta = right.activation_score - left.activation_score;
  if (activationDelta !== 0) {
    return activationDelta;
  }

  return left.object_id.localeCompare(right.object_id);
}

export function applySimilarityBoost(
  candidate: Readonly<RecallCandidate>,
  similarityHint: Readonly<{
    readonly normalized_similarity: number;
  }> | undefined
): Readonly<RecallCandidate> {
  if (similarityHint === undefined) {
    return candidate;
  }

  const normalizedSimilarity = clamp01(similarityHint.normalized_similarity);
  const relevanceScore = clamp01(
    candidate.relevance_score +
      normalizedSimilarity * EMBEDDING_SIMILARITY_WEIGHT
  );
  const previousFactors = candidate.score_factors ?? {
    activation: candidate.activation_score,
    relevance: candidate.relevance_score
  };
  const sourceChannels = new Set(candidate.source_channels ?? [
    "ranked_recall",
    candidate.origin_plane
  ]);
  sourceChannels.add("semantic_supplement");

  return RecallCandidateSchema.parse({
    ...candidate,
    relevance_score: relevanceScore,
    score_factors: {
      ...previousFactors,
      relevance: relevanceScore,
      embedding_similarity: normalizedSimilarity
    },
    source_channels: [...sourceChannels],
    selection_reason:
      candidate.selection_reason === undefined
        ? undefined
        : `${candidate.selection_reason.replace(/\.$/, "")}; embedding similarity ${normalizedSimilarity.toFixed(3)}.`
  });
}

export function normalizeActivationScore(value: number | null): number {
  return value ?? 0;
}

export function normalizeGraphSupport(count: number): number {
  return Math.min(Math.max(count, 0), 3) / 3;
}

export function normalizeQueryText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}

export function mapBudgetPenalty(snapshot: Readonly<BudgetSnapshot>): number {
  switch (snapshot.bankruptcy_kind) {
    case BankruptcyKind.NONE:
      return 0;
    case BankruptcyKind.SOFT:
      return 0.3;
    case BankruptcyKind.HARD:
      return 1;
    default:
      return 0;
  }
}

export function getGlobalRecallLimit(policy: Readonly<RecallPolicy>): number {
  const semanticSupplementLimit = policy.coarse_filter.semantic_supplement.enabled
    ? policy.coarse_filter.semantic_supplement.max_supplement
    : 0;

  return Math.max(
    1,
    policy.coarse_filter.precomputed_rank.max_candidates,
    policy.fine_assessment.budgets.max_entries,
    semanticSupplementLimit
  );
}

export function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

export function isProtectedDimension(value: MemoryDimensionType): boolean {
  return value === MemoryDimension.CONSTRAINT || value === MemoryDimension.HAZARD;
}

export function isClaimLikeDimension(value: MemoryDimensionType): boolean {
  return CLAIM_LIKE_DIMENSIONS.has(value);
}

export function classifyGlobalCandidate(
  entry: { readonly global_object_id: string },
  anchorMap: ReadonlyMap<string, Readonly<ProjectMappingAnchor>>
): Readonly<{
  include: boolean;
  reason: "adopted" | "no_anchor" | `not_adopted:${ProjectMappingState}`;
  anchor_state: ProjectMappingState | null;
}> {
  const anchor = anchorMap.get(entry.global_object_id);

  if (anchor === undefined) {
    return Object.freeze({
      include: false,
      reason: "no_anchor",
      anchor_state: null
    });
  }

  if (
    anchor.mapping_state === ProjectMappingState.ACCEPTED ||
    anchor.mapping_state === ProjectMappingState.ADAPTED
  ) {
    return Object.freeze({
      include: true,
      reason: "adopted",
      anchor_state: anchor.mapping_state
    });
  }

  return Object.freeze({
    include: false,
    reason: `not_adopted:${anchor.mapping_state}`,
    anchor_state: anchor.mapping_state
  });
}

export function classifyProjectMappingCandidate(
  entry: Readonly<MemoryEntry>,
  anchorMap: ReadonlyMap<string, Readonly<ProjectMappingAnchor>>,
  projectMappingPort: RecallServiceProjectMappingPort | undefined
): Readonly<{ include: boolean; isAdvisory?: boolean }> {
  if (projectMappingPort === undefined || entry.scope_class === ScopeClass.PROJECT) {
    return Object.freeze({ include: true });
  }

  const anchor = anchorMap.get(entry.object_id);

  if (anchor === undefined) {
    return Object.freeze({ include: true, isAdvisory: true });
  }

  if (
    anchor.mapping_state === ProjectMappingState.REJECTED ||
    anchor.mapping_state === ProjectMappingState.NOT_APPLICABLE
  ) {
    return Object.freeze({ include: false });
  }

  if (
    anchor.mapping_state === ProjectMappingState.ACCEPTED ||
    anchor.mapping_state === ProjectMappingState.ADAPTED
  ) {
    return Object.freeze({ include: true, isAdvisory: false });
  }

  return Object.freeze({ include: true, isAdvisory: true });
}

function hasTagOverlap(source: readonly string[], filter: readonly string[]): boolean {
  const filterSet = new Set(filter);
  return source.some((tag) => filterSet.has(tag));
}

export function matchesConfiguredCoarseFilter(
  entry: Readonly<MemoryEntry>,
  config: Readonly<RecallPolicy>["coarse_filter"]
): boolean {
  if (isProtectedDimension(entry.dimension)) {
    return true;
  }

  return matchesDeterministicFilter(entry, config) && matchesPrecomputedRankFilter(entry, config);
}

export function matchesDeterministicFilter(
  entry: Readonly<MemoryEntry>,
  config: Readonly<RecallPolicy>["coarse_filter"]
): boolean {
  const scopePass =
    config.deterministic_match.scope_filter === null ||
    config.deterministic_match.scope_filter.includes(entry.scope_class);
  const dimensionPass =
    config.deterministic_match.dimension_filter === null ||
    config.deterministic_match.dimension_filter.includes(entry.dimension);
  const domainPass =
    config.deterministic_match.domain_tag_filter === null ||
    hasTagOverlap(entry.domain_tags, config.deterministic_match.domain_tag_filter);

  return scopePass && dimensionPass && domainPass;
}

export function matchesPrecomputedRankFilter(
  entry: Readonly<MemoryEntry>,
  config: Readonly<RecallPolicy>["coarse_filter"]
): boolean {
  return (
    config.precomputed_rank.min_activation_score === null ||
    normalizeActivationScore(entry.activation_score) >= config.precomputed_rank.min_activation_score
  );
}

export function estimateTokens(content: string): number {
  return Math.ceil(content.length / 4);
}

export function createContentPreview(
  content: string,
  manifestation?: ManifestationState,
  originPlane?: RecallOriginPlane
): string {
  if (originPlane === "global" && manifestation === "full_eligible") {
    return content;
  }

  if (content.length <= 160) {
    return content;
  }

  return `${content.slice(0, 157)}...`;
}

export function assignManifestation(activationScore: number): ManifestationState {
  if (activationScore < DYNAMICS_CONSTANTS.manifestation_thresholds.hidden_max) {
    return "hidden";
  }

  if (activationScore < DYNAMICS_CONSTANTS.manifestation_thresholds.hint_max) {
    return "hint";
  }

  if (activationScore < DYNAMICS_CONSTANTS.manifestation_thresholds.excerpt_max) {
    return "excerpt";
  }

  return "full_eligible";
}

export function assertActivationWeightsSumToOne(
  weights: Readonly<Record<keyof typeof DYNAMICS_CONSTANTS.activation_weights_phase4b, number>>
): void {
  const sum = Object.values(weights).reduce((total, weight) => total + weight, 0);

  if (Math.abs(sum - 1) > Number.EPSILON) {
    throw new CoreError("VALIDATION", `activation_weights_phase4b must sum to 1.0, got ${sum}`);
  }
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Optional time-window pre-filter applied during recall coarse-filter, before
 * ranking. Lets agents answer queries like "what did I say on May 20" without
 * touching the score function. Both bounds are ISO datetime strings; either
 * may be null/undefined for an open-ended bound. `field` selects whether the
 * window applies to entry creation time or last-used time (defaults to
 * created_at when omitted).
 */
export type RecallTimeFilter = Readonly<{
  readonly since?: string | null;
  readonly until?: string | null;
  readonly field?: "created_at" | "last_used_at";
}>;

export function filterMemoriesByTimeWindow(
  entries: readonly Readonly<MemoryEntry>[],
  filter: RecallTimeFilter | undefined
): readonly Readonly<MemoryEntry>[] {
  if (filter === undefined) {
    return entries;
  }

  const since = filter.since ?? null;
  const until = filter.until ?? null;

  if (since === null && until === null) {
    return entries;
  }

  const field = filter.field ?? "created_at";

  return entries.filter((entry) => {
    const stamp = field === "last_used_at" ? entry.last_used_at : entry.created_at;

    if (stamp === null || stamp === undefined) {
      return false;
    }

    if (since !== null && stamp < since) {
      return false;
    }

    if (until !== null && stamp > until) {
      return false;
    }

    return true;
  });
}
