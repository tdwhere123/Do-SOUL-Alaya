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

const CurrentBenchmarkMeasurementAttributionSchema = z.object({
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

export const BenchmarkMeasurementAttributionSchema = z.discriminatedUnion(
  "schema_version",
  [LegacyBenchmarkMeasurementAttributionSchema, CurrentBenchmarkMeasurementAttributionSchema]
);

export type BenchmarkMeasurementAttribution = z.infer<
  typeof BenchmarkMeasurementAttributionSchema
>;
