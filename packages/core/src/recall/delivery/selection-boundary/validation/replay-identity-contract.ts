/**
 * recompute-live is an input/output identity split, not "skip score fidelity."
 * Output rows are free only because they are downstream of composition.
 * Unclear rows stay fail-closed; live receipt schema is never a captured compare.
 */

export const CAPTURED_SCORE_FIDELITY_ASSERT = "assert" as const;
export const CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE = "recompute_live" as const;

export type CapturedScoreFidelityMode =
  | typeof CAPTURED_SCORE_FIDELITY_ASSERT
  | typeof CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE;

export type ReplayIdentityClass = "input" | "output";

export type ReplayIdentityRow = Readonly<{
  readonly class: ReplayIdentityClass;
  readonly site: string;
  readonly reason: string;
}>;

export const CAPTURED_VS_LIVE_ASSERTIONS = Object.freeze({
  candidate_population: {
    class: "input",
    site: "selection-boundary-composition.ts:assertCandidatePopulation",
    reason: "Delivery key set must be the frozen candidate population."
  },
  final_relevance: {
    class: "input",
    site: "selection-boundary-composition.ts:assertNumberMapEquals(final_relevance)",
    reason: "Public relevance is fused_score; replacePublicRelevance is false."
  },
  answer_relevance_rank: {
    class: "input",
    site: "selection-boundary-composition.ts:assertNumberMapEquals(answer_relevance_rank)",
    reason: "Empty answer-rank map is the fusion-public branch, not composition."
  },
  captured_order_policy: {
    class: "input",
    site: "validation/captured-order-policy.ts:assertCapturedOrderPolicy",
    reason: "Policy flags track embeddingObserved geometry, not composition scores."
  },
  token_function: {
    class: "input",
    site: "selection-boundary-composition.ts:resolveCompositionTokenEstimator",
    reason: "Stored token pairs must equal makeTokenEstimator(); that is the function."
  },
  candidate_order: {
    class: "output",
    site: "selection-boundary-composition.ts:assertCandidateOrder",
    reason: "Delivery sorts by live deep-head scores when scores exist."
  },
  delivery_rank: {
    class: "output",
    site: "selection-boundary-composition.ts:assertNumberMapEquals(delivery_rank)",
    reason: "Ranks are the permutation of candidate_order."
  },
  coverage_relevance: {
    class: "output",
    site: "selection-boundary-composition.ts:assertNumberMapEquals(coverage_relevance)",
    reason: "Coverage scalars are the live composition scores."
  },
  coverage_relevance_upper_bound: {
    class: "output",
    site: "selection-boundary-composition.ts:coverage_relevance_upper_bound",
    reason: "Upper-bound receipt is derived from the live composition scores."
  },
  deep_head_traces: {
    class: "output",
    site: "selection-boundary-composition.ts:assertDeepHeadTraces",
    reason: "Traces carry the live formula operator and resolved score fields."
  },
  expected_membership: {
    class: "output",
    site: "selection-boundary-composition.ts:assertCompositionExpected",
    reason:
      "Expected digest is delivered keys, packet consensus, pre-projection, and SHAs over those."
  }
} as const satisfies Record<string, ReplayIdentityRow>);

export type CapturedVsLiveAssertionId = keyof typeof CAPTURED_VS_LIVE_ASSERTIONS;

export function capturedOutcomeIsEnforced(
  mode: CapturedScoreFidelityMode,
  identityClass: ReplayIdentityClass
): boolean {
  return mode !== CAPTURED_SCORE_FIDELITY_RECOMPUTE_LIVE ||
    identityClass === "input";
}

export function assertCapturedVsLive(
  mode: CapturedScoreFidelityMode,
  id: CapturedVsLiveAssertionId,
  run: () => void
): void {
  if (!capturedOutcomeIsEnforced(mode, CAPTURED_VS_LIVE_ASSERTIONS[id].class)) {
    return;
  }
  run();
}
