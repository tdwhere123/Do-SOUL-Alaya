import type { SliceCompatibilityV2 } from "./slice-key-selector.js";

export type SingleHopSliceCompatibility =
  | "not_evaluated"
  | SliceCompatibilityV2["reason"];

export type SingleHopRemotenessReason =
  | "transferred"
  | "capped"
  | "self_loop"
  | "missing_edge_provenance"
  | "missing_or_zero_input"
  | "non_positive_conductance"
  | "no_slice_match";

export interface SingleHopRemotenessResult {
  readonly rawTransfer: number;
  readonly cappedTransfer: number;
  readonly sliceCompatibility: SingleHopSliceCompatibility;
  readonly decision: "transferred" | "rejected";
  readonly reason: SingleHopRemotenessReason;
}

interface SingleHopRemotenessInput {
  readonly inputPotential: number;
  readonly edgeConductance: number;
  readonly capPerSource: number;
  readonly selfLoop: boolean;
  readonly sliceCompatibility?: Readonly<SliceCompatibilityV2>;
}

export function evaluateSingleHopRemoteness(
  input: Readonly<SingleHopRemotenessInput>
): Readonly<SingleHopRemotenessResult> {
  const rawTransfer = input.inputPotential * input.edgeConductance;
  const sliceCompatibility = input.sliceCompatibility?.reason ?? "not_evaluated";
  const rejectedReason = rejectionReason(input);
  if (rejectedReason !== null) {
    return result(rawTransfer, 0, sliceCompatibility, "rejected", rejectedReason);
  }
  if (input.capPerSource <= 0) {
    return result(rawTransfer, 0, sliceCompatibility, "rejected", "capped");
  }
  const cappedTransfer = Math.min(rawTransfer, input.capPerSource);
  if (cappedTransfer <= 0) {
    return result(rawTransfer, 0, sliceCompatibility, "rejected", "missing_or_zero_input");
  }
  const reason = cappedTransfer < rawTransfer ? "capped" : "transferred";
  return result(rawTransfer, cappedTransfer, sliceCompatibility, "transferred", reason);
}

function rejectionReason(
  input: Readonly<SingleHopRemotenessInput>
): SingleHopRemotenessReason | null {
  if (input.sliceCompatibility?.decision === "rejected") return "no_slice_match";
  if (input.selfLoop) return "self_loop";
  if (input.inputPotential <= 0) return "missing_or_zero_input";
  if (input.edgeConductance <= 0) return "non_positive_conductance";
  return null;
}

function result(
  rawTransfer: number,
  cappedTransfer: number,
  sliceCompatibility: SingleHopSliceCompatibility,
  decision: SingleHopRemotenessResult["decision"],
  reason: SingleHopRemotenessReason
): Readonly<SingleHopRemotenessResult> {
  return Object.freeze({ rawTransfer, cappedTransfer, sliceCompatibility, decision, reason });
}
