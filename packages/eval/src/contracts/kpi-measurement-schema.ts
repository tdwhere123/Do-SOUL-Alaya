import { z } from "zod";

const MeasurementAttributionFields = {
  status: z.enum(["eligible", "ineligible"]),
  gate_eligible: z.boolean(),
  evidence_status: z.enum(["complete", "partial"]),
  candidate_pool_complete: z.boolean(),
  provenance_complete: z.boolean(),
  abstention_calibration_status: z.enum(["not_applicable", "uncalibrated"])
} as const;

const LegacyBenchmarkMeasurementAttributionSchema = z.object({
  schema_version: z.literal("bench-measurement-attribution.v1"),
  ...MeasurementAttributionFields
}).strict();

const LegacyV2BenchmarkMeasurementAttributionSchema = z.object({
  schema_version: z.literal("bench-measurement-attribution.v2"),
  ...MeasurementAttributionFields,
  evaluator_identity_status: z.enum(["complete", "invalid"])
}).strict().superRefine((value, context) => {
  const eligible = value.evidence_status === "complete" &&
    value.candidate_pool_complete && value.provenance_complete &&
    value.abstention_calibration_status === "not_applicable" &&
    value.evaluator_identity_status === "complete";
  if (value.gate_eligible !== eligible ||
      value.status !== (eligible ? "eligible" : "ineligible")) {
    context.addIssue({
      code: "custom",
      message: "measurement attribution eligibility fields are inconsistent"
    });
  }
});

const CurrentBenchmarkMeasurementAttributionSchema = z.object({
  schema_version: z.literal("bench-measurement-attribution.v3"),
  ...MeasurementAttributionFields,
  measurement_scope: z.literal("answerable_recall"),
  abstention_evaluation_status: z.literal("excluded_not_evaluated"),
  abstention_calibration_status: z.literal("uncalibrated"),
  abstention_gate_eligible: z.literal(false),
  abstention_evidence_status: z.enum(["current_uncalibrated", "missing_or_legacy"]),
  evaluator_identity_status: z.enum(["complete", "invalid"])
}).strict().superRefine((value, context) => {
  const eligible = value.evidence_status === "complete" &&
    value.candidate_pool_complete && value.provenance_complete &&
    value.abstention_evidence_status === "current_uncalibrated" &&
    value.evaluator_identity_status === "complete";
  if (value.gate_eligible !== eligible ||
      value.status !== (eligible ? "eligible" : "ineligible")) {
    context.addIssue({
      code: "custom",
      message: "scoped measurement attribution eligibility fields are inconsistent"
    });
  }
});

export const BenchmarkMeasurementAttributionSchema = z.discriminatedUnion(
  "schema_version",
  [
    LegacyBenchmarkMeasurementAttributionSchema,
    LegacyV2BenchmarkMeasurementAttributionSchema,
    CurrentBenchmarkMeasurementAttributionSchema
  ]
);

export type BenchmarkMeasurementAttribution = z.infer<
  typeof BenchmarkMeasurementAttributionSchema
>;
