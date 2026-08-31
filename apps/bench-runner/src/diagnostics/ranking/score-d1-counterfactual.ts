import {
  replayD1FrozenCapture,
  type D1MissingnessCoverage,
  type D1ReplayMetrics,
  type D1ReplayResult
} from "@do-soul/alaya-core";
import { CANONICAL_CAPTURE_IDENTITY_DIGEST } from "@do-soul/alaya-protocol";
import {
  createD1PairAuthorityAccumulator,
  finishD1PairAuthority,
  mapD1GoldsToFieldKeys,
  noteD1PairAuthorityFailure,
  recordD1GoldOccupierPairs,
  recordD1PairAuthorityQuestion,
  resolveD1GoldAuthority,
  type D1GoldOccupierBlockingReport,
  type D1PairAuthorityAccumulator
} from "./d1-pair-authority.js";
import type { LongMemEvalQuestionDiagnostic } from
  "../schema/diagnostics-types.js";
import { streamRecallEvalQuestionDiagnostics } from
  "../stage-attribution/load-recall-eval-diagnostics.js";

export type D1CounterfactualRate = Readonly<{
  readonly hits: number;
  readonly denominator: number;
  readonly rate: number;
}>;

export type D1CounterfactualCaptureIdentity = Readonly<{
  readonly expected: typeof CANONICAL_CAPTURE_IDENTITY_DIGEST;
  readonly observed: readonly string[];
  readonly matches: boolean;
}>;

export type D1EqualGCohortShrinkReport =
  | Readonly<{
    readonly status: "OBSERVED";
    readonly coverage: "complete";
    readonly replayed_questions: number;
    readonly question_count: number;
    readonly baseline_cohorts_gt_1: number;
    readonly shrunk_cohorts: number;
    readonly shrink_share: number;
  }>
  | Readonly<{
    readonly status: "INCOMPLETE";
    readonly coverage: "partial";
    readonly replayed_questions: number;
    readonly question_count: number;
    readonly baseline_cohorts_gt_1: null;
    readonly shrunk_cohorts: null;
    readonly shrink_share: null;
  }>
  | Readonly<{
    readonly status: "UNAVAILABLE";
    readonly coverage: "complete";
    readonly reason: "no_baseline_equal_g_cohorts_gt_1";
    readonly replayed_questions: number;
    readonly question_count: number;
    readonly baseline_cohorts_gt_1: null;
    readonly shrunk_cohorts: null;
    readonly shrink_share: null;
  }>;

export type D1CounterfactualReport = Readonly<{
  readonly question_count: number;
  readonly answerable_count: number;
  readonly abstention_count: number;
  readonly skipped_missing_capture: number;
  readonly skipped_missing_proofs: number;
  readonly skipped_unmapped_gold: number;
  readonly parse_failure_count: number;
  readonly cycle_failure_count: number;
  readonly replayed_count: number;
  readonly production_any_at_5: D1CounterfactualRate;
  readonly d1_any_at_5: D1CounterfactualRate;
  readonly mean_blocked_pair_share: number;
  readonly mean_f1_over_h: number;
  readonly mean_max_g_cohort: number;
  readonly mean_deterministic_tail_share: number;
  readonly total_receipt_backed_dominance_edges: number;
  readonly equal_g_same_cohort_shrink: D1EqualGCohortShrinkReport;
  readonly gold_occupier_blocking: D1GoldOccupierBlockingReport;
  readonly missingness: D1MissingnessCoverage;
  readonly capture_identity: D1CounterfactualCaptureIdentity;
  readonly provider_not_requested: number;
}>;

type Accumulator = {
  question_count: number;
  answerable_count: number;
  abstention_count: number;
  skipped_missing_capture: number;
  skipped_missing_proofs: number;
  skipped_unmapped_gold: number;
  parse_failure_count: number;
  cycle_failure_count: number;
  replayed_count: number;
  production_hits: number;
  d1_hits: number;
  blocked_pair_share: number;
  f1_over_h: number;
  max_g_cohort: number;
  tail_share: number;
  dominance_edges: number;
  baseline_equal_g_cohorts: number;
  shrunk_equal_g_cohorts: number;
  production_not_observed: number;
  legal_lane_envelopes: number;
  unbounded_lane_envelopes: number;
  inapplicable_lane_envelopes: number;
  capture_digests: Set<string>;
  provider_not_requested: number;
  pair_authority: D1PairAuthorityAccumulator;
};

export async function evaluateRecallEvalGzipD1Counterfactual(
  artifactPath: string
): Promise<D1CounterfactualReport> {
  const acc = emptyAccumulator();
  for await (const question of streamRecallEvalQuestionDiagnostics(artifactPath)) {
    accumulateQuestion(acc, question);
  }
  return finishReport(acc);
}

