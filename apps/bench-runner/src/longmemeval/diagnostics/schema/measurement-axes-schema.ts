import { z } from "zod";

const CountRatioSchema = z.object({
  candidate_count: z.number().int().nonnegative(),
  projected_count: z.number().int().nonnegative(),
  provenance_complete_count: z.number().int().nonnegative(),
  integrity_ratio: z.number().min(0).max(1).nullable()
}).strict();

const MeasurementAxesObjectSchema = z
  .object({
    answer_session_coverage_at_5: answerSessionCoverageSchema(),
    answer_literal_witness_lower_bound_at_5: literalWitnessSchema(),
    source_timestamp_availability_at_5: datasetTimestampJoinSchema(),
    memory_temporal_projection_integrity_at_5: CountRatioSchema.extend({
      source: z.literal("runtime_candidate_answer_features")
    }).strict().readonly(),
    evaluator_identity_integrity_at_5: evaluatorIdentitySchema(),
    abstention: z.object({
      applicable: z.boolean(),
      status: z.enum(["not_applicable", "correct", "false_confident", "uncalibrated"])
    }).strict().readonly()
  })
  .strict();

type MeasurementAxesValue = z.infer<typeof MeasurementAxesObjectSchema>;

export const LongMemEvalQuestionMeasurementAxesSchema =
  MeasurementAxesObjectSchema.superRefine(validateMeasurementAxes).readonly();

function answerSessionCoverageSchema() {
  return z.object({
    applicable: z.boolean(),
    covered_count: z.number().int().nonnegative(),
    total_count: z.number().int().nonnegative(),
    ratio: z.number().min(0).max(1).nullable(),
    full_coverage: z.boolean()
  }).strict().readonly();
}

function literalWitnessSchema() {
  return z.object({
    applicable: z.boolean(),
    inspected_candidate_count: z.number().int().nonnegative(),
    matched_candidate_count: z.number().int().nonnegative(),
    witnessed: z.boolean(),
    witnesses: z.array(z.object({
      object_id: z.string(),
      object_kind: z.enum(["memory_entry", "synthesis_capsule"]),
      rank: z.number().int().positive(),
      field: z.enum(["content", "evidence_gist"])
    }).strict().readonly()).readonly()
  }).strict().readonly();
}

function datasetTimestampJoinSchema() {
  return z.object({
    source: z.literal("dataset_session_timestamp_join"),
    candidate_count: z.number().int().nonnegative(),
    available_count: z.number().int().nonnegative(),
    ratio: z.number().min(0).max(1).nullable(),
    all_available: z.boolean()
  }).strict().readonly();
}

function evaluatorIdentitySchema() {
  return z.object({
    applicable: z.boolean(),
    status: z.enum(["not_applicable", "consistent", "inconsistent", "indeterminate"]),
    exact_gold_count: z.number().int().nonnegative(),
    answer_session_supported_count: z.number().int().nonnegative(),
    literal_supported_count: z.number().int().nonnegative(),
    top_five_answer_session_supported_count: z.number().int().nonnegative(),
    top_five_literal_supported_count: z.number().int().nonnegative()
  }).strict().readonly();
}

function validateMeasurementAxes(
  axes: MeasurementAxesValue,
  context: z.RefinementCtx
): void {
  validateCoverage(axes, context);
  validateLiteralWitnesses(axes, context);
  validateDatasetTimestampJoin(axes, context);
  validateMemoryProjection(axes, context);
  validateEvaluatorIdentity(axes, context);
  if (axes.abstention.applicable !== (axes.abstention.status !== "not_applicable")) {
    addIssue(context, ["abstention", "applicable"], "abstention applicability is inconsistent with status");
  }
}

function validateCoverage(
  axes: MeasurementAxesValue,
  context: z.RefinementCtx
): void {
  const value = axes.answer_session_coverage_at_5;
  const expectedApplicable = !axes.abstention.applicable && value.total_count > 0;
  if (value.applicable !== expectedApplicable) {
    addIssue(context, ["answer_session_coverage_at_5"], "answer-session coverage applicability is inconsistent");
    return;
  }
  if (!value.applicable) {
    if (value.covered_count !== 0 || value.ratio !== null || value.full_coverage) {
      addIssue(context, ["answer_session_coverage_at_5"], "answer-session coverage is inconsistent");
    }
    return;
  }
  const ratio = value.total_count === 0 ? null : value.covered_count / value.total_count;
  const full = value.total_count > 0 && value.covered_count === value.total_count;
  if (value.total_count === 0 || value.covered_count > value.total_count || value.ratio !== ratio ||
      value.full_coverage !== full) {
    addIssue(context, ["answer_session_coverage_at_5"], "answer-session coverage is inconsistent");
  }
}

function validateLiteralWitnesses(
  axes: MeasurementAxesValue,
  context: z.RefinementCtx
): void {
  const value = axes.answer_literal_witness_lower_bound_at_5;
  if (value.matched_candidate_count > value.inspected_candidate_count ||
      value.matched_candidate_count !== value.witnesses.length ||
      value.witnessed !== (value.matched_candidate_count > 0)) {
    addIssue(context, ["answer_literal_witness_lower_bound_at_5"], "literal witness counts are inconsistent");
  }
}

function validateDatasetTimestampJoin(
  axes: MeasurementAxesValue,
  context: z.RefinementCtx
): void {
  const value = axes.source_timestamp_availability_at_5;
  const ratio = value.candidate_count === 0 ? null : value.available_count / value.candidate_count;
  const all = value.candidate_count > 0 && value.available_count === value.candidate_count;
  if (value.available_count > value.candidate_count || value.ratio !== ratio ||
      value.all_available !== all) {
    addIssue(context, ["source_timestamp_availability_at_5"], "dataset timestamp join counts are inconsistent");
  }
}

function validateMemoryProjection(
  axes: MeasurementAxesValue,
  context: z.RefinementCtx
): void {
  const value = axes.memory_temporal_projection_integrity_at_5;
  const ratio = value.projected_count === 0
    ? null
    : value.provenance_complete_count / value.projected_count;
  if (value.projected_count > value.candidate_count ||
      value.provenance_complete_count > value.projected_count ||
      value.integrity_ratio !== ratio) {
    addIssue(context, ["memory_temporal_projection_integrity_at_5"], "memory temporal projection counts are inconsistent");
  }
}

function validateEvaluatorIdentity(
  axes: MeasurementAxesValue,
  context: z.RefinementCtx
): void {
  const value = axes.evaluator_identity_integrity_at_5;
  const statusApplicable = value.status !== "not_applicable";
  if (value.applicable !== statusApplicable ||
      value.answer_session_supported_count > value.exact_gold_count ||
      value.literal_supported_count > value.exact_gold_count) {
    addIssue(context, ["evaluator_identity_integrity_at_5"], "evaluator identity integrity is inconsistent");
  }
}

function addIssue(
  context: z.RefinementCtx,
  path: readonly string[],
  message: string
): void {
  context.addIssue({ code: "custom", path: [...path], message });
}
