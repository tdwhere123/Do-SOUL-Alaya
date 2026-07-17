import {
  isCacheOnlySeedExtractionPath,
  type KpiPayload
} from "@do-soul/alaya-eval";
import type { LongMemEvalQuestionDiagnostic } from "../diagnostics/schema/diagnostics-types.js";
import {
  isLongMemEvalRunProvenanceGateEligible,
  LongMemEvalRunProvenanceSchema
} from "../provenance/run.js";
import { buildBenchmarkMeasurementAttribution } from "./attribution.js";
import { assertMeasurementCohortBinding } from "./cohort-binding.js";

export function withCurrentMeasurementAttribution(input: {
  readonly payload: KpiPayload;
  readonly failedQuestionIds: readonly string[];
  readonly diagnostics: readonly LongMemEvalQuestionDiagnostic[];
  readonly provenanceContents: string;
}): KpiPayload {
  assertMeasurementCohortBinding(input.payload.kpi.per_scenario, input.diagnostics);
  const provenance = LongMemEvalRunProvenanceSchema.parse(
    JSON.parse(input.provenanceContents)
  );
  const candidatePoolComplete = input.failedQuestionIds.length === 0 &&
    input.diagnostics.every((question) => question.candidate_pool_complete);
  const provenanceComplete = isLongMemEvalRunProvenanceGateEligible(provenance) &&
    isCacheOnlySeedExtractionPath(input.payload.kpi.seed_extraction_path);
  const metrics = input.payload.kpi.quality_metrics;
  return {
    ...input.payload,
    measurement_attribution: buildBenchmarkMeasurementAttribution({
      candidatePoolComplete,
      provenanceComplete,
      abstention: metrics?.abstention,
      noGoldCount: metrics?.no_gold_count,
      evaluatorIdentityIssueCount: metrics?.evaluator_identity_issue_count,
      evaluatorIdentityUnscorableCount: metrics?.evaluator_identity_unscorable_count
    })
  };
}