function accumulateQuestion(
  acc: Accumulator,
  question: LongMemEvalQuestionDiagnostic
): void {
  acc.question_count += 1;
  recordD1PairAuthorityQuestion(acc.pair_authority, question);
  if (question.provider_state === "provider_not_requested") {
    acc.provider_not_requested += 1;
  }
  const answerable = question.is_abstention !== true;
  if (answerable) acc.answerable_count += 1;
  else acc.abstention_count += 1;
  if (answerable && question.hit_at_5) acc.production_hits += 1;
  const receipt = capturedReceipt(question);
  if (receipt === null) {
    noteMissingPairAuthority(acc, question, missingCaptureField(question));
    acc.skipped_missing_capture += 1;
    return;
  }
  acc.capture_digests.add(receipt.identity.digest);
  if (!hasCapturedProofs(question.lexical_bound_proofs)) {
    noteMissingPairAuthority(acc, question, "lexical_bound_proofs[captured]");
    acc.skipped_missing_proofs += 1;
    return;
  }
  const goldKeys = bindFieldGoldKeys(acc, question, receipt);
  if (goldKeys === null) return;
  applyReplay(acc, question, receipt, goldKeys, answerable);
}

function bindFieldGoldKeys(
  acc: Accumulator,
  question: LongMemEvalQuestionDiagnostic,
  receipt: NonNullable<LongMemEvalQuestionDiagnostic["capture_receipt"]>
): readonly string[] | null {
  const gold = resolveD1GoldAuthority(question);
  if (gold.status !== "RESOLVED") {
    noteD1PairAuthorityFailure(acc.pair_authority, gold.reason);
    acc.skipped_unmapped_gold += 1;
    return null;
  }
  const field = mapD1GoldsToFieldKeys(gold.golds, receipt);
  if (field.status !== "MAPPED") {
    noteD1PairAuthorityFailure(acc.pair_authority, field.reason);
    acc.skipped_unmapped_gold += 1;
    return null;
  }
  if (question.is_abstention !== true && question.hit_at_5 !== true) {
    recordD1GoldOccupierPairs(acc.pair_authority, {
      question,
      field_gold_keys: field.field_keys,
      field_absent: field.absent
    });
  }
  return field.field_keys;
}

function applyReplay(
  acc: Accumulator,
  question: LongMemEvalQuestionDiagnostic,
  receipt: NonNullable<LongMemEvalQuestionDiagnostic["capture_receipt"]>,
  goldKeys: readonly string[],
  answerable: boolean
): void {
  let replayed: D1ReplayResult;
  try {
    replayed = replayD1FrozenCapture({
      observations_by_candidate_key: receipt.observations_by_candidate_key,
      set_utilities: receipt.gamma.set_utilities,
      lexical_bound_proofs: question.lexical_bound_proofs,
      gold_keys: goldKeys
    });
  } catch (error) {
    if (isReplayInputFailure(error)) {
      acc.parse_failure_count += 1;
      return;
    }
    throw error;
  }
  if (replayed.kind !== "replayed") {
    acc.cycle_failure_count += 1;
    return;
  }
  recordMetrics(acc, replayed.metrics, answerable);
}

function recordMetrics(
  acc: Accumulator,
  metrics: D1ReplayMetrics,
  answerable: boolean
): void {
  acc.replayed_count += 1;
  acc.blocked_pair_share += metrics.blocked_pair_share;
  acc.f1_over_h += metrics.f1_over_h;
  acc.max_g_cohort += metrics.mean_max_g_cohort_size;
  acc.tail_share += metrics.deterministic_tail_share;
  acc.dominance_edges += metrics.receipt_backed_dominance_edges;
  acc.baseline_equal_g_cohorts +=
    metrics.equal_g_cohort_shrink.baseline_cohorts_gt_1;
  acc.shrunk_equal_g_cohorts += metrics.equal_g_cohort_shrink.shrunk;
  acc.production_not_observed += metrics.missingness.production_not_observed;
  acc.legal_lane_envelopes += metrics.missingness.legal_lane_envelopes;
  acc.unbounded_lane_envelopes += metrics.missingness.unbounded_lane_envelopes;
  acc.inapplicable_lane_envelopes += metrics.missingness.inapplicable_lane_envelopes;
  if (answerable && metrics.any_at_5 === true) acc.d1_hits += 1;
}

function finishReport(acc: Accumulator): D1CounterfactualReport {
  const captureIdentity = captureIdentityReport(acc.capture_digests);
  return {
    question_count: acc.question_count,
    answerable_count: acc.answerable_count,
    abstention_count: acc.abstention_count,
    skipped_missing_capture: acc.skipped_missing_capture,
    skipped_missing_proofs: acc.skipped_missing_proofs,
    skipped_unmapped_gold: acc.skipped_unmapped_gold,
    parse_failure_count: acc.parse_failure_count,
    cycle_failure_count: acc.cycle_failure_count,
    replayed_count: acc.replayed_count,
    production_any_at_5: rate(acc.production_hits, acc.answerable_count),
    d1_any_at_5: rate(acc.d1_hits, acc.answerable_count),
    mean_blocked_pair_share: mean(acc.blocked_pair_share, acc.replayed_count),
    mean_f1_over_h: mean(acc.f1_over_h, acc.replayed_count),
    mean_max_g_cohort: mean(acc.max_g_cohort, acc.replayed_count),
    mean_deterministic_tail_share: mean(acc.tail_share, acc.replayed_count),
    total_receipt_backed_dominance_edges: acc.dominance_edges,
    equal_g_same_cohort_shrink: equalGShrinkReport(acc),
    gold_occupier_blocking: finishD1PairAuthority(acc.pair_authority, {
      question_count: acc.question_count,
      replayed_count: acc.replayed_count,
      capture_identity_digest: captureIdentity.matches
        ? CANONICAL_CAPTURE_IDENTITY_DIGEST
        : null
    }),
    missingness: {
      production_not_observed: acc.production_not_observed,
      legal_lane_envelopes: acc.legal_lane_envelopes,
      unbounded_lane_envelopes: acc.unbounded_lane_envelopes,
      inapplicable_lane_envelopes: acc.inapplicable_lane_envelopes
    },
    capture_identity: captureIdentity,
    provider_not_requested: acc.provider_not_requested
  };
}

