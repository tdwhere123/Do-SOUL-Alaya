import type { QualityMetrics } from "@do-soul/alaya-eval";
import type { MergeQualityMetricsState } from "./merge-quality-state.js";

export function accumulateCoreCounters(
  state: MergeQualityMetricsState,
  metric: QualityMetrics
): void {
  state.nonMonotonicCount += metric.non_monotonic_count;
  state.nonMonotonicDenominator += metric.non_monotonic_denominator;
  state.highLexicalDemotedCount += metric.high_lexical_demoted_count;
  state.highLexicalDemotedDenominator += metric.high_lexical_demoted_denominator;
  state.candidateAbsentCount += metric.candidate_absent_count;
  state.candidateAbsentDenominator += metric.candidate_absent_denominator;
  state.noGoldCount += metric.no_gold_count;
  state.noGoldDenominator += metric.no_gold_denominator;
  state.evaluatorIdentityIssueCount += metric.evaluator_identity_issue_count ?? 0;
  state.evaluatorIdentityIssueDenominator +=
    metric.evaluator_identity_issue_denominator ?? 0;
  state.evaluatorIdentityUnscorableCount +=
    metric.evaluator_identity_unscorable_count ?? 0;
  state.evaluatorIdentityUnscorableDenominator +=
    metric.evaluator_identity_unscorable_denominator ?? 0;
  state.evidenceStreamGoldDeliveryCount += metric.evidence_stream_gold_delivery_count;
  state.evidenceStreamGoldDeliveryDenominator +=
    metric.evidence_stream_gold_delivery_denominator;
  state.pathStreamTop10Count += metric.path_stream_top10_count;
  state.pathStreamTop10Denominator += metric.path_stream_top10_denominator;
}
