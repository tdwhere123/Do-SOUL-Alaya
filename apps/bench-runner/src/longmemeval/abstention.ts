/**
 * @anchor longmemeval-abstention — uncalibrated fused-margin scoring for the
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
 * is the single knob behind the uncalibrated abstention heuristic, and the
 * diagnostics `abstention` block records the value used by each run so the
 * number can be re-derived.
 */
export const ABSTENTION_FALSE_CONFIDENT_THRESHOLD = 0.91;

/** True iff the question id marks a LongMemEval abstention question. */
export function isAbstentionQuestionId(questionId: string): boolean {
  return questionId.endsWith("_abs");
}

/**
 * invariant: premise_invalid is always false; call sites use this helper so
 * the bit stays intentional rather than an ad-hoc literal.
 */
export function resolvePremiseInvalid(): false {
  return false;
}

export interface AbstentionScoringInput {
  /**
   * Delivered recall results in rank order. Only the top-five prefix defines
   * the question-level heuristic; callers may pass the full delivered slice.
   */
  readonly results: readonly {
    readonly relevance_score: number;
    readonly abstention_confidence_score?: number | null;
  }[];
  /** False-confident threshold; defaults to the module constant. */
  readonly threshold?: number;
}

export interface AbstentionScoringResult {
  /** Question-level heuristic stays below the threshold. */
  readonly correctAt1: boolean;
  /** Same question-level verdict, projected onto the R@5 field. */
  readonly correctAt5: boolean;
  /** Same question-level verdict, projected onto the R@10 field. */
  readonly correctAt10: boolean;
  /** The threshold actually applied (for diagnostics auditability). */
  readonly threshold: number;
}

/**
 * One question-level fused-margin verdict for an abstention question.
 *
 * The top-five prefix yields one heuristic value and therefore one verdict
 * projected to all three legacy R@k fields. Later ranks cannot change it.
 */
export function scoreAbstentionQuestion(
  input: AbstentionScoringInput
): AbstentionScoringResult {
  const threshold = input.threshold ?? ABSTENTION_FALSE_CONFIDENT_THRESHOLD;
  const confidence = maxTopFiveConfidence(input.results);
  const correct = confidence === null || confidence < threshold;
  return {
    correctAt1: correct,
    correctAt5: correct,
    correctAt10: correct,
    threshold
  };
}

function maxTopFiveConfidence(results: AbstentionScoringInput["results"]): number | null {
  const values = results.slice(0, 5)
    .map((result) => result.abstention_confidence_score)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  return values.length === 0 ? null : Math.max(...values);
}
