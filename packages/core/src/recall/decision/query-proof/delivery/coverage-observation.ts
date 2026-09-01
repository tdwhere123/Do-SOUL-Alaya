import {
  DELIVERY_PACK_MODES,
  type DeliveryPackModeV1,
  type DeliveryPackV1
} from "./contract.js";

export const QUERY_PROOF_DELIVERY_PACK_MODE_HISTOGRAM_OPERATOR_ID =
  "query_proof_delivery_pack_mode_histogram_v1" as const;

export type DeliveryPackModeHistogramV1 = Readonly<{
  readonly schema_version: 1;
  readonly operator_id: typeof QUERY_PROOF_DELIVERY_PACK_MODE_HISTOGRAM_OPERATOR_ID;
  readonly observation_status: "observed";
  readonly coverage_claim: "not_claimed";
  readonly counts: Readonly<Record<DeliveryPackModeV1, number>>;
  readonly total: number;
}>;

export function observeDeliveryPackModeCoverage(
  packs: readonly DeliveryPackV1[]
): DeliveryPackModeHistogramV1 {
  const counts = emptyCounts();
  for (const pack of packs) {
    counts[pack.mode] += 1;
  }
  return Object.freeze({
    schema_version: 1 as const,
    operator_id: QUERY_PROOF_DELIVERY_PACK_MODE_HISTOGRAM_OPERATOR_ID,
    observation_status: "observed" as const,
    coverage_claim: "not_claimed" as const,
    counts: Object.freeze(counts),
    total: packs.length
  });
}

function emptyCounts(): Record<DeliveryPackModeV1, number> {
  return Object.fromEntries(DELIVERY_PACK_MODES.map((mode) => [mode, 0])) as
    Record<DeliveryPackModeV1, number>;
}
