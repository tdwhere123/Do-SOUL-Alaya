/**
 * @anchor longmemeval-abstention — fail-closed scoring and diagnostic
 * exclusion for LongMemEval-S abstention questions.
 *
 * An abstention question's haystack genuinely does NOT contain the answer,
 * so the correct agent behaviour is to abstain. Such a question has empty
 * `goldMemoryIds` and can never produce an id-equality hit. Recall-only has no
 * independently calibrated abstention judge, so these rows are unscorable and
 * must never add to a recall numerator. Fused margin remains diagnostic only.
 *
 * {@link isAbstentionDiagnostic} is the three-way diagnostic predicate:
 * `is_abstention`, question_id suffix `_abs`, or cohort `abstention`.
 * Stage tables, exposure receipts, and miss taxonomy share that predicate.
 *
 * Recall scoring routes by {@link isAbstentionQuestionId} only. That suffix
 * boundary is intentional and does not define diagnostic exclusion.
 *
 * see also: apps/bench-runner/src/datasets/longmemeval/runner.ts — scoring call site
 * see also: apps/bench-runner/src/datasets/longmemeval/diagnostics.ts
 */

/** True iff the question id marks a LongMemEval abstention question. */
export function isAbstentionQuestionId(questionId: string): boolean {
  return questionId.endsWith("_abs");
}

/** Stage tables and exposure receipts must exclude the same unscorable twins. */
export function isAbstentionDiagnostic(question: {
  readonly question_id: string;
  readonly is_abstention?: boolean;
  readonly cohort_ledger?: { readonly dataset_cohort?: string };
}): boolean {
  return question.is_abstention === true ||
    isAbstentionQuestionId(question.question_id) ||
    question.cohort_ledger?.dataset_cohort === "abstention";
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
   * Retained for one stable scorer seam; result shape and confidence availability
   * cannot change the fail-closed verdict before calibration exists.
   */
  readonly results: readonly {
    readonly relevance_score: number;
    readonly abstention_confidence_score?: number | null;
  }[];
}

export interface AbstentionScoringResult {
  readonly status: "uncalibrated";
  readonly scorable: false;
  readonly hitAt1: false;
  readonly hitAt5: false;
  readonly hitAt10: false;
}

/**
 * Recall-only abstention stays unscorable until an independent calibration
 * contract exists. Input is retained so callers cannot accidentally select a
 * different path based on result count or raw confidence availability.
 */
export function scoreAbstentionQuestion(
  _input: AbstentionScoringInput
): AbstentionScoringResult {
  return {
    status: "uncalibrated",
    scorable: false,
    hitAt1: false,
    hitAt5: false,
    hitAt10: false
  };
}
