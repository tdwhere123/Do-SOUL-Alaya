import { canonicalJson, type SoulMemorySearchResponse } from "@do-soul/alaya-protocol";
import { admittedSourceDeliveryTail } from "../../measurement/source-delivery-visibility.js";
import { ORDINARY_RECALL_OBSERVED_SLOT_TARGET, ORDINARY_RECALL_PUBLIC_PAGE_LIMIT,
  type OrdinaryRecallQueryRow } from "./ordinary-entry-contract.js";

type Index = NonNullable<SoulMemorySearchResponse["index"]>;
const REFUSED = new Set(["resource_rejected", "invalidated", "cancelled"]);

/** Capture policy, not a new product completion rule. Core's acknowledged membership
 * token permits another bounded request, including after interrupted/unavailable work.
 * It promises neither progress nor delivery. Never fabricate a cursor or reset a query;
 * unchanged requests, replay admission, call ceiling and the owning deadline still bind.
 */
export function ordinaryEntryStopCause(index: Index, occupied: number, ordinal: number):
  OrdinaryRecallQueryRow["stop_cause"] | null {
  const { schema_version: _version, certificate_id: _certificate, ...dimensions } = index.completeness;
  if (Object.values(dimensions).some(value => REFUSED.has(value))) return "terminal_index";
  const stoppedWork = [index.completeness.logical_index, index.completeness.payload]
    .some(value => value === "interrupted" || value === "unavailable");
  if (stoppedWork && index.continuation == null) return "terminal_index";
  // Retry/payload pages cannot advance a membership observation. A token alone is
  // insufficient without the admitted membership page and its first-exposure binding.
  if (index.continuation != null && index.page_purpose !== "membership") return "terminal_index";
  if (admittedSourceDeliveryTail(index).status === "exhausted") return "occupancy_tail_exhausted";
  if (occupied >= ORDINARY_RECALL_OBSERVED_SLOT_TARGET) return "observed_ten_slot_prefix";
  if (index.continuation == null) return "no_issued_continuation";
  if (ordinal === ORDINARY_RECALL_PUBLIC_PAGE_LIMIT) return "membership_page_bound";
  return null;
}

export type OrdinaryEntryCursorSeen = {
  readonly deliveries: Set<string>;
  readonly continuations: Set<string>;
  readonly positions: Set<string>;
};

/** Fail closed on a repeated request, delivery, issued continuation, or position. Does not mutate `seen` on replay. */
export function admitOrdinaryEntryCursor(
  seen: OrdinaryEntryCursorSeen,
  facts: Readonly<{
    delivery_id: string; request_continuation: unknown; issued_continuation: unknown; positions: readonly string[];
  }>
): string | null {
  if (facts.request_continuation != null && !seen.continuations.has(canonicalJson(facts.request_continuation))) {
    return "ordinary public membership used a continuation that was not issued";
  }
  if (seen.deliveries.has(facts.delivery_id)) return "ordinary public membership repeated a delivery identity";
  if (new Set(facts.positions).size !== facts.positions.length || facts.positions.some(key => seen.positions.has(key))) {
    return "ordinary public membership repeated a delivery position";
  }
  if (facts.issued_continuation != null && seen.continuations.has(canonicalJson(facts.issued_continuation))) {
    return "ordinary public membership repeated an issued continuation";
  }
  seen.deliveries.add(facts.delivery_id);
  for (const key of facts.positions) seen.positions.add(key);
  if (facts.issued_continuation != null) seen.continuations.add(canonicalJson(facts.issued_continuation));
  return null;
}
