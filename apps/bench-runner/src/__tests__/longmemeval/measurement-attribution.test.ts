import { describe, expect, it } from "vitest";
import { buildBenchmarkMeasurementAttribution } from "../../longmemeval/measurement/attribution.js";

describe("LongMemEval measurement attribution", () => {
  it("emits current eligible attribution only for complete evaluator identity", () => {
    expect(buildBenchmarkMeasurementAttribution({
      candidatePoolComplete: true,
      provenanceComplete: true,
      abstention: {
        schema_version: "bench-abstention.v2",
        total: 0,
        scored: 0,
        unscorable: 0,
        method: "fused_margin_diagnostic_only",
        calibration_status: "uncalibrated",
        gate_eligible: false
      },
      noGoldCount: 0,
      evaluatorIdentityIssueCount: 0,
      evaluatorIdentityUnscorableCount: 0
    })).toMatchObject({
      schema_version: "bench-measurement-attribution.v2",
      status: "eligible",
      gate_eligible: true,
      evaluator_identity_status: "complete"
    });
  });
  it("keeps readable v1 abstention evidence uncalibrated and ineligible", () => {
    expect(buildBenchmarkMeasurementAttribution({
      candidatePoolComplete: true,
      provenanceComplete: true,
      abstention: {
        schema_version: "bench-abstention.v1",
        total: 6,
        false_confident_threshold: 0.91,
        correct_at_1: 1,
        correct_at_5: 1,
        correct_at_10: 1,
        false_confident_at_1: 5,
        false_confident_at_5: 5,
        false_confident_at_10: 5
      }
    })).toMatchObject({
      status: "ineligible",
      gate_eligible: false,
      abstention_calibration_status: "uncalibrated"
    });
  });

  it("fails closed when abstention evidence is uncalibrated", () => {
    expect(buildBenchmarkMeasurementAttribution({
      candidatePoolComplete: true,
      provenanceComplete: true,
      abstention: {
        schema_version: "bench-abstention.v2",
        total: 6,
        scored: 0,
        unscorable: 6,
        method: "fused_margin_diagnostic_only",
        calibration_status: "uncalibrated",
        gate_eligible: false
      }
    })).toMatchObject({
      status: "ineligible",
      gate_eligible: false,
      evidence_status: "complete",
      abstention_calibration_status: "uncalibrated"
    });
  });

  it("fails closed when abstention calibration evidence is missing", () => {
    expect(buildBenchmarkMeasurementAttribution({
      candidatePoolComplete: false,
      provenanceComplete: true,
      abstention: undefined
    })).toMatchObject({
      status: "ineligible",
      gate_eligible: false,
      evidence_status: "partial",
      abstention_calibration_status: "uncalibrated"
    });
  });
});
