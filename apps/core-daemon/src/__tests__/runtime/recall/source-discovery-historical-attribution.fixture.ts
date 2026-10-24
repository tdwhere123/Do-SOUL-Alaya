import type { SoulMemorySearchRequest } from "@do-soul/alaya-protocol";
import type { ConsumptionStep, ConsumptionTrace, NativeDiscovery } from "./source-discovery-public-consumption.js";

/** Artificial pre-native exchange for the retained published-proposal attribution reader.
 * Only reasons come from the exercised private SQLite observer. Receipt/delivery IDs
 * are authored fixture identities, NOT a public execution, archived run or utility result.
 * Never merge this trace into a live consumption trace or the admitted utility matrix.
 */
export function historicalProposalAttributionFixture(
  request: SoulMemorySearchRequest,
  reasons: NativeDiscovery["lookup_reasons"]
): ConsumptionTrace {
  const step: ConsumptionStep = {
    purpose: "membership", membership_page: 1, payload_expansions: 0,
    cumulative_native_visits: "unavailable", cumulative_native_bytes: "unavailable",
    retained_bytes_current: "unavailable", public_identities: reasons.map((reason) => reason.source_target.root_id),
    source_bodies: {}, preview_complete: {}, logical_index: undefined, payload_completeness: undefined,
    public_exchange: {
      step_index: 0,
      request: { query: request.query, interpretation_proposal: request.interpretation_proposal ?? null,
        continuation: null, payload_continuation: null },
      response: { delivery_id: "authored-historical-delivery", page_purpose: "membership", chunks: [],
        source_lookups: reasons.map((reason) => ({ target: reason.source_target, reasons: [reason] })) },
      receipt: { query_id: "authored-historical-query", interpretation_id: "authored-historical-interpretation",
        snapshot_id: "authored-historical-snapshot", actual: "unavailable" }
    },
    assembly_gap: [], stop_reason: "continuation_exhausted"
  };
  return { first_exposure: null, first_page_identities: step.public_identities,
    first_page_preview_complete: {}, steps: [step], termination: step,
    discarded_capped_incomplete_root_ids: [], cap_remainder: "none", assembly_gap: [], expansions_by_target: {} };
}
