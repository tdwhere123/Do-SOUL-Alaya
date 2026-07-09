/**
 * @anchor longmemeval-abstention — calibrated-confidence scoring for the
 * LongMemEval-S abstention questions (`question_id` ending `_abs`).
 *
 * An abstention question's haystack genuinely does NOT contain the answer,
 * so the correct agent behaviour is to abstain. Such a question has empty
 * `goldMemoryIds` and can never produce an id-equality hit. Rather than
 * dropping it from the recall@k denominator, the NUMERATOR rule is changed
 * for `_abs` rows only: an abstention question is "correct at k" unless an
 * explicit answerability-confidence signal crosses the false-confident
 * threshold. Retrieval relevance is a rank-order score, not answerability
 * confidence; using it as the `_abs` confidence source turns every saturated
 * retrieval pointer into a false answer.
 *
 * Answerable-question recall@1/5/10 semantics are untouched: this module is
 * only consulted for rows whose id satisfies {@link isAbstentionQuestionId}.
 *
 * see also: apps/bench-runner/src/longmemeval/runner.ts — scoring call site
 * see also: apps/bench-runner/src/longmemeval/diagnostics.ts — miss
 *   classification (`abstained_correctly` / `abstain_false_confident`)
 */

/**
 * False-confident answerability-confidence threshold (tunable).
 *
 * This threshold applies only to `abstention_confidence_score`, a separate
 * confidence channel for answerability/premise validity. It deliberately does
 * not apply to `relevance_score`: LongMemEval recall-only runs often saturate
 * delivered pointer relevance, and that score has no premise-validity signal.
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
  readonly results: readonly {
    readonly relevance_score: number;
    readonly abstention_confidence_score?: number | null;
  }[];
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
 * "Correct at k" means none of the top-k delivered results has an explicit
 * `abstention_confidence_score` at or above the threshold. So R@1 only
 * requires the top-1 to stay below; R@10 requires all of top-10. A question
 * with no delivered results, or only rank-only relevance scores, is correct
 * at every k because recall did not surface an answerability signal.
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
    const confidence = result.abstention_confidence_score;
    if (confidence === undefined || confidence === null) continue;
    if (confidence >= threshold) {
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
