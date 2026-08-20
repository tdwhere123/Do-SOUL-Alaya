import type {
  MemoryEntry,
  RecallCandidate
} from "@do-soul/alaya-protocol";
import type { CoarseRecallCandidate } from "./recall-service-results.js";

const RECALL_RANK_SCORE_SCALE = 1e8;
// Replay-local lifecycle timing must not affect rank-sensitive scoring.
const DRIFT_SENSITIVE_RANK_SCORE_SCALE = 1e6;

export function normalizeRecallRankingScore(score: number): number {
  return Math.round(score * RECALL_RANK_SCORE_SCALE) / RECALL_RANK_SCORE_SCALE;
}

export function normalizeDriftSensitiveRankingScore(score: number | null): number {
  return Math.round(normalizeActivationScore(score) * DRIFT_SENSITIVE_RANK_SCORE_SCALE) /
    DRIFT_SENSITIVE_RANK_SCORE_SCALE;
}

export function compareMemorySemanticIdentity(
  left: Readonly<MemoryEntry>,
  right: Readonly<MemoryEntry>
): number {
  return left.content.localeCompare(right.content) ||
    left.dimension.localeCompare(right.dimension) ||
    left.scope_class.localeCompare(right.scope_class) ||
    left.source_kind.localeCompare(right.source_kind) ||
    left.formation_kind.localeCompare(right.formation_kind) ||
    compareOptionalString(left.event_time_start, right.event_time_start) ||
    compareOptionalString(left.event_time_end, right.event_time_end) ||
    compareOptionalString(left.valid_from, right.valid_from) ||
    compareOptionalString(left.valid_to, right.valid_to) ||
    compareStringLists(left.canonical_entities, right.canonical_entities) ||
    compareFacetTags(left.facet_tags, right.facet_tags);
}

export function compareMemoryEntriesForActivationAdmission(
  left: Readonly<MemoryEntry>,
  right: Readonly<MemoryEntry>
): number {
  const activationDelta = normalizeDriftSensitiveRankingScore(right.activation_score) -
    normalizeDriftSensitiveRankingScore(left.activation_score);
  if (activationDelta !== 0) {
    return activationDelta;
  }
  // Replay-local timestamps and IDs must not decide which equal-score memory crosses the admission cut.
  return compareMemorySemanticIdentity(left, right) || left.object_id.localeCompare(right.object_id);
}

function compareOptionalString(
  left: string | null | undefined,
  right: string | null | undefined
): number {
  return (left ?? "").localeCompare(right ?? "");
}

function compareStringLists(
  left: readonly string[] | null | undefined,
  right: readonly string[] | null | undefined
): number {
  const sharedLength = Math.min(left?.length ?? 0, right?.length ?? 0);
  for (let index = 0; index < sharedLength; index += 1) {
    const comparison = left![index]!.localeCompare(right![index]!);
    if (comparison !== 0) return comparison;
  }
  return (left?.length ?? 0) - (right?.length ?? 0);
}

function compareFacetTags(
  left: MemoryEntry["facet_tags"],
  right: MemoryEntry["facet_tags"]
): number {
  const sharedLength = Math.min(left?.length ?? 0, right?.length ?? 0);
  for (let index = 0; index < sharedLength; index += 1) {
    const leftTag = left![index]!;
    const rightTag = right![index]!;
    const comparison = leftTag.facet.localeCompare(rightTag.facet) ||
      compareOptionalString(leftTag.value, rightTag.value);
    if (comparison !== 0) return comparison;
  }
  return (left?.length ?? 0) - (right?.length ?? 0);
}


export function compareMemoryEntries(left: Readonly<MemoryEntry>, right: Readonly<MemoryEntry>): number {
  const activationDelta = normalizeActivationScore(right.activation_score) - normalizeActivationScore(left.activation_score);
  if (activationDelta !== 0) {
    return activationDelta;
  }
  return compareMemorySemanticIdentity(left, right) || left.object_id.localeCompare(right.object_id);
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

export function normalizeActivationScore(value: number | null): number {
  return value ?? 0;
}

export function normalizeGraphSupport(count: number): number {
  // invariant: clamp [count,0,3]/3 over the positive-only inbound weighted sum (negatives filtered upstream); the Math.max(count,0) floor is defensive only. Suppression is handled separately in recall-service.ts. see also: path-graph/graph-explore-service.ts (countInbound* positive-only filter).
  return Math.min(Math.max(count, 0), 3) / 3;
}

export function normalizeQueryText(value: string): string | null {
  const trimmed = value.trim();
  return trimmed.length === 0 ? null : trimmed;
}
