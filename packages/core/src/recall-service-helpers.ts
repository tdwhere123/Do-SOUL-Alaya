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
export const EMBEDDING_SIMILARITY_WEIGHT = 0.8;


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

  return RecallCandidateSchema.parse({
    ...candidate,
    relevance_score: clamp01(
      candidate.relevance_score +
        clamp01(similarityHint.normalized_similarity) * EMBEDDING_SIMILARITY_WEIGHT
    )
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
