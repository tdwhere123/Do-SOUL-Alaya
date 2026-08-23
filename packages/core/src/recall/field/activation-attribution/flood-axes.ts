import {
  selectSliceCompatibilityV2,
  type SliceCompatibilityInputV2,
  type SliceCompatibilityV2
} from "../../flood/slice-key-selector.js";
import type { FloodAxisInactiveReason } from "../../runtime/recall-service-types.js";
import { resolveSliceAxis } from "../../scoring/flood-slice-axis.js";
import { computeIntegratedFloodScore } from
  "../../scoring/integrated-flood-scoring.js";
import type {
  ActivationAttributionChannelReceipt,
  ActivationAttributionFloodObservation,
  ActivationAttributionReason,
  ActivationAttributionStatus
} from "./types.js";

export type LiveFloodAxisClassification = Readonly<{
  readonly slice: ActivationAttributionChannelReceipt;
  readonly path: ActivationAttributionChannelReceipt;
  readonly evidence: ActivationAttributionChannelReceipt;
  readonly fuel_verified: boolean | null;
}>;

export function classifyLiveFloodAxes(params: Readonly<{
  readonly flood?: ActivationAttributionFloodObservation;
  readonly slice?: SliceCompatibilityInputV2;
}>): LiveFloodAxisClassification {
  if (params.flood !== undefined) return classifyFromIntegratedFlood(params.flood);
  if (params.slice !== undefined) {
    return classifyFromSliceKeys(selectSliceCompatibilityV2(params.slice));
  }
  return Object.freeze({
    slice: unobserved("slice_compatibility", "slice_unobserved"),
    path: unobserved("path_inflow", "path_unobserved"),
    evidence: unobserved("evidence_support", "evidence_unobserved"),
    fuel_verified: null
  });
}

function classifyFromIntegratedFlood(
  flood: ActivationAttributionFloodObservation
): LiveFloodAxisClassification {
  const scored = computeIntegratedFloodScore(flood);
  const sliceAxis = resolveSliceAxis(flood.entry, flood.supplementaryData);
  return Object.freeze({
    slice: mapSliceStatus(scored.diagnostics.slice_status, sliceAxis.countsAsFuel),
    path: mapPathStatus(scored.diagnostics.path_status),
    evidence: mapEvidenceStatus(scored.diagnostics.evidence_status),
    fuel_verified: scored.diagnostics.fuel_verified
  });
}

function classifyFromSliceKeys(
  compatibility: Readonly<SliceCompatibilityV2>
): LiveFloodAxisClassification {
  return Object.freeze({
    slice: mapSliceDecision(compatibility.decision),
    path: unobserved("path_inflow", "path_unobserved"),
    evidence: unobserved("evidence_support", "evidence_unobserved"),
    fuel_verified: null
  });
}

function mapSliceDecision(
  decision: SliceCompatibilityV2["decision"]
): ActivationAttributionChannelReceipt {
  if (decision === "compatible") {
    return fuel("slice_compatibility", "not_applicable", "slice_attributed_fuel", "active", true);
  }
  if (decision === "rejected") {
    return fuel(
      "slice_compatibility", "zero_match", "slice_no_match", "inactive:no_slice_match", false
    );
  }
  // Live pass_through is inactive:no_slice and still counts as fuel.
  return fuel(
    "slice_compatibility", "not_applicable", "slice_pass_through", "inactive:no_slice", true
  );
}

function mapSliceStatus(
  status: FloodAxisInactiveReason,
  countsAsFuel: boolean
): ActivationAttributionChannelReceipt {
  if (status === "active") {
    return fuel("slice_compatibility", "not_applicable", "slice_attributed_fuel", status, true);
  }
  if (status === "inactive:no_slice_match") {
    return fuel("slice_compatibility", "zero_match", "slice_no_match", status, false);
  }
  return fuel(
    "slice_compatibility", "not_applicable", "slice_pass_through", status, countsAsFuel
  );
}

function mapPathStatus(
  status: FloodAxisInactiveReason
): ActivationAttributionChannelReceipt {
  if (status === "active") {
    return fuel("path_inflow", "not_applicable", "path_attributed_fuel", status, true);
  }
  if (status === "inactive:not_applicable") {
    return fuel("path_inflow", "not_applicable", "path_not_eligible", status, false);
  }
  if (status === "inactive:index_unavailable" || status === "inactive:storage_error") {
    return fuel("path_inflow", "unavailable", "path_index_unavailable", status, false);
  }
  if (status === "inactive:no_fuel") {
    return fuel("path_inflow", "zero_match", "path_no_fuel", status, false);
  }
  return fuel("path_inflow", "not_applicable", "path_pass_through", status, false);
}

function mapEvidenceStatus(
  status: FloodAxisInactiveReason
): ActivationAttributionChannelReceipt {
  if (status === "active") {
    return fuel("evidence_support", "not_applicable", "evidence_attributed_fuel", status, true);
  }
  if (status === "inactive:no_evidence") {
    return fuel("evidence_support", "zero_match", "evidence_no_support", status, false);
  }
  // Live resolveEvidenceAxis: missing vectors are pass-through, not an index gap.
  return fuel("evidence_support", "not_applicable", "evidence_pass_through", status, false);
}

function unobserved(
  channel: "slice_compatibility" | "path_inflow" | "evidence_support",
  reason: ActivationAttributionReason
): ActivationAttributionChannelReceipt {
  return fuel(channel, "unavailable", reason, null, false);
}

function fuel(
  channel: "slice_compatibility" | "path_inflow" | "evidence_support",
  status: ActivationAttributionStatus,
  reason: ActivationAttributionReason,
  floodAxisStatus: FloodAxisInactiveReason | null,
  countsAsFuel: boolean
): ActivationAttributionChannelReceipt {
  return Object.freeze({
    channel,
    status,
    reason,
    counts_as_fuel: countsAsFuel,
    flood_axis_status: floodAxisStatus
  });
}
