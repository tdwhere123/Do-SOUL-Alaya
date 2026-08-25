import { clamp01 } from "../../shared/clamp.js";
import {
  BankruptcyKind,
  DYNAMICS_CONSTANTS,
  type BudgetSnapshot,
  type ManifestationState,
  type MemoryEntry,
  type ActivationWeights,
  type RecallCandidate,
  type RecallOriginPlane,
  type RecallPolicy
} from "@do-soul/alaya-protocol";
import { CoreError } from "../../shared/errors.js";
import {
  makeTokenEstimator,
  type CoarseRecallCandidate,
  type TokenEstimator
} from "./recall-service-types.js";
export {
  compareEffectiveScores,
  compareMemoryEntries,
  compareMemoryEntriesForActivationAdmission,
  compareMemorySemanticIdentity,
  compareRecallCandidates,
  normalizeActivationScore,
  normalizeDriftSensitiveRankingScore,
  normalizeGraphSupport,
  normalizeQueryText,
  normalizeRecallRankingScore
} from "./recall-service-compare.js";
export {
  classifyGlobalCandidate,
  classifyProjectMappingCandidate,
  isClaimLikeDimension,
  matchesConfiguredCoarseFilter,
  matchesDeterministicFilter,
  matchesPrecomputedRankFilter
} from "./recall-service-classify.js";

// Minimum local recall payload before lower tiers are worth scanning.
export const MIN_RECALL_RESULTS = 5;
// WARM memories are still useful but should rank below equally relevant HOT entries.
export const WARM_CASCADE_DECAY = 0.7;
// COLD memories are cold-start fallback only and receive a stronger freshness penalty.
export const COLD_CASCADE_DECAY = 0.45;
export const BUDGET_PRESSURE_SOFT_THRESHOLD = 0.5;
export const BUDGET_PRESSURE_HARD_THRESHOLD = 1;
/** Additive weight on PathPlasticityState.strength in fine-assessment: a recall supplement (score clamped to [0,1]; base FTS rank still drives ordering on similar plasticity). Sized 0.15 so a full boost cannot close a typical adjacent-rank gap; pinned by a close-tie ordering test. */
export const PATH_PLASTICITY_WEIGHT = 0.15;

export function isEvidenceProjectionIntegrityError(error: unknown): boolean {
  return error instanceof Error && error.name === "EvidenceProjectionIntegrityError";
}

export function buildRecallCandidateDedupeKey(candidate: Readonly<{
  readonly entry: Readonly<{ readonly object_id: string }>;
  readonly originPlane?: RecallOriginPlane;
  readonly objectKind?: RecallCandidate["object_kind"];
}>): string {
  return `${candidate.originPlane ?? "workspace_local"}:${candidate.objectKind ?? "memory_entry"}:${candidate.entry.object_id}`;
}

export function assertUniqueCandidateField(
  candidates: readonly Readonly<{
    readonly entry: Readonly<{ readonly object_id: string }>;
    readonly originPlane?: RecallOriginPlane;
    readonly objectKind?: RecallCandidate["object_kind"];
  }>[]
): void {
  const keys = new Set<string>();
  for (const candidate of candidates) {
    const key = buildRecallCandidateDedupeKey(candidate);
    if (keys.has(key)) {
      throw new Error(`duplicate recall candidate field key: ${key}`);
    }
    keys.add(key);
  }
}

export function buildRecallLogicalObjectKey(candidate: Readonly<{
  readonly entry: Readonly<{
    readonly object_id: string;
    readonly object_kind?: RecallCandidate["object_kind"];
  }>;
  readonly objectKind?: RecallCandidate["object_kind"];
}>): string {
  return `${candidate.objectKind ?? candidate.entry.object_kind ?? "memory_entry"}:${candidate.entry.object_id}`;
}

export function isSynthesisChildCandidate(candidate: Readonly<{
  readonly sourceChannel?: string;
  readonly sourceChannels?: readonly string[];
  readonly admissionPlanes?: readonly string[];
}>): boolean {
  return candidate.sourceChannel === "synthesis_child"
    || candidate.sourceChannels?.includes("synthesis_child") === true
    || candidate.admissionPlanes?.includes("synthesis_child") === true;
}

export function isWorkspaceMemoryCandidate(
  candidate: Readonly<Pick<CoarseRecallCandidate, "originPlane" | "objectKind">>
): boolean {
  return (candidate.originPlane ?? "workspace_local") === "workspace_local" &&
    (candidate.objectKind ?? "memory_entry") === "memory_entry";
}

