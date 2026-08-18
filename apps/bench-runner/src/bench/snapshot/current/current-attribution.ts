import type { SnapshotConsumeAuthority } from "./diagnostic-write-authority.js";

export function assertCurrentSnapshotAttributionClaim(
  input: {
    readonly attribution?: {
      readonly status?: unknown;
      readonly gate_eligible?: unknown;
    };
  },
  consumeAuthority: SnapshotConsumeAuthority = "promotion"
): void {
  if (consumeAuthority === "diagnostic") {
    assertDiagnosticSnapshotAttributionClaim(input);
    return;
  }
  if (input.attribution?.status !== "attributed" ||
      input.attribution.gate_eligible !== true) {
    throw new Error("current recall-eval snapshot stored gate_eligible claim is false");
  }
}

function assertDiagnosticSnapshotAttributionClaim(input: {
  readonly attribution?: {
    readonly status?: unknown;
    readonly gate_eligible?: unknown;
  };
}): void {
  const status = input.attribution?.status;
  const gateEligible = input.attribution?.gate_eligible;
  if (status === "diagnostic_attributed") {
    if (gateEligible !== false) {
      throw new Error(
        "diagnostic recall-eval snapshot diagnostic_attributed claim must keep gate_eligible false"
      );
    }
    return;
  }
  if (status !== "attributed") {
    throw new Error(
      "diagnostic recall-eval snapshot stored claim is not diagnostic_attributed"
    );
  }
}
