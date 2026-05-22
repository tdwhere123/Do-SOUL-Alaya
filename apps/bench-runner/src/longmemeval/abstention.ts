/**
 * @anchor longmemeval-abstention — calibrated-confidence scoring for the
 * LongMemEval-S abstention questions (`question_id` ending `_abs`).
 *
 * An abstention question's haystack genuinely does NOT contain the answer,
 * so the correct agent behaviour is to abstain. Such a question has empty
 * `goldMemoryIds` and can never produce an id-equality hit. Rather than
 * dropping it from the recall@k denominator, the NUMERATOR rule is changed
 * for `_abs` rows only: an abstention question is "correct at k" when recall
 * stays appropriately unconfident — none of its top-k delivered results
 * crosses the false-confident relevance-score threshold — and "wrong at k"
 * when at least one does. A clearly-irrelevant result delivered with a
 * relevance_score as high as recall reports on a genuine answer is a
 * false-confident result.
 *
 * Answerable-question recall@1/5/10 semantics are untouched: this module is
 * only consulted for rows whose id satisfies {@link isAbstentionQuestionId}.
 *
 * see also: apps/bench-runner/src/longmemeval/runner.ts — scoring call site
 * see also: apps/bench-runner/src/longmemeval/diagnostics.ts — miss
 *   classification (`abstained_correctly` / `abstain_false_confident`)
 */

/**
 * False-confident relevance-score threshold (tunable).
 *
 * Derived from per-question diagnostics of recent no-LLM full runs
 * (.do-it/runtime/q100-a|b and earlier). Evidence: the top-1
 * `relevance_score` of genuine R@1 hits on answerable questions forms the
 * "recall genuinely found the answer" distribution — min ~0.873,
 * lower-quartile (p25) ~0.916, median ~0.93 (n=741). A delivered result at
 * or above the lower quartile is statistically indistinguishable from
 * recall's confidence on a real hit. The constant is the p25 boundary
 * rounded down to a clean value: a delivered result with
 * `relevance_score >= 0.91` is treated as false-confident. On the `_abs`
 * questions this also separates the observed lower top-1 cluster
 * (~0.876-0.893) from the confident bulk (~0.907-0.930).
 *
 * Tune this when the recall pipeline or the benchmark dataset changes: it
 * is the single knob behind the calibrated abstention score, and the
 * diagnostics `abstention` block records the value used by each run so the
 * number can be re-derived.
 */
export const ABSTENTION_FALSE_CONFIDENT_THRESHOLD = 0.91;

/** True iff the question id marks a LongMemEval abstention question. */
export function isAbstentionQuestionId(questionId: string): boolean {
  return questionId.endsWith("_abs");
}

export interface AbstentionScoringInput {
  /**
   * Delivered recall results in rank order (rank 1 first). Only the first
   * 10 are consulted; callers may pass the full delivered slice.
   */
  readonly results: readonly { readonly relevance_score: number }[];
  /** False-confident threshold; defaults to the module constant. */
  readonly threshold?: number;
}

export interface AbstentionScoringResult {
  /** Correct at R@1: the top-1 result stays below the threshold. */
  readonly correctAt1: boolean;
  /** Correct at R@5: none of the top-5 results cross the threshold. */
  readonly correctAt5: boolean;
  /** Correct at R@10: none of the top-10 results cross the threshold. */
  readonly correctAt10: boolean;
  /** The threshold actually applied (for diagnostics auditability). */
  readonly threshold: number;
}

/**
 * Per-k calibrated-confidence verdict for one abstention question.
 *
 * "Correct at k" means none of the top-k delivered results has a
 * `relevance_score` at or above the threshold. So R@1 only requires the
 * top-1 to stay below; R@10 requires all of top-10. A question with no
 * delivered results is correct at every k (recall surfaced nothing, which
 * is the ideal abstention behaviour).
 */
export function scoreAbstentionQuestion(
  input: AbstentionScoringInput
): AbstentionScoringResult {
  const threshold = input.threshold ?? ABSTENTION_FALSE_CONFIDENT_THRESHOLD;
  let crossedWithin1 = false;
  let crossedWithin5 = false;
  let crossedWithin10 = false;
  for (let rank = 0; rank < input.results.length && rank < 10; rank++) {
    const result = input.results[rank];
    if (result === undefined) continue;
    if (result.relevance_score >= threshold) {
      if (rank < 1) crossedWithin1 = true;
      if (rank < 5) crossedWithin5 = true;
      crossedWithin10 = true;
    }
  }
  return {
    correctAt1: !crossedWithin1,
    correctAt5: !crossedWithin5,
    correctAt10: !crossedWithin10,
    threshold
  };
}
