/**
 * @anchor:abstention-confidence — uncalibrated fused-margin heuristic for
 * LongMemEval `_abs` scoring.
 *
 * `relevance_score` is saturated effectiveScore and must never feed this
 * channel. Confidence is ranking dominance among delivered `fused_score`
 * values: a large top-of-list margin means the run looks spuriously sure an
 * answer exists, so `abstention_confidence_score` is high.
 *
 * Formula (monotone in margin): let m = mean of available
 * (top1−top2, top1−mean(top2..top5)); then
 * score = clamp(m / ABSTENTION_FUSED_MARGIN_SCALE, 0, 1). Missing fused
 * scores or fewer than two finite fused values → null (scorer auto-passes).
 *
 * see also: apps/bench-runner/src/longmemeval/abstention.ts
 */

/** RRF default k=60; maps realistic fused margins onto [0, 1] confidence. */
export const ABSTENTION_FUSED_MARGIN_SCALE = 1 / 60;

export interface FusedScorePointer {
  readonly fused_score?: number | null;
  readonly abstention_confidence_score?: number | null;
}

/**
 * Question-level abstention confidence from the strongest fused scores.
 * Returns null when dominance cannot be measured (vacuous → correct abstain).
 */
export function computeAbstentionConfidenceScore(
  fusedScores: readonly (number | null | undefined)[]
): number | null {
  const values = fusedScores
    .slice(0, 5)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .sort((left, right) => right - left);
  if (values.length < 2) return null;
  const top1 = values[0];
  if (top1 === undefined) return null;
  const margins: number[] = [];
  const top2 = values[1];
  if (top2 !== undefined) {
    margins.push(top1 - top2);
  }
  const rest = values.slice(1);
  if (rest.length > 0) {
    const restMean = rest.reduce((sum, value) => sum + value, 0) / rest.length;
    margins.push(top1 - restMean);
  }
  if (margins.length === 0) return null;
  const dominance = margins.reduce((sum, value) => sum + value, 0) / margins.length;
  return clamp01(dominance / ABSTENTION_FUSED_MARGIN_SCALE);
}

/**
 * Attach the same list-level fused-margin confidence to every delivered
 * pointer. Does not read or copy `relevance_score`.
 */
export function attachAbstentionConfidenceScore<T extends FusedScorePointer>(
  results: readonly T[]
): readonly (T & { readonly abstention_confidence_score: number | null })[] {
  const confidence = resolveAbstentionConfidenceScore(results);
  return results.map((result) => ({
    ...result,
    abstention_confidence_score: confidence
  }));
}

export function resolveAbstentionConfidenceScore(
  results: readonly FusedScorePointer[]
): number | null {
  const explicitValues = results.slice(0, 5)
    .map((result) => result.abstention_confidence_score)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const explicit = explicitValues.length === 0 ? null : Math.max(...explicitValues);
  return explicit ?? computeAbstentionConfidenceScore(
    results.map((result) => result.fused_score)
  );
}

function clamp01(value: number): number {
  if (value <= 0) return 0;
  if (value >= 1) return 1;
  return value;
}
