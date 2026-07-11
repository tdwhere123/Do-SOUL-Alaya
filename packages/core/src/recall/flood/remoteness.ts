import type { SliceCompatibilityV1 } from "./slice-key-selector.js";
import { clamp01 } from "../../shared/clamp.js";

export type SingleHopSliceCompatibility =
  | "not_evaluated"
  | SliceCompatibilityV1["reason"];

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
  readonly sliceCompatibility?: Readonly<SliceCompatibilityV1>;
  readonly enforceSliceCompatibility?: boolean;
  readonly edgeProvenanceValid?: boolean;
}

export function evaluateSingleHopRemoteness(
  input: Readonly<SingleHopRemotenessInput>
): Readonly<SingleHopRemotenessResult> {
  const normalized = normalizeTransferInput(input);
  const rawTransfer = normalized.inputPotential * normalized.edgeConductance;
  const sliceCompatibility = input.sliceCompatibility?.reason ?? "not_evaluated";
  const rejectedReason = rejectionReason(normalized);
  if (rejectedReason !== null) {
    return result(rawTransfer, 0, sliceCompatibility, "rejected", rejectedReason);
  }
  if (normalized.capPerSource <= 0) {
    return result(rawTransfer, 0, sliceCompatibility, "rejected", "capped");
  }
  const cappedTransfer = Math.min(rawTransfer, normalized.capPerSource);
  if (cappedTransfer <= 0) {
    return result(rawTransfer, 0, sliceCompatibility, "rejected", "missing_or_zero_input");
  }
  const reason = cappedTransfer < rawTransfer ? "capped" : "transferred";
  return result(rawTransfer, cappedTransfer, sliceCompatibility, "transferred", reason);
}

function normalizeTransferInput(
  input: Readonly<SingleHopRemotenessInput>
): Readonly<SingleHopRemotenessInput> {
  if (input.enforceSliceCompatibility !== true) return input;
  return {
    ...input,
    inputPotential: clamp01(input.inputPotential),
    edgeConductance: clamp01(input.edgeConductance),
    capPerSource: clamp01(input.capPerSource)
  };
}

function rejectionReason(
  input: Readonly<SingleHopRemotenessInput>
): SingleHopRemotenessReason | null {
  if (input.enforceSliceCompatibility === true && input.edgeProvenanceValid === false) {
    return "missing_edge_provenance";
  }
  if (input.selfLoop) return "self_loop";
  if (input.inputPotential <= 0) return "missing_or_zero_input";
  if (input.edgeConductance <= 0) return "non_positive_conductance";
  if (input.enforceSliceCompatibility === true && input.sliceCompatibility?.reason === "no_slice_match") {
    return "no_slice_match";
  }
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