function equalGShrinkReport(acc: Accumulator): D1EqualGCohortShrinkReport {
  const coverage = {
    replayed_questions: acc.replayed_count,
    question_count: acc.question_count
  };
  if (acc.replayed_count !== acc.question_count) {
    return {
      status: "INCOMPLETE",
      coverage: "partial",
      ...coverage,
      baseline_cohorts_gt_1: null,
      shrunk_cohorts: null,
      shrink_share: null
    };
  }
  if (acc.baseline_equal_g_cohorts === 0) {
    return {
      status: "UNAVAILABLE",
      coverage: "complete",
      reason: "no_baseline_equal_g_cohorts_gt_1",
      ...coverage,
      baseline_cohorts_gt_1: null,
      shrunk_cohorts: null,
      shrink_share: null
    };
  }
  return {
    status: "OBSERVED",
    coverage: "complete",
    ...coverage,
    baseline_cohorts_gt_1: acc.baseline_equal_g_cohorts,
    shrunk_cohorts: acc.shrunk_equal_g_cohorts,
    shrink_share: acc.shrunk_equal_g_cohorts / acc.baseline_equal_g_cohorts
  };
}

function captureIdentityReport(
  digests: ReadonlySet<string>
): D1CounterfactualCaptureIdentity {
  const observed = [...digests].sort();
  return {
    expected: CANONICAL_CAPTURE_IDENTITY_DIGEST,
    observed,
    matches: observed.length === 1 && observed[0] === CANONICAL_CAPTURE_IDENTITY_DIGEST
  };
}

function capturedReceipt(
  question: LongMemEvalQuestionDiagnostic
): NonNullable<LongMemEvalQuestionDiagnostic["capture_receipt"]> | null {
  const receipt = question.capture_receipt;
  if (receipt == null || receipt.execution.status !== "captured") return null;
  if (receipt.observations_by_candidate_key == null) return null;
  return receipt;
}

function missingCaptureField(question: LongMemEvalQuestionDiagnostic): string {
  const receipt = question.capture_receipt;
  if (receipt == null) return "capture_receipt";
  if (receipt.execution.status !== "captured") {
    return "capture_receipt.execution.status";
  }
  return "capture_receipt.observations_by_candidate_key";
}

function noteMissingPairAuthority(
  acc: Accumulator,
  question: LongMemEvalQuestionDiagnostic,
  field: string
): void {
  if (question.is_abstention === true || question.hit_at_5 === true) return;
  noteD1PairAuthorityFailure(acc.pair_authority, `missing_required_field:${field}`);
}

function hasCapturedProofs(proofs: unknown): boolean {
  if (!Array.isArray(proofs) || proofs.length === 0) return false;
  return proofs.some((row) =>
    row !== null && typeof row === "object" &&
    (row as { readonly status?: unknown }).status === "captured");
}

function rate(hits: number, denominator: number): D1CounterfactualRate {
  return {
    hits,
    denominator,
    rate: denominator === 0 ? 0 : hits / denominator
  };
}

function mean(total: number, denominator: number): number {
  return denominator === 0 ? 0 : total / denominator;
}

function isReplayInputFailure(error: unknown): boolean {
  return error instanceof TypeError ||
    (error instanceof Error && error.name === "ShadowContractError");
}

function emptyAccumulator(): Accumulator {
  return {
    question_count: 0,
    answerable_count: 0,
    abstention_count: 0,
    skipped_missing_capture: 0,
    skipped_missing_proofs: 0,
    skipped_unmapped_gold: 0,
    parse_failure_count: 0,
    cycle_failure_count: 0,
    replayed_count: 0,
    production_hits: 0,
    d1_hits: 0,
    blocked_pair_share: 0,
    f1_over_h: 0,
    max_g_cohort: 0,
    tail_share: 0,
    dominance_edges: 0,
    baseline_equal_g_cohorts: 0,
    shrunk_equal_g_cohorts: 0,
    production_not_observed: 0,
    legal_lane_envelopes: 0,
    unbounded_lane_envelopes: 0,
    inapplicable_lane_envelopes: 0,
    capture_digests: new Set<string>(),
    provider_not_requested: 0,
    pair_authority: createD1PairAuthorityAccumulator()
  };
}
