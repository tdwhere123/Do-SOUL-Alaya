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

/**
 * Always fail-closed on recompute-live. Not captured-vs-live compares.
 * Live packet-plan well-formedness is refused as free: schema of the live receipt.
 */
export const ALWAYS_FAIL_CLOSED_ASSERTIONS: readonly ReplayIdentityRow[] = Object.freeze([
  {
    class: "input",
    site: "selection-boundary-restore.ts:57",
    reason: "schema_version=2 is hydrate integrity of the frozen artifact."
  },
  {
    class: "input",
    site: "selection-boundary-json.ts:14,19,26",
    reason: "JSON/finite values are capture serializability, not composition."
  },
  {
    class: "input",
    site: "selection-boundary-restore.ts:63",
    reason: "visible_result_sha256 shape is captured digest syntax."
  },
  {
    class: "input",
    site: "selection-boundary-restore.ts:72",
    reason: "Unique ordered keys are candidate-population identity."
  },
  {
    class: "input",
    site: "validation/packet-order.ts:16,24",
    reason: "packet_candidate_keys length/uniqueness/subset is packet membership identity."
  },
  {
    class: "input",
    site: "selection-boundary-restore.ts:78,242",
    reason: "Number-map uniqueness/finiteness is captured map validity."
  },
  {
    class: "input",
    site: "selection-boundary-restore.ts:81,84",
    reason: "Trace and supplementary map keys must be unique in the capture."
  },
  {
    class: "input",
    site: "validation/evidence-semantic-receipt.ts:25,63,70,78,89,107,129,139,146,159,167,176",
    reason: "Evidence-semantic receipts are frozen evidence identity."
  },
  {
    class: "input",
    site: "validation/open-semantic-candidate-activation-receipt.ts:14",
    reason: "Open-semantic activations are frozen evidence identity."
  },
  {
    class: "input",
    site: "validation/evidence-fts-receipt.ts:17",
    reason: "FTS lane receipts are frozen evidence identity."
  },
  {
    class: "input",
    site: "selection-boundary-restore.ts:90,165,174,145,154,136,114,125",
    reason: "Field seal, refinements, query geometry, coverage config, and receipt verifies."
  },
  {
    class: "input",
    site: "selection-boundary-restore.ts:262",
    reason: "Captured final keys must equal captured consensus keys (capture-internal)."
  },
  {
    class: "input",
    site: "selection-boundary-restore.ts:293,336,411",
    reason: "Captured pre-projection schema and digest vs captured delivered keys."
  },
  {
    class: "input",
    site: "restoration/selection-params.ts:123",
    reason: "Token miss fail-closed is assert-mode estimator identity; recompute-live computes."
  },
  {
    class: "input",
    site: "selection-boundary-composition.ts:assertRecomputeLiveFeatureCapture",
    reason: "recompute-live requires capture_answer_features so family scores exist."
  },
  {
    class: "input",
    site: "packet-plan/packet-plan-observation.ts:146-483",
    reason:
      "Live packet-plan well-formedness is receipt schema, including Changed consensus decision is inconsistent. Not a captured-vs-live compare. Refused as free."
  },
  {
    class: "input",
    site: "fine-assessment-selection/order-sequence.ts:198,210",
    reason: "Live walk must stay a permutation of the birth/packet population."
  },
  {
    class: "input",
    site: "fine-assessment-selection/admission.ts:50",
    reason: "Duplicate admission receipt presence is live admission integrity."
  },
  {
    class: "input",
    site: "fine-assessment-selection.ts:386",
    reason: "Admission receipt presence is live admission integrity."
  },
  {
    class: "input",
    site: "fine-assessment-selection/coverage-atoms.ts:339,365",
    reason: "Coverage fact projection/slot identity is evidence identity during merge."
  },
  {
    class: "input",
    site: "coverage-selection.ts:180,278",
    reason: "Coverage operator id and non-negative gain are live coverage receipts."
  },
  {
    class: "input",
    site: "selection-boundary/pre-projection/observation.ts:20,139,151",
    reason: "Live pre-projection must match admission receipts of this walk."
  },
  {
    class: "input",
    site: "selection-boundary-capture.ts:50,132",
    reason: "Unstable token estimate and observer-return contract are capture API identity."
  },
  {
    class: "input",
    site: "selection-boundary-replay.ts:40,54",
    reason: "Captured-order replay digest proves the frozen artifact still reconstitutes."
  },
  {
    class: "input",
    site: "fine-assessment-selection/order-ledger.ts:103-278",
    reason: "Live ledger well-formedness is rank/transition schema of this walk."
  },
  {
    class: "input",
    site: "apps/bench-runner/.../selection-order-ledger-artifact.ts:81,91,273,359",
    reason: "Source SHA, byte-stability, and coarse_identity=captured are artifact identity."
  },
  {
    class: "input",
    site: "apps/bench-runner/.../selection-order-ledger-artifact.ts:116,122",
    reason: "Gold map is required harness identity for recompute-live."
  },
  {
    class: "input",
    site: "apps/bench-runner/.../selection-boundary-gold-map.ts:22,28,42,52,57",
    reason: "Gold map schema/uniqueness is harness identity."
  },
  {
    class: "input",
    site: "apps/bench-runner/.../selection-order-ledger-recompute.ts:126,167,195,202,208,248,282",
    reason: "Gold QID and formula_operator_id are live receipt completeness; missing traces fail closed."
  },
  {
    class: "input",
    site: "apps/bench-runner/.../selection-order-ledger-recompute.ts:219,225,233,236",
    reason:
      "Stage-walk length/owner and coarse membership are pipeline/packet identity, not composition scores."
  },
  {
    class: "input",
    site: "apps/bench-runner/.../selection-boundary-spool.ts:114,281,338,347",
    reason: "Spool sequence, source identity, and captured-order verify are artifact identity."
  },
  {
    class: "input",
    site: "apps/bench-runner/.../selection-boundary-record-identity.ts:15",
    reason: "Record wrapper attributes fail-closed errors; it does not skip asserts."
  }
]);