export function parseEmbeddingPrecheckReason(error: unknown): string | null {
  if (typeof error !== "object" || error === null || !("reason" in error)) {
    return null;
  }

  return typeof error.reason === "string" && error.reason.trim().length > 0
    ? error.reason
    : null;
}

export function mapBudgetPenalty(snapshot: Readonly<BudgetSnapshot>): number {
  switch (snapshot.bankruptcy_kind) {
    case BankruptcyKind.NONE:
      return 0;
    case BankruptcyKind.SOFT:
      return mapSoftBudgetPenalty(readBudgetPressureRatio(snapshot));
    case BankruptcyKind.HARD:
      return 1;
    default:
      return 0;
  }
}

function readBudgetPressureRatio(snapshot: Readonly<BudgetSnapshot>): number {
  return typeof snapshot.pressure_ratio === "number" && Number.isFinite(snapshot.pressure_ratio)
    ? snapshot.pressure_ratio
    : 0;
}

function mapSoftBudgetPenalty(pressureRatio: number): number {
  if (pressureRatio < BUDGET_PRESSURE_SOFT_THRESHOLD) {
    return 0;
  }

  const softRange = BUDGET_PRESSURE_HARD_THRESHOLD - BUDGET_PRESSURE_SOFT_THRESHOLD;
  const normalized = softRange <= 0
    ? 1
    : (clamp01(pressureRatio) - BUDGET_PRESSURE_SOFT_THRESHOLD) / softRange;
  return clamp01(0.1 + 0.6 * normalized);
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

export { clamp01 };

export function estimateTokens(content: string, tokenEstimator: TokenEstimator = makeTokenEstimator()): number {
  return tokenEstimator.estimate(content);
}

export function createContentPreview(
  content: string,
  manifestation?: ManifestationState,
  _originPlane?: RecallOriginPlane
): string {
  // Manifestation gates the full body; workspace_local and global use the same gate (origin_plane discrimination wrongly starved full_eligible workspace_local). see also: DynamicsService.assignInitialDynamics.
  if (manifestation === "full_eligible") {
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
  weights: Readonly<Partial<Record<keyof typeof DYNAMICS_CONSTANTS.activation_weights_phase4b, number>>>
): void {
  const resolved = resolveActivationWeights(weights);
  const sum = Object.values(resolved).reduce((total, weight) => total + weight, 0);

  // Tolerance accepts float-rounded decimal compositions while still catching real weight drift.
  if (Math.abs(sum - 1) >= 1e-6) {
    throw new CoreError("VALIDATION", `activation_weights_phase4b must sum to 1.0, got ${sum}`);
  }
}

export function resolveActivationWeights(
  weights: Readonly<Partial<Record<keyof typeof DYNAMICS_CONSTANTS.activation_weights_phase4b, number>>> = {}
): ActivationWeights {
  return Object.freeze({
    ...DYNAMICS_CONSTANTS.activation_weights_phase4b,
    ...weights
  }) as ActivationWeights;
}

export function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// Error class name (or typeof for non-Error throws); feeds the recall warn meta to flag unexpected failures.
export function errorNameOf(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Optional coarse-filter time-window pre-filter (before ranking). Bounds are ISO datetime; either may be null for open-ended. `field` selects created_at (default) or last_used_at. */
export type RecallTimeFilter = Readonly<{
  readonly since?: string | null;
  readonly until?: string | null;
  readonly field?: "created_at" | "last_used_at";
}>;

/**
 * Single-entry predicate for {@link filterMemoriesByTimeWindow}; the global recall path reuses it per-entry. Undefined/boundless filter passes everything.
 * invariant: lexicographic string comparison is sound only because IsoDatetimeStringSchema is UTC-Z only (offset:false); relaxing that schema requires a parsed comparison here.
 */
export function entryMatchesTimeFilter(
  entry: Readonly<MemoryEntry>,
  filter: RecallTimeFilter | undefined
): boolean {
  if (filter === undefined) {
    return true;
  }

  const since = filter.since ?? null;
  const until = filter.until ?? null;

  if (since === null && until === null) {
    return true;
  }

  const field = filter.field ?? "created_at";
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
}

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

  return entries.filter((entry) => entryMatchesTimeFilter(entry, filter));
}
