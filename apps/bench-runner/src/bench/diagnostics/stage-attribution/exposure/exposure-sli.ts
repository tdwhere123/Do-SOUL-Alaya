import { CACHED_F3_EXPOSURE_POLICY } from "./contract.js";
import type { TreatmentExposureReceipt } from "./contract.js";
import { isNamedNegativeControl } from "./canary-ids.js";

export interface CachedF3ExposureSli {
  readonly schema_version: 1;
  readonly kind: "cached_f3_exposure_sli";
  readonly denominator_kind: typeof CACHED_F3_EXPOSURE_POLICY.denominator_kind;
  readonly denominator_count: number;
  readonly exposed_count: number;
  readonly rate: number;
  readonly excluded: {
    readonly unavailable_or_ineligible_count: number;
    readonly named_negative_control_count: number;
    readonly leaked_negative_control_exposed_count: number;
  };
}

export function buildCachedF3ExposureSli(
  receipts: readonly TreatmentExposureReceipt[]
): CachedF3ExposureSli {
  let denominator_count = 0;
  let exposed_count = 0;
  let unavailable_or_ineligible_count = 0;
  let named_negative_control_count = 0;
  let leaked_negative_control_exposed_count = 0;
  for (const receipt of receipts) {
    if (isNamedNegativeControl(receipt.question_id)) {
      named_negative_control_count += 1;
      if (receipt.exposure_status === "exposed") leaked_negative_control_exposed_count += 1;
      continue;
    }
    if (receipt.formation.status === "formed") {
      denominator_count += 1;
      if (receipt.exposure_status === "exposed") exposed_count += 1;
      continue;
    }
    unavailable_or_ineligible_count += 1;
  }
  return {
    schema_version: 1,
    kind: "cached_f3_exposure_sli",
    denominator_kind: CACHED_F3_EXPOSURE_POLICY.denominator_kind,
    denominator_count,
    exposed_count,
    rate: denominator_count === 0 ? 0 : exposed_count / denominator_count,
    excluded: {
      unavailable_or_ineligible_count,
      named_negative_control_count,
      leaked_negative_control_exposed_count
    }
  };
}
