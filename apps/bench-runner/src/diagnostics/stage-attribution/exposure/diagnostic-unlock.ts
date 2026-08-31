import type { CanaryPolarityMatrixVerdict } from "./canary-polarity-matrix.js";

export const DIAGNOSTIC_100Q_KPI_PROMOTION = {
  eligible: false,
  reason: "not_a_kpi_promotion_gate"
} as const;

export interface Diagnostic100QUnlock {
  readonly schema_version: 1;
  readonly kind: "diagnostic_100q_unlock";
  readonly eligible: boolean;
  readonly reason: "canary_polarity_matrix_passed" | "canary_polarity_matrix_failed" |
    "not_canary_window";
  readonly binds: {
    readonly polarity_matrix_passed: boolean;
    readonly physical_calls: 0;
  };
}

export function buildDiagnostic100QUnlock(
  matrix: CanaryPolarityMatrixVerdict
): Diagnostic100QUnlock {
  const binds = {
    polarity_matrix_passed: matrix.applicable && matrix.passed,
    physical_calls: 0 as const
  };
  if (!matrix.applicable) {
    return {
      schema_version: 1,
      kind: "diagnostic_100q_unlock",
      eligible: false,
      reason: "not_canary_window",
      binds
    };
  }
  return {
    schema_version: 1,
    kind: "diagnostic_100q_unlock",
    eligible: matrix.passed,
    reason: matrix.passed ? "canary_polarity_matrix_passed" : "canary_polarity_matrix_failed",
    binds
  };
}
